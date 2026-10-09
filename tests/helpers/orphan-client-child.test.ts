import { existsSync } from "node:fs";
import process from "node:process";

import { test } from "vite-plus/test";

import { executeCommand } from "../../src/core/transport";
import { sleep } from "../../src/core/wait";

test.runIf(process.env.OBSIDIAN_E2E_ORPHAN_CHILD === "1")(
  "ends while a CLI client is in flight",
  async () => {
    const pidPath = process.env.OBSIDIAN_E2E_ORPHAN_PID_PATH!;

    void executeCommand({
      argv: [
        "-e",
        `require("node:fs").writeFileSync(${JSON.stringify(pidPath)}, String(process.pid)); setInterval(() => {}, 1000);`,
      ],
      bin: process.execPath,
      timeoutMs: 120_000,
    }).catch(() => {});

    while (!existsSync(pidPath)) {
      await sleep(20);
    }
  },
);
