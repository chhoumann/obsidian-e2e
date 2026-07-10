import path from "node:path";

import type { CreateObsidianClientOptions } from "../core/types";

const CANONICAL_VAULT = "OBSIDIAN_E2E_VAULT";
const CANONICAL_VAULT_PATH = "OBSIDIAN_E2E_VAULT_PATH";
const CANONICAL_OBSIDIAN_HOME = "OBSIDIAN_E2E_OBSIDIAN_HOME";
const CANONICAL_BIN = "OBSIDIAN_BIN";
const DEFAULT_VAULT = "dev";

export interface ResolveObsidianEnvOptions {
  /** Fallback binary name when `OBSIDIAN_BIN` is unset. */
  bin?: string;
  /** Environment to read from. Defaults to `process.env`; never mutated. */
  env?: NodeJS.ProcessEnv;
  /**
   * Legacy per-plugin env prefix (e.g. `"METAEDIT"`) whose `*_E2E_VAULT`,
   * `*_E2E_VAULT_PATH`, and `*_E2E_OBSIDIAN_HOME` variants are consulted when
   * the canonical `OBSIDIAN_E2E_*` names are absent.
   */
  legacyPrefix?: string;
  /** Fallback vault name when no canonical or legacy vault env is set. */
  vault?: string;
}

export interface ResolvedObsidianEnvOptions extends Partial<CreateObsidianClientOptions> {
  vault: string;
  /**
   * The vault path the CLI is expected to resolve to, from
   * `OBSIDIAN_E2E_VAULT_PATH` (or the legacy alias). Pass to `verifyVaultPath`
   * once the client reports its actual `vaultPath()`.
   */
  expectedVaultPath?: string;
}

/**
 * Resolve canonical `OBSIDIAN_E2E_*` env into spreadable client options.
 *
 * The Obsidian home (`OBSIDIAN_E2E_OBSIDIAN_HOME`) is injected into
 * `defaultExecOptions.env.HOME` per-client so the CLI hits the intended socket
 * without ever mutating `process.env`.
 */
export function resolveObsidianEnvOptions(
  options: ResolveObsidianEnvOptions = {},
): ResolvedObsidianEnvOptions {
  const env = options.env ?? process.env;
  const legacy = (suffix: string): string | undefined =>
    options.legacyPrefix ? env[`${options.legacyPrefix}_${suffix}`] : undefined;

  const vault = env[CANONICAL_VAULT] ?? legacy("E2E_VAULT") ?? options.vault ?? DEFAULT_VAULT;
  const expectedVaultPath = env[CANONICAL_VAULT_PATH] ?? legacy("E2E_VAULT_PATH");
  const obsidianHome = env[CANONICAL_OBSIDIAN_HOME] ?? legacy("E2E_OBSIDIAN_HOME");
  const bin = env[CANONICAL_BIN] ?? options.bin;

  const resolved: ResolvedObsidianEnvOptions = { vault };

  if (bin) {
    resolved.bin = bin;
  }

  if (expectedVaultPath) {
    resolved.expectedVaultPath = expectedVaultPath;
  }

  if (obsidianHome) {
    resolved.defaultExecOptions = {
      env: { ...env, HOME: obsidianHome },
    };
  }

  return resolved;
}

export interface VerifyVaultPathOptions {
  actualVaultPath: string;
  expectedVaultPath?: string;
  vaultName?: string;
}

/**
 * Assert the CLI-resolved vault path matches the expected one, throwing a clear
 * error on mismatch so a misconfigured run never touches the wrong vault.
 * Returns the resolved actual path when it matches (or when no expectation set).
 */
export function verifyVaultPath({
  actualVaultPath,
  expectedVaultPath,
  vaultName,
}: VerifyVaultPathOptions): string {
  const resolvedActual = path.resolve(actualVaultPath);

  if (!expectedVaultPath) {
    return resolvedActual;
  }

  const resolvedExpected = path.resolve(expectedVaultPath);

  if (resolvedActual !== resolvedExpected) {
    throw new Error(
      [
        vaultName
          ? `Obsidian CLI resolved E2E vault "${vaultName}" to ${resolvedActual}.`
          : `Obsidian CLI resolved the E2E vault to ${resolvedActual}.`,
        `Expected ${resolvedExpected}.`,
        "Refusing to run E2E tests against the wrong vault.",
      ].join(" "),
    );
  }

  return resolvedActual;
}
