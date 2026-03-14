import type { ExecOptions } from "./types";

export function mergeExecOptions(
  defaults: ExecOptions | undefined,
  overrides: ExecOptions | undefined,
): ExecOptions {
  if (!defaults) {
    return overrides ? { ...overrides } : {};
  }

  if (!overrides) {
    return { ...defaults };
  }

  return {
    ...defaults,
    ...overrides,
    env: mergeEnvironments(defaults.env, overrides.env),
  };
}

function mergeEnvironments(
  defaults: NodeJS.ProcessEnv | undefined,
  overrides: NodeJS.ProcessEnv | undefined,
): NodeJS.ProcessEnv | undefined {
  if (!defaults) {
    return overrides ? { ...overrides } : undefined;
  }

  if (!overrides) {
    return { ...defaults };
  }

  return {
    ...defaults,
    ...overrides,
  };
}
