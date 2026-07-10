import { promises as fs } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { createPluginHarnessSession } from "../../src/fixtures/plugin-harness";
import type { CreatePluginHarnessOptions } from "../../src/fixtures/plugin-harness";
import { createExecResult } from "../helpers/create-exec-result";
import { cleanupTempDirectories, createTempDir } from "../helpers/create-temp-dir";
import type { CommandTransport } from "../../src/core/types";

const PLUGIN_ID = "harness-plugin";
const READY_COMMAND = "harness-plugin:ready";

const tempDirectories: string[] = [];

afterEach(async () => {
  await cleanupTempDirectories(tempDirectories);
});

interface HarnessFixture {
  dataPath: string;
  events: string[];
  lockRoot: string;
  setEnabled(value: boolean): void;
  setThrowOnDisable(value: boolean): void;
  transport: CommandTransport;
  vaultRoot: string;
}

async function createHarnessFixture(): Promise<HarnessFixture> {
  const vaultRoot = await createTempDir(tempDirectories, "obsidian-e2e-harness-vault-");
  const lockRoot = await createTempDir(tempDirectories, "obsidian-e2e-harness-locks-");
  const dataPath = path.join(vaultRoot, ".obsidian", "plugins", PLUGIN_ID, "data.json");

  await fs.mkdir(path.dirname(dataPath), { recursive: true });
  await fs.writeFile(dataPath, `${JSON.stringify({ seed: true }, null, 2)}\n`, "utf8");

  const events: string[] = [];
  let enabled = true;
  let throwOnDisable = false;

  const transport: CommandTransport = async (request) => {
    if (request.argv[0] === "--help") {
      events.push("verify");
      return createExecResult(request.bin, request.argv, "usage\n");
    }

    const [, command, ...rest] = request.argv;
    const args = Object.fromEntries(
      rest
        .filter((entry) => entry.includes("="))
        .map((entry) => {
          const [key, ...value] = entry.split("=");
          return [key, value.join("=")];
        }),
    );

    if (command === "vault" && args.info === "path") {
      return createExecResult(request.bin, request.argv, `${vaultRoot}\n`);
    }

    if (command === "commands") {
      events.push("commands");
      return createExecResult(request.bin, request.argv, `${READY_COMMAND}\n`);
    }

    if (command === "plugin") {
      return createExecResult(request.bin, request.argv, `enabled\t${enabled}\n`);
    }

    if (command === "plugin:enable") {
      enabled = true;
      events.push("plugin:enable");
      return createExecResult(request.bin, request.argv, "");
    }

    if (command === "plugin:disable") {
      if (throwOnDisable) {
        throw new Error("plugin:disable failed");
      }

      enabled = false;
      events.push("plugin:disable");
      return createExecResult(request.bin, request.argv, "");
    }

    if (command === "plugin:reload") {
      events.push("plugin:reload");
      return createExecResult(request.bin, request.argv, "");
    }

    if (command === "eval") {
      const code = args.code ?? "";

      if (code.includes("delete window.__obsidianE2ELock")) {
        events.push("eval:clearMarker");
        return createExecResult(request.bin, request.argv, "cleared\n");
      }

      if (code.includes("__obsidianE2ELock")) {
        events.push("eval:marker");
        return createExecResult(request.bin, request.argv, "{}\n");
      }

      if (code.includes("__obsidianE2EPlugins")) {
        events.push("eval:loaded");
        return createExecResult(
          request.bin,
          request.argv,
          `${JSON.stringify({ ok: true, value: true })}\n`,
        );
      }

      events.push("eval:evalJson");
      return createExecResult(
        request.bin,
        request.argv,
        `${JSON.stringify({ ok: true, value: true })}\n`,
      );
    }

    throw new Error(`Unhandled transport request: ${request.argv.join(" ")}`);
  };

  return {
    dataPath,
    events,
    lockRoot,
    setEnabled(value: boolean) {
      enabled = value;
    },
    setThrowOnDisable(value: boolean) {
      throwOnDisable = value;
    },
    transport,
    vaultRoot,
  };
}

function baseOptions(fixture: HarnessFixture): CreatePluginHarnessOptions {
  return {
    captureOnFailure: false,
    pluginId: PLUGIN_ID,
    reload: { intervalMs: 10, readyCommandId: READY_COMMAND, timeoutMs: 5_000 },
    sharedVaultLock: { lockRoot: fixture.lockRoot, onBusy: "fail", timeoutMs: 5_000 },
    transport: fixture.transport,
    vault: "dev",
  };
}

function drain(events: string[]): string[] {
  const snapshot = [...events];
  events.length = 0;
  return snapshot;
}

describe("createPluginHarnessSession", () => {
  it("drives the suite lifecycle in order and restores data before teardown", async () => {
    const fixture = await createHarnessFixture();
    let contentAtRestoreHook: string | undefined;

    const session = createPluginHarnessSession(
      {
        ...baseOptions(fixture),
        async beforeDataRestore() {
          fixture.events.push("beforeDataRestore");
          contentAtRestoreHook = await fs.readFile(fixture.dataPath, "utf8");
        },
        async waitUntilReady() {
          fixture.events.push("predicate");
          return true;
        },
      },
      "lifecycle",
    );

    await session.setup();
    const setupEvents = drain(fixture.events);

    // Lock marker publishes before the plugin reload, which readies before the predicate.
    expect(setupEvents.indexOf("eval:marker")).toBeLessThan(setupEvents.indexOf("plugin:reload"));
    expect(setupEvents.indexOf("plugin:reload")).toBeLessThan(setupEvents.indexOf("eval:loaded"));
    expect(setupEvents.indexOf("eval:loaded")).toBeLessThan(setupEvents.indexOf("predicate"));

    await session.resetDiagnostics();
    expect(drain(fixture.events)).toEqual(["eval:evalJson"]);

    const context = session.getContext();
    expect(context.plugin.id).toBe(PLUGIN_ID);
    await context.plugin.data().write({ changed: true });
    drain(fixture.events);

    await session.restoreData();
    const restoreEvents = drain(fixture.events);
    const contentAfterRestore = await fs.readFile(fixture.dataPath, "utf8");

    // beforeDataRestore runs while the test's data is still on disk, before the restore.
    expect(contentAtRestoreHook).toContain('"changed"');
    expect(contentAfterRestore).toContain('"seed"');
    expect(contentAfterRestore).not.toContain('"changed"');
    expect(restoreEvents.indexOf("beforeDataRestore")).toBeLessThan(
      restoreEvents.indexOf("plugin:disable"),
    );
    expect(restoreEvents).toContain("plugin:enable");
    expect(restoreEvents).toContain("predicate");

    await session.teardown();
    const teardownEvents = drain(fixture.events);

    expect(teardownEvents).toContain("eval:clearMarker");
    // The vault lock directory is released.
    await expect(fs.readdir(fixture.lockRoot)).resolves.toHaveLength(0);
    expect(() => session.getContext()).toThrow(/not initialized/u);
  });

  it("aggregates multiple teardown errors and still releases the lock", async () => {
    const fixture = await createHarnessFixture();
    fixture.setEnabled(false);
    fixture.setThrowOnDisable(true);

    const session = createPluginHarnessSession(
      {
        ...baseOptions(fixture),
        beforeDataRestore() {
          throw new Error("beforeDataRestore failed");
        },
        async waitUntilReady() {
          return true;
        },
      },
      "teardown",
    );

    await session.setup();

    const error = await session.teardown().then(
      () => undefined,
      (thrown: unknown) => thrown,
    );

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toHaveLength(2);
    await expect(fs.readdir(fixture.lockRoot)).resolves.toHaveLength(0);
  });

  it("runs the symlink preflight after the lock and releases it on failure", async () => {
    const fixture = await createHarnessFixture();

    const session = createPluginHarnessSession(
      {
        ...baseOptions(fixture),
        symlinkArtifacts: ["main.js"],
        symlinkRepoRoot: fixture.vaultRoot,
      },
      "preflight",
    );

    const error = await session.setup().then(
      () => undefined,
      (thrown: unknown) => thrown,
    );

    expect((error as Error).message).toContain("preflight failed");
    // The lock was acquired (marker published) before the preflight ran, and released on failure.
    expect(fixture.events).toContain("eval:marker");
    expect(fixture.events).not.toContain("plugin:reload");
    await expect(fs.readdir(fixture.lockRoot)).resolves.toHaveLength(0);
  });
});
