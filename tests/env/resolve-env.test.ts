import { describe, expect, it } from "vite-plus/test";

import {
  privateHomeEnv,
  resolveObsidianEnvOptions,
  verifyVaultPath,
} from "../../src/env/resolve-env";
import { linuxCliSocket, waylandSocket } from "../helpers/cli-socket";

describe("resolveObsidianEnvOptions", () => {
  it("maps the canonical OBSIDIAN_E2E_* names", () => {
    const env = {
      OBSIDIAN_BIN: "obsidian-beta",
      OBSIDIAN_E2E_OBSIDIAN_HOME: "/home/e2e",
      OBSIDIAN_E2E_VAULT: "e2e",
      OBSIDIAN_E2E_VAULT_PATH: "/vaults/e2e",
      UNRELATED: "keep",
    } as NodeJS.ProcessEnv;

    const resolved = resolveObsidianEnvOptions({ env });

    expect(resolved.vault).toBe("e2e");
    expect(resolved.bin).toBe("obsidian-beta");
    expect(resolved.expectedVaultPath).toBe("/vaults/e2e");
    expect(resolved.defaultExecOptions?.env?.HOME).toBe("/home/e2e");
    // Non-HOME env is carried through so the child still inherits PATH etc.
    expect(resolved.defaultExecOptions?.env?.UNRELATED).toBe("keep");
  });

  it("falls back to the legacy prefix when canonical names are absent", () => {
    const env = {
      METAEDIT_E2E_OBSIDIAN_HOME: "/home/legacy",
      METAEDIT_E2E_VAULT: "legacy",
      METAEDIT_E2E_VAULT_PATH: "/vaults/legacy",
    } as NodeJS.ProcessEnv;

    const resolved = resolveObsidianEnvOptions({ env, legacyPrefix: "METAEDIT" });

    expect(resolved.vault).toBe("legacy");
    expect(resolved.expectedVaultPath).toBe("/vaults/legacy");
    expect(resolved.defaultExecOptions?.env?.HOME).toBe("/home/legacy");
  });

  it("prefers canonical names over the legacy prefix", () => {
    const env = {
      METAEDIT_E2E_VAULT: "legacy",
      OBSIDIAN_E2E_VAULT: "canonical",
    } as NodeJS.ProcessEnv;

    expect(resolveObsidianEnvOptions({ env, legacyPrefix: "METAEDIT" }).vault).toBe("canonical");
  });

  it("injects HOME without mutating the source env", () => {
    const env = {
      OBSIDIAN_E2E_OBSIDIAN_HOME: "/home/e2e",
      HOME: "/home/original",
    } as NodeJS.ProcessEnv;

    const resolved = resolveObsidianEnvOptions({ env });

    expect(resolved.defaultExecOptions?.env?.HOME).toBe("/home/e2e");
    expect(env.HOME).toBe("/home/original");
    expect(resolved.defaultExecOptions?.env).not.toBe(env);
  });

  it("on Linux points the CLI at the private socket even with XDG_RUNTIME_DIR set", () => {
    const resolved = resolveObsidianEnvOptions({
      env: { OBSIDIAN_E2E_OBSIDIAN_HOME: "/home/e2e", XDG_RUNTIME_DIR: "/run/user/1000" },
      platform: "linux",
    });

    expect(linuxCliSocket(resolved.defaultExecOptions?.env)).toBe("/home/e2e/.obsidian-cli.sock");
  });

  it("passes through with defaults when no env is set", () => {
    const resolved = resolveObsidianEnvOptions({ env: {} as NodeJS.ProcessEnv });

    expect(resolved.vault).toBe("dev");
    expect(resolved.bin).toBeUndefined();
    expect(resolved.expectedVaultPath).toBeUndefined();
    expect(resolved.defaultExecOptions).toBeUndefined();
  });

  it("honors the fallback vault and bin", () => {
    const resolved = resolveObsidianEnvOptions({
      bin: "custom",
      env: {} as NodeJS.ProcessEnv,
      vault: "scratch",
    });

    expect(resolved.vault).toBe("scratch");
    expect(resolved.bin).toBe("custom");
  });
});

describe("privateHomeEnv", () => {
  it("on Linux keeps Wayland clients on the session compositor while the CLI socket moves", () => {
    const cases = [
      [{ WAYLAND_DISPLAY: "wayland-1" }, "/run/user/1000/wayland-1"],
      [{ XDG_SESSION_TYPE: "wayland" }, "/run/user/1000/wayland-0"],
      [{ WAYLAND_DISPLAY: "/run/compositor/wl" }, "/run/compositor/wl"],
    ] as const;
    for (const [session, compositor] of cases) {
      const env = { ...session, XDG_RUNTIME_DIR: "/run/user/1000" };
      const inherited = { ...env };

      const scoped = privateHomeEnv("/home/e2e", env, "linux");

      expect(waylandSocket(scoped)).toBe(compositor);
      expect(linuxCliSocket(scoped)).toBe("/home/e2e/.obsidian-cli.sock");
      expect(env).toEqual(inherited);
    }
  });

  it("does not make X11 or headless Linux clients look like Wayland ones", () => {
    const envs = [
      { XDG_RUNTIME_DIR: "/run/user/1000" },
      { DISPLAY: ":0", XDG_SESSION_TYPE: "x11", XDG_RUNTIME_DIR: "/run/user/1000" },
    ];
    for (const env of envs) {
      expect(privateHomeEnv("/home/e2e", env, "linux").WAYLAND_DISPLAY).toBeUndefined();
    }
  });
});

describe("verifyVaultPath", () => {
  it("returns the resolved path when it matches the expectation", () => {
    expect(
      verifyVaultPath({ actualVaultPath: "/vaults/e2e", expectedVaultPath: "/vaults/e2e" }),
    ).toBe("/vaults/e2e");
  });

  it("returns the resolved path when no expectation is set", () => {
    expect(verifyVaultPath({ actualVaultPath: "/vaults/e2e" })).toBe("/vaults/e2e");
  });

  it("throws a clear error on mismatch", () => {
    expect(() =>
      verifyVaultPath({
        actualVaultPath: "/vaults/wrong",
        expectedVaultPath: "/vaults/e2e",
        vaultName: "e2e",
      }),
    ).toThrow(/resolved E2E vault "e2e" to \/vaults\/wrong.*Expected \/vaults\/e2e/su);
  });
});
