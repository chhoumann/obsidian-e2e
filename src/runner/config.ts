import path from "node:path";
import { pathToFileURL } from "node:url";

import { isRecord } from "../core/errors";
import { pathExists } from "./fs-utils";
import type { ReadyProbe, ResolvedRunnerConfig } from "./types";

export const CONFIG_FILE_NAME = "obsidian-e2e.config.mjs";

const PLUGIN_ID_PATTERN = /^[a-z0-9-]+$/;

/**
 * Load and resolve the runner config for a worktree. Dynamically imports
 * `obsidian-e2e.config.mjs` from the worktree root (or `explicitConfigPath` when
 * given), accepting either a default export or a named `config` export, then
 * validates `pluginId` and applies every default.
 */
export async function loadRunnerConfig(
  worktreePath: string,
  explicitConfigPath?: string,
): Promise<ResolvedRunnerConfig> {
  const configPath = explicitConfigPath
    ? path.resolve(explicitConfigPath)
    : path.join(path.resolve(worktreePath), CONFIG_FILE_NAME);

  if (!(await pathExists(configPath))) {
    throw new Error(
      `Cannot find Obsidian E2E runner config at ${configPath}. ` +
        `Create an ${CONFIG_FILE_NAME} at the worktree root exporting a config object with a "pluginId".`,
    );
  }

  const imported = (await import(pathToFileURL(configPath).href)) as Record<string, unknown>;
  const raw = imported.default ?? imported.config;
  if (!isRecord(raw)) {
    throw new Error(
      `${configPath} must export a config object (a default export or a named "config" export).`,
    );
  }

  return resolveRunnerConfig(raw, configPath);
}

/** Validate a raw config object and apply defaults. Exported for direct testing. */
export function resolveRunnerConfig(
  raw: Record<string, unknown>,
  source = "config",
): ResolvedRunnerConfig {
  const pluginId = raw.pluginId;
  if (typeof pluginId !== "string" || pluginId.length === 0) {
    throw new Error(`${source} is missing required "pluginId" (a non-empty string).`);
  }
  if (!PLUGIN_ID_PATTERN.test(pluginId)) {
    throw new Error(
      `${source} has invalid pluginId "${pluginId}": use only lowercase letters, digits, and hyphens.`,
    );
  }

  return {
    pluginId,
    vaultPrefix: optionalString(raw.vaultPrefix, "vaultPrefix", source) ?? pluginId,
    pluginArtifacts: optionalStringArray(raw.pluginArtifacts, "pluginArtifacts", source) ?? [
      "manifest.json",
      "main.js",
    ],
    defaultData: "defaultData" in raw ? raw.defaultData : {},
    buildCommand: optionalString(raw.buildCommand, "buildCommand", source) ?? "npm run build",
    defaultCommand: optionalStringArray(raw.defaultCommand, "defaultCommand", source) ?? [
      "eval",
      "code=app.vault.getName()",
    ],
    readyProbe: resolveReadyProbe(raw.readyProbe, pluginId, source),
    envPrefix: optionalString(raw.envPrefix, "envPrefix", source),
    profileRoot:
      optionalString(raw.profileRoot, "profileRoot", source) ?? `/tmp/${pluginId}-obsidian-e2e`,
    appName: optionalString(raw.appName, "appName", source) ?? "Obsidian",
    obsidianBin: optionalString(raw.obsidianBin, "obsidianBin", source) ?? "obsidian",
  };
}

function resolveReadyProbe(value: unknown, pluginId: string, source: string): ReadyProbe {
  if (value === undefined) {
    // The code intentionally does not embed the literal "=> true" so an echoed
    // command can never be mistaken for a positive probe result.
    return {
      kind: "eval",
      code: `Boolean(app.plugins.plugins[${JSON.stringify(pluginId)}])`,
      match: "=> true",
    };
  }
  if (!isRecord(value)) {
    throw new Error(`${source} has invalid "readyProbe": expected an object.`);
  }
  if (value.kind === "eval") {
    return {
      kind: "eval",
      code: requireString(value.code, "readyProbe.code", source),
      match: requireString(value.match, "readyProbe.match", source),
    };
  }
  if (value.kind === "command") {
    return {
      kind: "command",
      args: requireStringArray(value.args, "readyProbe.args", source),
      match: requireString(value.match, "readyProbe.match", source),
    };
  }
  throw new Error(`${source} has invalid "readyProbe.kind": expected "eval" or "command".`);
}

function optionalString(value: unknown, field: string, source: string): string | undefined {
  if (value === undefined) return undefined;
  return requireString(value, field, source);
}

function requireString(value: unknown, field: string, source: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${source} has invalid "${field}": expected a non-empty string.`);
  }
  return value;
}

function optionalStringArray(value: unknown, field: string, source: string): string[] | undefined {
  if (value === undefined) return undefined;
  return requireStringArray(value, field, source);
}

function requireStringArray(value: unknown, field: string, source: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`${source} has invalid "${field}": expected an array of strings.`);
  }
  return value as string[];
}
