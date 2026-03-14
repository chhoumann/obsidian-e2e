import { WaitForTimeoutError } from './errors'
import type { WaitForOptions } from './types'

const DEFAULT_INTERVAL_MS = 100
const DEFAULT_TIMEOUT_MS = 2_000

export async function waitFor<T>(
  callback: () => Promise<T | false | null | undefined> | T | false | null | undefined,
  options: WaitForOptions = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS
  const message = options.message ?? 'Condition did not become truthy.'
  const deadline = Date.now() + timeoutMs

  while (Date.now() <= deadline) {
    const result = await callback()
    if (result) {
      return result
    }

    if (Date.now() + intervalMs > deadline) {
      break
    }

    await sleep(intervalMs)
  }

  throw new WaitForTimeoutError(message, timeoutMs, intervalMs)
}

export function sleep(durationMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, durationMs)
  })
}
