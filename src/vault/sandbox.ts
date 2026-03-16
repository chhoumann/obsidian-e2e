import { posix as pathPosix } from "node:path";
import { randomUUID } from "node:crypto";

import type {
  NoteDocument,
  NoteFrontmatter,
  ObsidianClient,
  SandboxApi,
  SandboxWriteNoteOptions,
} from "../core/types";
import { sanitizePathSegment } from "../core/path-slug";
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
    `${sanitizePathSegment(options.testName)}-${randomUUID().slice(0, 8)}`,
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
    path(...segments: string[]) {
      return sandboxPath(...segments);
    },
    async readNote<TFrontmatter extends NoteFrontmatter | null = NoteFrontmatter | null>(
      targetPath: string,
    ): Promise<NoteDocument<TFrontmatter>> {
      return parseNoteDocument(await vault.read(targetPath)) as NoteDocument<TFrontmatter>;
    },
    root,
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
