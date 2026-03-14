import { posix as pathPosix } from 'node:path'
import { randomUUID } from 'node:crypto'

import type { ObsidianClient, SandboxApi } from '../core/types'
import { createVaultApi } from './vault'

interface CreateSandboxApiOptions {
  obsidian: ObsidianClient
  sandboxRoot: string
  testName: string
}

export async function createSandboxApi(
  options: CreateSandboxApiOptions,
): Promise<SandboxApi> {
  const root = pathPosix.join(
    options.sandboxRoot,
    `${sanitizeSegment(options.testName)}-${randomUUID().slice(0, 8)}`,
  )
  const vault = createVaultApi({
    obsidian: options.obsidian,
    root,
  })

  await vault.mkdir('.')

  return {
    ...vault,
    async cleanup() {
      await vault.delete('.', { permanent: true })
    },
    path(...segments: string[]) {
      return pathPosix.join(root, ...segments)
    },
    root,
  }
}

function sanitizeSegment(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'test'
}
