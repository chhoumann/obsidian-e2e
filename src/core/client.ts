import { buildCommandArgv } from './args'
import { attachClientInternals, createRestoreManager } from './internals'
import { createPluginHandle } from '../plugin/plugin'
import { executeCommand } from './transport'
import type { CreateObsidianClientOptions, ObsidianClient } from './types'
import { waitForValue } from './wait'

export function createObsidianClient(
  options: CreateObsidianClientOptions,
): ObsidianClient {
  const transport = options.transport ?? executeCommand
  const waitDefaults = {
    intervalMs: options.intervalMs,
    timeoutMs: options.timeoutMs,
  }

  const restoreManager = createRestoreManager(async (filePath) => {
    const { readFile } = await import('node:fs/promises')
    return readFile(filePath, 'utf8')
  })

  let cachedVaultPath: string | undefined

  const client: ObsidianClient = {
    bin: options.bin ?? 'obsidian',
    exec(command, args, execOptions) {
      return transport({
        ...execOptions,
        argv: buildCommandArgv(options.vault, command, args),
        bin: this.bin,
      })
    },
    async execJson<T = unknown>(command, args, execOptions) {
      const output = await this.execText(command, args, execOptions)
      return JSON.parse(output) as T
    },
    async execText(command, args, execOptions) {
      const result = await this.exec(command, args, execOptions)
      return result.stdout.trimEnd()
    },
    plugin(id) {
      return createPluginHandle(this, id)
    },
    async vaultPath() {
      if (!cachedVaultPath) {
        cachedVaultPath = await this.execText('vault', { info: 'path' })
      }

      return cachedVaultPath
    },
    async verify() {
      await transport({
        argv: ['--help'],
        bin: this.bin,
      })

      await this.vaultPath()
    },
    vaultName: options.vault,
    waitFor(fn, waitOptions) {
      return waitForValue(fn, {
        ...waitDefaults,
        ...waitOptions,
      })
    },
  }

  attachClientInternals(client, restoreManager)

  return client
}
