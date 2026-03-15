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
      return waitForPresentValue(
        client,
        path,
        () => client.metadata.fileCache<T>(path),
        predicate,
        "metadata cache",
        options,
      );
    },
    async waitForFrontmatter<T extends NoteFrontmatter = NoteFrontmatter>(
      path: string,
      predicate?: MetadataPredicate<T>,
      options?: MetadataWaitOptions,
    ) {
      return waitForPresentValue(
        client,
        path,
        () => client.metadata.frontmatter<T>(path),
        predicate,
        "frontmatter",
        options,
      );
    },
    async waitForMetadata<T = MetadataFileCache>(
      path: string,
      predicate?: MetadataPredicate<T>,
      options?: MetadataWaitOptions,
    ) {
      return waitForPresentValue(
        client,
        path,
        () => client.metadata.fileCache<T>(path),
        predicate,
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

async function waitForPresentValue<T>(
  client: ObsidianClient,
  path: string,
  readValue: () => Promise<T | null>,
  predicate: MetadataPredicate<T> | undefined,
  label: string,
  options: MetadataWaitOptions = {},
): Promise<T> {
  return client.waitFor(
    async () => {
      const value = await readValue();

      if (value === null) {
        return false;
      }

      return (await (predicate?.(value) ?? true)) ? value : false;
    },
    {
      ...options,
      message: options.message ?? `vault path "${path}" to expose ${label}`,
    },
  );
}
