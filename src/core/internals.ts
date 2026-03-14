import { rm, writeFile } from 'node:fs/promises'

import type { ObsidianClient } from './types'

interface SnapshotEntry {
  exists: boolean
  value: string
}

interface ClientInternals {
  restoreAll(): Promise<void>
  restoreFile(filePath: string): Promise<void>
  snapshotFileOnce(filePath: string): Promise<void>
}

const clientInternals = new WeakMap<ObsidianClient, ClientInternals>()

export function attachClientInternals(
  client: ObsidianClient,
  internals: ClientInternals,
): void {
  clientInternals.set(client, internals)
}

export function getClientInternals(client: ObsidianClient): ClientInternals {
  const internals = clientInternals.get(client)

  if (!internals) {
    throw new Error('Missing obsidian client internals.')
  }

  return internals
}

export function createRestoreManager(readFile: (filePath: string) => Promise<string>) {
  const snapshots = new Map<string, SnapshotEntry>()

  return {
    async restoreAll() {
      const entries = [...snapshots.entries()].reverse()

      for (const [filePath, snapshot] of entries) {
        await restoreSnapshot(filePath, snapshot)
      }

      snapshots.clear()
    },
    async restoreFile(filePath: string) {
      const snapshot = snapshots.get(filePath)

      if (!snapshot) {
        return
      }

      await restoreSnapshot(filePath, snapshot)
      snapshots.delete(filePath)
    },
    async snapshotFileOnce(filePath: string) {
      if (snapshots.has(filePath)) {
        return
      }

      try {
        snapshots.set(filePath, {
          exists: true,
          value: await readFile(filePath),
        })
      } catch (error) {
        if (isMissingFileError(error)) {
          snapshots.set(filePath, {
            exists: false,
            value: '',
          })
          return
        }

        throw error
      }
    },
  }
}

async function restoreSnapshot(
  filePath: string,
  snapshot: SnapshotEntry,
): Promise<void> {
  if (snapshot.exists) {
    await writeFile(filePath, snapshot.value, 'utf8')
    return
  }

  await rm(filePath, { force: true, recursive: true })
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
}
