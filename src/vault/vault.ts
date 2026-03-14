import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type {
  DeleteOptions,
  JsonFile,
  ObsidianClient,
  VaultApi,
  VaultWaitForContentOptions,
  VaultWriteOptions,
} from "../core/types";
import { normalizeScope, resolveFilesystemPath, resolveVaultPath } from "./paths";

interface CreateVaultApiOptions {
  obsidian: ObsidianClient;
  root?: string;
}

export function createVaultApi(options: CreateVaultApiOptions): VaultApi {
  const scopeRoot = normalizeScope(options.root);

  return {
    async delete(targetPath, deleteOptions: DeleteOptions = {}) {
      const resolvedPath = await resolveFilesystemPath(options.obsidian, scopeRoot, targetPath);
      await rm(resolvedPath, {
        force: true,
        recursive: true,
      });

      if (deleteOptions.permanent === false) {
        return;
      }
    },
    async exists(targetPath) {
      try {
        const resolvedPath = await resolveFilesystemPath(options.obsidian, scopeRoot, targetPath);
        await access(resolvedPath);
        return true;
      } catch {
        return false;
      }
    },
    json<T = unknown>(targetPath: string) {
      const jsonFile: JsonFile<T> = {
        async patch(updater) {
          const currentValue = await jsonFile.read();
          const draft = structuredClone(currentValue);
          const result = await updater(draft);
          const nextValue = result ?? draft;

          await jsonFile.write(nextValue);

          return nextValue;
        },
        async read() {
          const resolvedPath = await resolveFilesystemPath(options.obsidian, scopeRoot, targetPath);
          const rawValue = await readFile(resolvedPath, "utf8");
          return JSON.parse(rawValue) as T;
        },
        async write(value) {
          const resolvedPath = await resolveFilesystemPath(options.obsidian, scopeRoot, targetPath);
          await mkdir(path.dirname(resolvedPath), { recursive: true });
          await writeFile(resolvedPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
        },
      };

      return jsonFile;
    },
    async mkdir(targetPath) {
      const resolvedPath = await resolveFilesystemPath(options.obsidian, scopeRoot, targetPath);
      await mkdir(resolvedPath, { recursive: true });
    },
    async read(targetPath) {
      const resolvedPath = await resolveFilesystemPath(options.obsidian, scopeRoot, targetPath);
      return readFile(resolvedPath, "utf8");
    },
    async waitForContent(targetPath, predicate, waitOptions: VaultWaitForContentOptions = {}) {
      const resolvedPath = await resolveFilesystemPath(options.obsidian, scopeRoot, targetPath);

      return options.obsidian.waitFor(
        async () => {
          try {
            const content = await readFile(resolvedPath, "utf8");
            return (await predicate(content)) ? content : false;
          } catch {
            return false;
          }
        },
        {
          message: `vault path "${resolveVaultPath(scopeRoot, targetPath)}" to match content`,
          ...waitOptions,
        },
      );
    },
    async waitForExists(targetPath, waitOptions) {
      const resolvedPath = await resolveFilesystemPath(options.obsidian, scopeRoot, targetPath);

      await options.obsidian.waitFor(
        async () => {
          try {
            await access(resolvedPath);
            return true;
          } catch {
            return false;
          }
        },
        {
          message: `vault path "${resolveVaultPath(scopeRoot, targetPath)}" to exist`,
          ...waitOptions,
        },
      );
    },
    async waitForMissing(targetPath, waitOptions) {
      const resolvedPath = await resolveFilesystemPath(options.obsidian, scopeRoot, targetPath);

      await options.obsidian.waitFor(
        async () => {
          try {
            await access(resolvedPath);
            return false;
          } catch {
            return true;
          }
        },
        {
          message: `vault path "${resolveVaultPath(scopeRoot, targetPath)}" to be removed`,
          ...waitOptions,
        },
      );
    },
    async write(targetPath, content, writeOptions: VaultWriteOptions = {}) {
      const resolvedPath = await resolveFilesystemPath(options.obsidian, scopeRoot, targetPath);
      await mkdir(path.dirname(resolvedPath), { recursive: true });
      await writeFile(resolvedPath, content, "utf8");

      if (!writeOptions.waitForContent) {
        return;
      }

      const predicate =
        typeof writeOptions.waitForContent === "function"
          ? writeOptions.waitForContent
          : (value: string) => value === content;

      await this.waitForContent(targetPath, predicate, writeOptions.waitOptions);
    },
  };
}
