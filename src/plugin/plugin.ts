import path from 'node:path'

import { getClientInternals } from '../core/internals'
import type { JsonFile, ObsidianClient, PluginHandle } from '../core/types'
import { createJsonFile } from '../vault/json-file'

export function createPluginHandle(
  client: ObsidianClient,
  id: string,
): PluginHandle {
  async function resolveDataPath() {
    const vaultPath = await client.vaultPath()
    return path.join(vaultPath, '.obsidian', 'plugins', id, 'data.json')
  }

  return {
    data<T = unknown>(): JsonFile<T> {
      return {
        async patch(updater) {
          const dataPath = await resolveDataPath()
          return createJsonFile<T>(
            dataPath,
            () => getClientInternals(client).snapshotFileOnce(dataPath),
          ).patch(updater)
        },
        async read() {
          const dataPath = await resolveDataPath()
          return createJsonFile<T>(dataPath).read()
        },
        async write(value) {
          const dataPath = await resolveDataPath()
          await createJsonFile<T>(
            dataPath,
            () => getClientInternals(client).snapshotFileOnce(dataPath),
          ).write(value)
        },
      }
    },
    async dataPath() {
      return resolveDataPath()
    },
    id,
    async isEnabled() {
      const output = await client.execText('plugin', { id }, { allowNonZeroExit: true })
      return /enabled\s+true/i.test(output)
    },
    async reload() {
      await client.exec('plugin:reload', { id })
    },
    async restoreData() {
      await getClientInternals(client).restoreFile(await resolveDataPath())
    },
  }
}
