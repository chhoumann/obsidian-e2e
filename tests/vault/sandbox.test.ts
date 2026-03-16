import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, test } from "vite-plus/test";

import { createSandboxApi } from "../../src/vault/sandbox";
import { createVaultApi } from "../../src/vault/vault";
import { waitForValue } from "../../src/core/wait";
import type { ObsidianClient } from "../../src/core/types";
import {
  cleanupTempDirectories,
  createTempDir as createTrackedTempDir,
} from "../helpers/create-temp-dir";
import { createStubObsidianClient } from "../helpers/stub-obsidian-client";

const tempDirectories: string[] = [];

afterEach(async () => {
  await cleanupTempDirectories(tempDirectories);
});

describe("createVaultApi", () => {
  test("reads and writes files relative to the vault root", async () => {
    const vaultRoot = await createVaultRoot();
    const vault = createVaultApi({
      obsidian: createStubClient(vaultRoot),
      root: "__obsidian_e2e__/case-a",
    });

    await vault.write("note.md", "hello");

    await expect(vault.read("note.md")).resolves.toBe("hello");
    await expect(
      fs.readFile(path.join(vaultRoot, "__obsidian_e2e__", "case-a", "note.md"), "utf8"),
    ).resolves.toBe("hello");
  });

  test("waits for content updates through the shared polling helper", async () => {
    const vaultRoot = await createVaultRoot();
    const vault = createVaultApi({
      obsidian: createPollingStubClient(vaultRoot),
      root: "__obsidian_e2e__/case-b",
    });
    const notePath = path.join(vaultRoot, "__obsidian_e2e__", "case-b", "note.md");

    await fs.mkdir(path.dirname(notePath), { recursive: true });
    await fs.writeFile(notePath, "pending", "utf8");

    setTimeout(() => {
      void fs.writeFile(notePath, "ready", "utf8");
    }, 5);

    await expect(
      vault.waitForContent("note.md", (content) => content === "ready", {
        intervalMs: 1,
        timeoutMs: 50,
      }),
    ).resolves.toBe("ready");
  });

  test("includes the vault path in waitForContent timeout errors", async () => {
    const vaultRoot = await createVaultRoot();
    const vault = createVaultApi({
      obsidian: createPollingStubClient(vaultRoot),
      root: "__obsidian_e2e__/case-c",
    });

    await expect(
      vault.waitForContent("note.md", () => false, {
        intervalMs: 1,
        timeoutMs: 5,
      }),
    ).rejects.toMatchObject({
      message: expect.stringContaining(
        'vault path "__obsidian_e2e__/case-c/note.md" to match content',
      ),
    });
  });

  test("can wait for written content to become observable", async () => {
    const vaultRoot = await createVaultRoot();
    const vault = createVaultApi({
      obsidian: createPollingStubClient(vaultRoot),
      root: "__obsidian_e2e__/case-d",
    });

    await expect(
      vault.write("note.md", "hello", {
        waitForContent: true,
        waitOptions: {
          intervalMs: 1,
          timeoutMs: 25,
        },
      }),
    ).resolves.toBeUndefined();
    await expect(vault.read("note.md")).resolves.toBe("hello");
  });
});

describe("createSandboxApi", () => {
  test("creates a unique scoped root and cleans it up", async () => {
    const vaultRoot = await createVaultRoot();
    const sandbox = await createSandboxApi({
      obsidian: createStubClient(vaultRoot),
      sandboxRoot: "__obsidian_e2e__",
      testName: "Preserves leading zeros",
    });

    await sandbox.write("tpl.md", "hello");

    const expectedPath = path.join(vaultRoot, sandbox.root, "tpl.md");
    await expect(fs.readFile(expectedPath, "utf8")).resolves.toBe("hello");
    expect(sandbox.root).toMatch(/^__obsidian_e2e__\/preserves-leading-zeros-[a-f0-9]{8}$/);
    expect(sandbox.path("tpl.md")).toBe(`${sandbox.root}/tpl.md`);

    await sandbox.cleanup();

    await expect(fs.access(path.join(vaultRoot, sandbox.root))).rejects.toThrow();
  });

  test("reads note models while metadata stays on obsidian.metadata", async () => {
    const vaultRoot = await createVaultRoot();
    const metadataByPath: Record<string, { frontmatter: { tags: string[] } } | null> = {};
    const obsidian = createStubObsidianClient({
      metadataByPath,
      vaultRoot,
    });
    const sandbox = await createSandboxApi({
      obsidian,
      sandboxRoot: "__obsidian_e2e__",
      testName: "Notes",
    });

    await sandbox.write("test.md", "---\ntitle: Daily\n---\nBody\n");
    metadataByPath[sandbox.path("test.md")] = {
      frontmatter: {
        tags: ["daily"],
      },
    };

    await expect(sandbox.readNote("test.md")).resolves.toEqual({
      body: "Body\n",
      frontmatter: {
        title: "Daily",
      },
      raw: "---\ntitle: Daily\n---\nBody\n",
    });
    await expect(obsidian.metadata.frontmatter(sandbox.path("test.md"))).resolves.toEqual({
      tags: ["daily"],
    });
  });

  test("writes note documents and waits for metadata by default", async () => {
    const vaultRoot = await createVaultRoot();
    const metadataByPath: Record<string, { frontmatter: { title: string } } | null> = {};
    const obsidian = createStubObsidianClient({
      metadataByPath,
      vaultRoot,
      waitFor: (callback, options) => waitForValue(callback, options),
    });
    const sandbox = await createSandboxApi({
      obsidian,
      sandboxRoot: "__obsidian_e2e__",
      testName: "Notes",
    });

    metadataByPath[sandbox.path("test.md")] = null;
    setTimeout(() => {
      metadataByPath[sandbox.path("test.md")] = {
        frontmatter: {
          title: "Daily",
        },
      };
    }, 5);
    metadataByPath[sandbox.path("third.md")] = null;
    setTimeout(() => {
      metadataByPath[sandbox.path("third.md")] = {
        frontmatter: {
          title: "Third",
        },
      };
    }, 5);

    await expect(
      sandbox.writeNote({
        body: "Body\n",
        frontmatter: {
          title: "Daily",
        },
        path: "test.md",
        waitOptions: {
          intervalMs: 1,
          timeoutMs: 50,
        },
      }),
    ).resolves.toEqual({
      body: "Body\n",
      frontmatter: {
        title: "Daily",
      },
      raw: "---\ntitle: Daily\n---\nBody\n",
    });
    await expect(
      sandbox.writeNote({
        body: "Second body\n",
        frontmatter: {
          title: "Second",
        },
        path: "second.md",
        waitForMetadata: false,
      }),
    ).resolves.toEqual({
      body: "Second body\n",
      frontmatter: {
        title: "Second",
      },
      raw: "---\ntitle: Second\n---\nSecond body\n",
    });
    await expect(
      sandbox.writeNote({
        body: "Third body\n",
        frontmatter: {
          title: "Third",
        },
        path: "third.md",
        waitForMetadata: (value) => value.frontmatter?.title === "Third",
        waitOptions: {
          intervalMs: 1,
          timeoutMs: 50,
        },
      }),
    ).resolves.toEqual({
      body: "Third body\n",
      frontmatter: {
        title: "Third",
      },
      raw: "---\ntitle: Third\n---\nThird body\n",
    });
    await expect(sandbox.readNote("second.md")).resolves.toEqual({
      body: "Second body\n",
      frontmatter: {
        title: "Second",
      },
      raw: "---\ntitle: Second\n---\nSecond body\n",
    });
    await expect(sandbox.readNote("third.md")).resolves.toEqual({
      body: "Third body\n",
      frontmatter: {
        title: "Third",
      },
      raw: "---\ntitle: Third\n---\nThird body\n",
    });
    expect(sandbox.path("nested", "note.md")).toBe(`${sandbox.root}/nested/note.md`);
    await expect(obsidian.metadata.waitForFrontmatter(sandbox.path("test.md"))).resolves.toEqual({
      title: "Daily",
    });
    await expect(obsidian.metadata.waitForMetadata(sandbox.path("third.md"))).resolves.toEqual({
      frontmatter: {
        title: "Third",
      },
    });
  });
});

async function createVaultRoot(): Promise<string> {
  return createTrackedTempDir(tempDirectories, "obsidian-e2e-vault-");
}

function createStubClient(vaultRoot: string): ObsidianClient {
  return createStubObsidianClient({ vaultRoot });
}

function createPollingStubClient(vaultRoot: string): ObsidianClient {
  return createStubObsidianClient({
    vaultRoot,
    waitFor: (callback, options) => waitForValue(callback, options),
  });
}
