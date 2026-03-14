import { expect } from "vite-plus/test";

import type { SandboxApi, VaultApi } from "./core/types";

type MatcherTarget = SandboxApi | VaultApi;

expect.extend({
  async toHaveFile(target: MatcherTarget, targetPath: string) {
    const pass = await target.exists(targetPath);

    return {
      message: () =>
        pass
          ? `Expected vault path not to exist: ${targetPath}`
          : `Expected vault path to exist: ${targetPath}`,
      pass,
    };
  },
  async toHaveFileContaining(target: MatcherTarget, targetPath: string, needle: string) {
    const exists = await target.exists(targetPath);

    if (!exists) {
      return {
        message: () => `Expected vault path to exist: ${targetPath}`,
        pass: false,
      };
    }

    const content = await target.read(targetPath);
    const pass = content.includes(needle);

    return {
      message: () =>
        pass
          ? `Expected vault path "${targetPath}" not to contain "${needle}"`
          : `Expected vault path "${targetPath}" to contain "${needle}"`,
      pass,
    };
  },
  async toHaveJsonFile(target: MatcherTarget, targetPath: string) {
    const exists = await target.exists(targetPath);

    if (!exists) {
      return {
        message: () => `Expected JSON file to exist: ${targetPath}`,
        pass: false,
      };
    }

    try {
      await target.json(targetPath).read();
      return {
        message: () => `Expected JSON file "${targetPath}" not to be valid JSON`,
        pass: true,
      };
    } catch (error) {
      return {
        message: () =>
          `Expected JSON file "${targetPath}" to be valid JSON, but parsing failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        pass: false,
      };
    }
  },
});

declare module "vite-plus/test" {
  interface Assertion<T = any> {
    toHaveFile(path: string): Promise<T>;
    toHaveFileContaining(path: string, needle: string): Promise<T>;
    toHaveJsonFile(path: string): Promise<T>;
  }

  interface AsymmetricMatchersContaining {
    toHaveFile(path: string): void;
    toHaveFileContaining(path: string, needle: string): void;
    toHaveJsonFile(path: string): void;
  }
}

export {};
