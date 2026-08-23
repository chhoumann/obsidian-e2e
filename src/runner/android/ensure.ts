import path from "node:path";

import { pathExists } from "../fs-utils";
import { assertRequiredPluginFiles } from "../provision";
import type { ResolvedAndroidConfig, ResolvedRunnerConfig } from "../types";
import {
  type AdbDependencies,
  type AdbTarget,
  OBSIDIAN_PACKAGE,
  adb,
  adbShell,
  appUid,
  ensureAdbRoot,
  ensureEmulator,
  findEmulatorSerial,
  forwardCdp,
  installApk,
  isAppInstalled,
  startApp,
  stopEmulator,
} from "./adb";
import { CdpClient, type CdpDependencies } from "./cdp";

/**
 * App-storage vaults are plain folders under the app's external files dir; the
 * vault the app opens is whatever webview-localStorage `mobile-selected-vault`
 * names. Writing the folder plus that key (via CDP) and reloading is the whole
 * provisioning story - no first-run UI driving, no vault registry beyond this.
 * Verified against Obsidian mobile 1.13.8.
 */
export const DEVICE_VAULT_ROOT = `/storage/emulated/0/Android/data/${OBSIDIAN_PACKAGE}/files`;

const SELECTED_VAULT_KEY = "mobile-selected-vault";
const VAULT_OPEN_TIMEOUT_MS = 60_000;
const VAULT_OPEN_POLL_MS = 1_000;

export interface AndroidOptions {
  vaultName: string;
  worktreePath: string;
  dataPath: string | undefined;
  json: boolean;
  printEnv: boolean;
}

export interface AndroidEnsureResult {
  serial: string;
  cdpPort: number;
  vaultName: string;
  vaultPath: string;
  /** True when a running emulator was reused rather than launched. */
  reusedEmulator: boolean;
}

/**
 * Everything {@link ensureAndroidInstance} touches outside plain computation,
 * injectable so the orchestration is table-testable: the adb/emulator process
 * boundary, the CDP network boundary, and human progress output.
 */
export interface AndroidEnsureDependencies {
  adb: AdbDependencies;
  cdp?: CdpDependencies;
  log?: (message: string) => void;
  /** Injectable for tests; production checks the worktree artifacts on disk. */
  assertArtifacts?: typeof assertRequiredPluginFiles;
  dataSeedExists?: (filePath: string) => Promise<boolean>;
}

/** Evaluate on a fresh CDP connection, throwing on an in-page exception. */
async function evaluate(
  cdpPort: number,
  expression: string,
  deps: CdpDependencies,
): Promise<unknown> {
  const client = await CdpClient.connect(cdpPort, deps);
  try {
    const result = await client.evaluate(expression);
    if (result.exception) {
      throw new Error(`CDP evaluation failed: ${result.exception}`);
    }
    return result.value;
  } finally {
    client.close();
  }
}

async function currentVaultName(cdpPort: number, deps: CdpDependencies): Promise<string | null> {
  const value = await evaluate(
    cdpPort,
    "typeof app !== 'undefined' && app.workspace?.layoutReady ? app.vault.getName() : null",
    deps,
  ).catch(() => null);
  return typeof value === "string" ? value : null;
}

async function waitForVaultOpen(
  cdpPort: number,
  vaultName: string,
  cdp: CdpDependencies,
  adbDeps: AdbDependencies,
): Promise<void> {
  const now = adbDeps.now ?? (() => Date.now());
  const sleep = adbDeps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = now() + VAULT_OPEN_TIMEOUT_MS;
  while (now() < deadline) {
    if ((await currentVaultName(cdpPort, cdp)) === vaultName) return;
    await sleep(VAULT_OPEN_POLL_MS);
  }
  throw new Error(
    `Obsidian did not open the vault "${vaultName}" within ${VAULT_OPEN_TIMEOUT_MS}ms.`,
  );
}

/**
 * Push the plugin artifacts and (first time only) the data.json seed into the
 * device vault, mirroring the desktop provision semantics: artifacts always
 * track the current build, the seed is laid down once. Ownership is normalized
 * afterwards because a root push through the external-storage FUSE mount can
 * leave entries the app cannot list.
 */
async function provisionDeviceVault(
  target: AdbTarget,
  options: AndroidOptions,
  config: ResolvedRunnerConfig,
  vaultPath: string,
  deps: AndroidEnsureDependencies,
): Promise<void> {
  const assertArtifacts = deps.assertArtifacts ?? assertRequiredPluginFiles;
  const dataSeedExists = deps.dataSeedExists ?? pathExists;
  await assertArtifacts(options.worktreePath, config);

  const pluginPath = `${vaultPath}/.obsidian/plugins/${config.pluginId}`;
  await adbShell(target, `mkdir -p '${pluginPath}'`, deps.adb);

  for (const fileName of config.pluginArtifacts) {
    await adb(
      target,
      ["push", path.join(options.worktreePath, fileName), `${pluginPath}/${fileName}`],
      deps.adb,
      120_000,
    );
  }

  const dataOnDevice = await adbShell(
    target,
    `test -f '${pluginPath}/data.json' && echo yes || echo no`,
    deps.adb,
  );
  if (dataOnDevice !== "yes") {
    if (options.dataPath && (await dataSeedExists(options.dataPath))) {
      await adb(target, ["push", options.dataPath, `${pluginPath}/data.json`], deps.adb, 60_000);
    } else {
      const json = JSON.stringify(config.defaultData ?? {});
      await adbShell(
        target,
        `printf '%s' '${json.replaceAll("'", "'\\''")}' > '${pluginPath}/data.json'`,
        deps.adb,
      );
    }
  }

  const uid = await appUid(target, deps.adb);
  await adbShell(target, `chown -R ${uid}:ext_data_rw '${vaultPath}'`, deps.adb);
}

/**
 * Bring the Android instance up to a verified state: boot (or reuse) the AVD,
 * install the app if needed, start it, select/provision the vault, push the
 * plugin, enable it, and run the ready probe over CDP. Mirrors the desktop
 * `ensureObsidianInstance` contract at device scale.
 */
export async function ensureAndroidInstance(
  options: AndroidOptions,
  config: ResolvedRunnerConfig,
  android: ResolvedAndroidConfig,
  deps: AndroidEnsureDependencies,
): Promise<AndroidEnsureResult> {
  const log = deps.log ?? (() => {});
  const cdp = deps.cdp ?? {};
  const logDir = path.join(config.profileRoot, "android");
  const vaultPath = `${DEVICE_VAULT_ROOT}/${options.vaultName}`;

  const runningBefore = await findEmulatorSerial(android, deps.adb);
  const serial = await ensureEmulator(android, logDir, deps.adb, log);
  const target: AdbTarget = { adbBin: android.adbBin, serial };

  if (!(await isAppInstalled(target, deps.adb))) {
    if (!android.apk) {
      throw new Error(
        `Obsidian is not installed on AVD "${android.avd}" and no android.apk is configured. ` +
          `Download the official APK from the obsidianmd/obsidian-releases GitHub releases ` +
          `and set android.apk in ${"obsidian-e2e.config.mjs"}.`,
      );
    }
    log(`Installing Obsidian APK on ${serial}.`);
    await installApk(target, android.apk, deps.adb);
  }

  // Root BEFORE the port forward: restarting adbd as root drops all forwards.
  await ensureAdbRoot(target, deps.adb);

  const pid = await startApp(target, deps.adb);
  await forwardCdp(target, pid, android.cdpPort, deps.adb);

  if ((await currentVaultName(android.cdpPort, cdp)) !== options.vaultName) {
    log(`Selecting vault "${options.vaultName}" on ${serial}.`);
    const uid = await appUid(target, deps.adb);
    await adbShell(target, `mkdir -p '${vaultPath}/.obsidian'`, deps.adb);
    await adbShell(target, `chown -R ${uid}:ext_data_rw '${vaultPath}'`, deps.adb);
    await evaluate(
      android.cdpPort,
      `localStorage.setItem(${JSON.stringify(SELECTED_VAULT_KEY)}, ${JSON.stringify(options.vaultName)}); location.reload(); true`,
      cdp,
    );
    await waitForVaultOpen(android.cdpPort, options.vaultName, cdp, deps.adb);
  }

  await provisionDeviceVault(target, options, config, vaultPath, deps);

  // Enable-or-reload: a fresh vault needs Restricted Mode off and the plugin
  // enabled; a warm one must reload so the artifacts just pushed take effect.
  await evaluate(
    android.cdpPort,
    `(async () => {
      const id = ${JSON.stringify(config.pluginId)};
      await app.plugins.setEnable(true);
      await app.plugins.loadManifests();
      if (app.plugins.plugins[id]) {
        await app.plugins.disablePlugin(id);
        await app.plugins.enablePlugin(id);
      } else {
        await app.plugins.enablePluginAndSave(id);
      }
      return true;
    })()`,
    cdp,
  );

  // The command-kind probe needs the desktop CLI socket, which does not exist
  // on Android; fall back to the default plugin-loaded check there.
  const probe =
    config.readyProbe.kind === "eval"
      ? config.readyProbe
      : {
          kind: "eval" as const,
          code: `Boolean(app.plugins.plugins[${JSON.stringify(config.pluginId)}])`,
          match: "=> true",
        };
  if (config.readyProbe.kind !== "eval") {
    log(
      `The configured command-kind readyProbe cannot run on Android; using the plugin-loaded check.`,
    );
  }
  const value = await evaluate(android.cdpPort, probe.code, cdp);
  const rendered = `=> ${typeof value === "string" ? value : JSON.stringify(value)}`;
  if (!rendered.includes(probe.match)) {
    throw new Error(
      `Ready probe failed on ${serial}: expected output containing "${probe.match}", got "${rendered}".`,
    );
  }

  return {
    serial,
    cdpPort: android.cdpPort,
    vaultName: options.vaultName,
    vaultPath,
    reusedEmulator: runningBefore !== null,
  };
}

/** Stop the app and shut the AVD's emulator down; a no-op when nothing runs. */
export async function stopAndroidInstance(
  android: ResolvedAndroidConfig,
  deps: AndroidEnsureDependencies,
): Promise<{ stopped: boolean; serial: string | null }> {
  const serial = await findEmulatorSerial(android, deps.adb);
  if (!serial) return { stopped: false, serial: null };
  await stopEmulator({ adbBin: android.adbBin, serial }, deps.adb);
  return { stopped: true, serial };
}
