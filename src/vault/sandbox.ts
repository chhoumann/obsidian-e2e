import { posix as pathPosix } from "node:path";
import { randomUUID } from "node:crypto";

import type {
  NoteDocument,
  NoteFrontmatter,
  ObsidianClient,
  SandboxApi,
  SandboxWriteNoteOptions,
} from "../core/types";
import { createNoteDocument, parseNoteDocument } from "../note/document";
import { createVaultApi } from "./vault";

interface CreateSandboxApiOptions {
  obsidian: ObsidianClient;
  sandboxRoot: string;
  testName: string;
}

export async function createSandboxApi(options: CreateSandboxApiOptions): Promise<SandboxApi> {
  const root = pathPosix.join(
    options.sandboxRoot,
    `${sanitizeSegment(options.testName)}-${randomUUID().slice(0, 8)}`,
  );
  const sandboxPath = (...segments: string[]) => pathPosix.join(root, ...segments);
  const vault = createVaultApi({
    obsidian: options.obsidian,
    root,
  });

  await vault.mkdir(".");

  return {
    ...vault,
    async cleanup() {
      await vault.delete(".", { permanent: true });
    },
    async frontmatter(targetPath) {
      return options.obsidian.metadata.frontmatter(sandboxPath(targetPath));
    },
    path(...segments: string[]) {
      return sandboxPath(...segments);
    },
    async readNote<TFrontmatter extends NoteFrontmatter | null = NoteFrontmatter | null>(
      targetPath: string,
    ): Promise<NoteDocument<TFrontmatter>> {
      return parseNoteDocument(await vault.read(targetPath)) as NoteDocument<TFrontmatter>;
    },
    root,
    async waitForFrontmatter(targetPath, predicate, waitOptions) {
      return options.obsidian.metadata.waitForFrontmatter(
        sandboxPath(targetPath),
        predicate,
        waitOptions,
      );
    },
    async waitForMetadata(targetPath, predicate, waitOptions) {
      return options.obsidian.metadata.waitForMetadata(
        sandboxPath(targetPath),
        predicate,
        waitOptions,
      );
    },
    async writeNote<TFrontmatter extends NoteFrontmatter | null = NoteFrontmatter | null>(
      writeOptions: SandboxWriteNoteOptions<TFrontmatter>,
    ): Promise<NoteDocument<TFrontmatter>> {
      const { path, waitForMetadata = true, waitOptions, ...noteInput } = writeOptions;
      const document = createNoteDocument(noteInput) as NoteDocument<TFrontmatter>;

      await vault.write(path, document.raw);

      if (waitForMetadata) {
        const predicate = typeof waitForMetadata === "function" ? waitForMetadata : undefined;
        await options.obsidian.metadata.waitForMetadata(sandboxPath(path), predicate, waitOptions);
      }

      return document;
    },
  };
}

function sanitizeSegment(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "test"
  );
}
