import { describe, expect, test } from "vite-plus/test";

import { buildCommandArgv } from "../../src/core/args";

describe("buildCommandArgv", () => {
  test("serializes obsidian CLI arguments predictably", () => {
    expect(
      buildCommandArgv("dev", "quickadd:run", {
        choice: "My Choice",
        dryRun: true,
        ignore: false,
        retries: 2,
      }),
    ).toEqual(["vault=dev", "quickadd:run", "choice=My Choice", "dryRun", "retries=2"]);
  });
});
