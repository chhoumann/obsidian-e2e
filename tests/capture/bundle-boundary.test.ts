import fs from "node:fs/promises";
import path from "node:path";

import { describe, expect, test } from "vite-plus/test";

/**
 * The capture entry must not share the runner's launch/version-guard modules:
 * doing so made the bundler split `launchObsidianInstance` and
 * `bundledAsarCandidates` into different chunks, which broke consumers
 * (QuickAdd's Linux bridge) that patch both in one dist file.
 */
const FORBIDDEN = ["instance", "version-guard", "launch", "ensure", "provision", "stop"];

describe("capture bundle boundary", () => {
  test("src/capture does not import runner lifecycle modules", async () => {
    const dir = path.resolve(import.meta.dirname, "../../src/capture");
    const offenders: string[] = [];
    for (const name of await fs.readdir(dir)) {
      const source = await fs.readFile(path.join(dir, name), "utf8");
      for (const match of source.matchAll(/from\s+"\.\.\/runner\/([\w/-]+)"/g)) {
        if (FORBIDDEN.includes(match[1]!)) offenders.push(`${name} -> runner/${match[1]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
