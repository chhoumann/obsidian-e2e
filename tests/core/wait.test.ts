import { describe, expect, test } from "vite-plus/test";

import { WaitForTimeoutError } from "../../src/core/errors";
import { waitForValue } from "../../src/core/wait";

describe("waitForValue", () => {
  test("returns the first resolved value", async () => {
    let attempts = 0;

    const result = await waitForValue(async () => {
      attempts += 1;
      return attempts > 2 ? "ready" : undefined;
    });

    expect(result).toBe("ready");
  });

  test("throws a timeout error with context", async () => {
    await expect(
      waitForValue(async () => false, {
        intervalMs: 10,
        message: "a useful condition",
        timeoutMs: 30,
      }),
    ).rejects.toBeInstanceOf(WaitForTimeoutError);
  });
});
