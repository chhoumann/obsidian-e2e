import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { JsonFile, ObsidianClient, PluginHandle } from './types'

export function createPluginHandle(
  obsidian: ObsidianClient,
  id: string,
): PluginHandle {
  return {
    id,
    data<T = unknown>(): JsonFile<T> {
      return createJsonFile<T>(async () => {
        const pluginDataPath = await this.dataPath()
        return pluginDataPath
      })
    },
    async dataPath() {
      const vaultPath = await obsidian.vaultPath()
      return path.join(vaultPath, '.obsidian', 'plugins', id, 'data.json')
    },
    async isEnabled() {
      const output = await obsidian.execText('plugin', { id }, { allowNonZeroExit: true })
      return /enabled\s+true/i.test(output)
    },
    async reload() {
      await obsidian.exec('plugin:reload', { id })
    },
  }
}

function createJsonFile<T>(resolvePath: () => Promise<string>): JsonFile<T> {
  return {
    async path() {
      return resolvePath()
    },
    async read() {
      const filePath = await resolvePath()
      const content = await fs.readFile(filePath, 'utf8')
      return JSON.parse(content) as T
    },
    async write(value: T) {
      const filePath = await resolvePath()
      const content = JSON.stringify(value, null, '\t')
      await fs.writeFile(filePath, `${content}\n`, 'utf8')
    },
    async patch(updater) {
      const current = await this.read()
      const updated = updater(current) ?? current
      await this.write(updated)
      return updated
    },
  }
}
