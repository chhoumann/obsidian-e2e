import { describe, expect, test } from 'vite-plus/test'
import { WaitForTimeoutError } from '../../src/core/errors'
import { waitFor } from '../../src/core/wait'

describe('waitFor', () => {
  test('resolves when the callback becomes truthy', async () => {
    let attempts = 0

    await expect(
      waitFor(
        () => {
          attempts += 1
          return attempts > 2 ? 'ready' : false
        },
        { intervalMs: 1, timeoutMs: 100 },
      ),
    ).resolves.toBe('ready')
  })

  test('throws an actionable timeout error', async () => {
    await expect(
      waitFor(() => false, {
        intervalMs: 1,
        message: 'Expected reload to finish.',
        timeoutMs: 5,
      }),
    ).rejects.toBeInstanceOf(WaitForTimeoutError)
  })
})
