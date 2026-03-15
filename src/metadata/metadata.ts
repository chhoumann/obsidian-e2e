import { buildHarnessCallCode, parseHarnessEnvelope } from "../dev/harness";
import type {
  ExecOptions,
  MetadataFileCache,
  MetadataPredicate,
  MetadataWaitOptions,
  NoteFrontmatter,
  ObsidianClient,
  ObsidianMetadataHandle,
} from "../core/types";

export function createObsidianMetadataHandle(client: ObsidianClient): ObsidianMetadataHandle {
  return {
    async fileCache<T = MetadataFileCache>(path: string, execOptions?: ExecOptions) {
      return readMetadata<T | null>(client, "metadata", path, execOptions);
    },
    async frontmatter<T extends NoteFrontmatter = NoteFrontmatter>(
      path: string,
      execOptions?: ExecOptions,
    ) {
      return readMetadata<T | null>(client, "frontmatter", path, execOptions);
    },
    async waitForFileCache<T = MetadataFileCache>(
      path: string,
      predicate?: MetadataPredicate<T>,
      options?: MetadataWaitOptions,
    ) {
      return waitForMetadataValue(
        client,
        path,
        async (value) => {
          if (value === null) {
            return false;
          }

          return (await (predicate?.(value as T) ?? true)) ? (value as T) : false;
        },
        "metadata cache",
        options,
      );
    },
    async waitForFrontmatter<T extends NoteFrontmatter = NoteFrontmatter>(
      path: string,
      predicate?: MetadataPredicate<T>,
      options?: MetadataWaitOptions,
    ) {
      return waitForMetadataValue(
        client,
        path,
        async (value) => {
          const frontmatter = (value as MetadataFileCache<T> | null)?.frontmatter ?? null;

          if (frontmatter === null) {
            return false;
          }

          return (await (predicate?.(frontmatter) ?? true)) ? frontmatter : false;
        },
        "frontmatter",
        options,
      );
    },
    async waitForMetadata<T = MetadataFileCache>(
      path: string,
      predicate?: MetadataPredicate<T>,
      options?: MetadataWaitOptions,
    ) {
      return waitForMetadataValue(
        client,
        path,
        async (value) => {
          if (value === null) {
            return false;
          }

          return (await (predicate?.(value as T) ?? true)) ? (value as T) : false;
        },
        "metadata",
        options,
      );
    },
  };
}

async function readMetadata<T>(
  client: ObsidianClient,
  method: "frontmatter" | "metadata",
  path: string,
  execOptions?: ExecOptions,
): Promise<T> {
  return parseHarnessEnvelope<T>(
    await client.dev.evalRaw(buildHarnessCallCode(method, path), execOptions),
  );
}

async function waitForMetadataValue<T>(
  client: ObsidianClient,
  path: string,
  predicate: (value: MetadataFileCache | null) => Promise<T | false> | T | false,
  label: string,
  options: MetadataWaitOptions = {},
): Promise<T> {
  return client.waitFor(async () => predicate(await client.metadata.fileCache(path)), {
    ...options,
    message: options.message ?? `vault path "${path}" to expose ${label}`,
  });
}
