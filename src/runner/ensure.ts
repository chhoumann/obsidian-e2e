import type { ObsidianExecDependencies } from "./launch";
import {
  isInstanceReady as realIsInstanceReady,
  launchObsidianInstance as realLaunchObsidianInstance,
  reloadPlugin as realReloadPlugin,
  trustVaultAndVerifyPlugin as realTrustVaultAndVerifyPlugin,
  waitForInstanceReady as realWaitForInstanceReady,
} from "./launch";
import {
  prepareObsidianProfile as realPrepareObsidianProfile,
  readInstanceMarker as realReadInstanceMarker,
  stampInstanceMarkerAppVersion as realStampInstanceMarkerAppVersion,
} from "./instance";
import { provisionVault as realProvisionVault } from "./provision";
import type {
  InstanceMarker,
  InstanceOptions,
  ProvisionResult,
  ResolvedRunnerConfig,
} from "./types";
import { assertObsidianMeetsMinAppVersion as realAssertObsidianMeetsMinAppVersion } from "./version-guard";

/**
 * Every function {@link ensureObsidianInstance} orchestrates is injectable so the
 * branch selection (reuse-and-reload vs launch-fresh), the version-mismatch throw,
 * and the marker-read-before-prepare ordering are table-testable with fakes. In
 * production only the version-guard / keychain injection fields are ever set (for
 * hermetic tests of the underlying modules); the orchestration functions default
 * to the real module exports and the `exec` bundle threads the child-process
 * boundary into every launcher call.
 */
export interface EnsureDependencies {
  provisionVault?: typeof realProvisionVault;
  prepareObsidianProfile?: typeof realPrepareObsidianProfile;
  readInstanceMarker?: typeof realReadInstanceMarker;
  assertObsidianMeetsMinAppVersion?: typeof realAssertObsidianMeetsMinAppVersion;
  isInstanceReady?: typeof realIsInstanceReady;
  launchObsidianInstance?: typeof realLaunchObsidianInstance;
  waitForInstanceReady?: typeof realWaitForInstanceReady;
  reloadPlugin?: typeof realReloadPlugin;
  trustVaultAndVerifyPlugin?: typeof realTrustVaultAndVerifyPlugin;
  stampInstanceMarkerAppVersion?: typeof realStampInstanceMarkerAppVersion;
  /** Human progress output; defaults to a no-op so the orchestration stays quiet under test. */
  log?: (message: string) => void;
  /** Child-process / socket / timing boundary threaded into every launcher call. */
  exec?: ObsidianExecDependencies;
  /** Injectable version-guard inputs so tests never scan the real host config dir. */
  obsidianConfigDir?: string;
  bundledAsarCandidates?: string[];
  /** Injectable secure-dir owner uid and host HOME for the profile prep. */
  currentUid?: number | null;
  realHome?: string;
}

export interface EnsureResult {
  provision: ProvisionResult;
  /** Whether Obsidian was actually brought up (false under `--no-launch`). */
  launched: boolean;
  /** True when a warm instance was reused-and-reloaded rather than launched fresh. */
  reused: boolean;
  /** The app-code version the instance runs (guard-resolved, or the prepare-time prediction). */
  appVersion: string | null;
  /** The plugin's `minAppVersion` when the version guard ran, else null. */
  minAppVersion: string | null;
}

/**
 * Bring a worktree-isolated Obsidian instance up to a verified state: provision
 * the vault, prepare the private profile, guard the app version, then either
 * reuse-and-reload a warm instance or launch a fresh one, and finally verify the
 * plugin is live. Mutates `options.userDataPath` once (from the profile prep) so
 * no later caller can forget it. Reads the previous marker BEFORE prepare rewrites
 * it, so the reuse guard can compare the running instance's launch-time app
 * version against the version we just resolved.
 */
export async function ensureObsidianInstance(
  options: InstanceOptions,
  config: ResolvedRunnerConfig,
  deps: EnsureDependencies = {},
): Promise<EnsureResult> {
  const provisionVault = deps.provisionVault ?? realProvisionVault;
  const prepareObsidianProfile = deps.prepareObsidianProfile ?? realPrepareObsidianProfile;
  const readInstanceMarker = deps.readInstanceMarker ?? realReadInstanceMarker;
  const assertObsidianMeetsMinAppVersion =
    deps.assertObsidianMeetsMinAppVersion ?? realAssertObsidianMeetsMinAppVersion;
  const isInstanceReady = deps.isInstanceReady ?? realIsInstanceReady;
  const launchObsidianInstance = deps.launchObsidianInstance ?? realLaunchObsidianInstance;
  const waitForInstanceReady = deps.waitForInstanceReady ?? realWaitForInstanceReady;
  const reloadPlugin = deps.reloadPlugin ?? realReloadPlugin;
  const trustVaultAndVerifyPlugin = deps.trustVaultAndVerifyPlugin ?? realTrustVaultAndVerifyPlugin;
  const stampInstanceMarkerAppVersion =
    deps.stampInstanceMarkerAppVersion ?? realStampInstanceMarkerAppVersion;
  const log = deps.log ?? (() => {});
  const exec = deps.exec;

  // Read the marker BEFORE prepare rewrites it: prepare preserves the recorded
  // launch-time appVersion, but reading it up front keeps the reuse guard's
  // comparison independent of the prepare step's write.
  const previousMarker: InstanceMarker | null = await readInstanceMarker(options.instancePath);

  const provision = await provisionVault(options, config);

  const profile = await prepareObsidianProfile({
    ...options,
    obsidianConfigDir: deps.obsidianConfigDir,
    bundledAsarCandidates: deps.bundledAsarCandidates,
    ...("currentUid" in deps ? { currentUid: deps.currentUid } : {}),
    ...("realHome" in deps ? { realHome: deps.realHome } : {}),
  });
  // Set once here so no downstream caller (spawn, print-env) can read a stale path.
  options.userDataPath = profile.userDataPath;

  if (!options.launch) {
    return {
      provision,
      launched: false,
      reused: false,
      appVersion: profile.appVersion,
      minAppVersion: null,
    };
  }

  // The stamp after a fresh launch must record the SAME version the guard
  // resolved, so the reuse guard on the next run compares like against like. When
  // the guard is skipped there is no resolved version, so fall back to the
  // prepare-time prediction purely for the stamp.
  let resolvedAppVersion = profile.appVersion;
  let minAppVersion: string | null = null;
  if (!options.skipVersionGuard) {
    const guard = await assertObsidianMeetsMinAppVersion({
      worktreePath: options.worktreePath,
      obsidianApp: options.obsidianApp,
      obsidianConfigDir: deps.obsidianConfigDir,
      bundledAsarCandidates: deps.bundledAsarCandidates,
    });
    resolvedAppVersion = guard.appVersion;
    minAppVersion = guard.minAppVersion;
    log(
      `Obsidian app version ${guard.appVersion}` +
        `${guard.installerVersion ? ` (installer shell ${guard.installerVersion})` : ""}` +
        ` satisfies the plugin's minAppVersion ${guard.minAppVersion}.`,
    );
  }

  const readyTarget = {
    obsidianBin: options.obsidianBin,
    obsidianHome: options.obsidianHome,
    vaultName: options.vaultName,
    vaultPath: options.vaultPath,
  };

  let reused = false;
  if (await isInstanceReady(readyTarget, exec)) {
    // A warm instance is only safe to reuse when it runs the app version we just
    // resolved; a mid-session Obsidian update means the running renderer no longer
    // matches, so fail closed and make the operator restart it.
    if (!options.skipVersionGuard) {
      const recorded = previousMarker?.appVersion ?? null;
      if (recorded && recorded !== resolvedAppVersion) {
        throw new Error(
          `Refusing to reuse the warm Obsidian instance for ${options.vaultName}: it was launched ` +
            `against app version ${recorded}, but the resolved app version is now ${resolvedAppVersion}. ` +
            `Obsidian updated mid-session. Stop the stale instance and let the next run relaunch it: ` +
            `npm run stop:e2e-obsidian`,
        );
      }
      if (!recorded) {
        log(
          `Reusing a warm Obsidian instance with no recorded app version; a mid-session Obsidian ` +
            `update cannot be detected for this instance until it is relaunched.`,
        );
      }
    }
    // Reload BEFORE verify so a rebuilt main.js of the same app version takes
    // effect instead of the bundle the warm instance loaded earlier.
    await reloadPlugin(readyTarget, config.pluginId, exec);
    reused = true;
  } else {
    const launchTarget = {
      obsidianApp: options.obsidianApp,
      obsidianHome: options.obsidianHome,
      userDataPath: options.userDataPath,
      profileRoot: options.profileRoot,
      instancePath: options.instancePath,
    };
    await launchObsidianInstance(launchTarget, exec);
    await waitForInstanceReady(readyTarget, exec);
    await stampInstanceMarkerAppVersion(options.instancePath, resolvedAppVersion);
  }

  await trustVaultAndVerifyPlugin(readyTarget, config.readyProbe, exec);

  return {
    provision,
    launched: true,
    reused,
    appVersion: resolvedAppVersion,
    minAppVersion,
  };
}
