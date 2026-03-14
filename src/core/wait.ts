import { WaitForTimeoutError } from "./errors";
import type { WaitForOptions } from "./types";

const DEFAULT_INTERVAL_MS = 100;
const DEFAULT_TIMEOUT_MS = 5_000;

export async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitForValue<T>(
  fn: () => Promise<T | false | null | undefined> | T | false | null | undefined,
  options: WaitForOptions = {},
): Promise<T> {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const startTime = Date.now();

  let lastError: unknown;

  while (Date.now() - startTime <= timeoutMs) {
    try {
      const result = await fn();
      if (result !== false && result !== null && result !== undefined) {
        return result;
      }
    } catch (error) {
      lastError = error;
    }

    await sleep(intervalMs);
  }

  const label = options.message ?? "condition";
  throw new WaitForTimeoutError(`Timed out waiting for ${label} after ${timeoutMs}ms.`, lastError);
}
