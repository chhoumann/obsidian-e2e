import { buildCommandArgv } from './args'
import { createPluginHandle } from './plugin'
import { runObsidianCommand } from './transport'
import { waitFor } from './wait'
import type {
  ExecOptions,
  ObsidianArg,
  ObsidianClient,
  ObsidianClientOptions,
} from './types'

export function createObsidianClient(
  options: ObsidianClientOptions,
): ObsidianClient {
  const bin = options.bin ?? 'obsidian'

  return {
    bin,
    vaultName: options.vault,
    async exec(
      command: string,
      args: Record<string, ObsidianArg> = {},
      execOptions: ExecOptions = {},
    ) {
      const argv = buildCommandArgv(options.vault, command, args)
      return runObsidianCommand(bin, command, argv, {
        timeoutMs: execOptions.timeoutMs ?? options.timeoutMs,
        allowNonZeroExit: execOptions.allowNonZeroExit,
      })
    },
    async execJson<T = unknown>(
      command: string,
      args: Record<string, ObsidianArg> = {},
      execOptions: ExecOptions = {},
    ) {
      const stdout = await this.execText(command, args, execOptions)
      return JSON.parse(stdout) as T
    },
    async execText(
      command: string,
      args: Record<string, ObsidianArg> = {},
      execOptions: ExecOptions = {},
    ) {
      const result = await this.exec(command, args, execOptions)
      return result.stdout
    },
    plugin(id: string) {
      return createPluginHandle(this, id)
    },
    async vaultPath() {
      return this.execText('vault', { info: 'path' })
    },
    async verify() {
      await this.execText('vault', { info: 'name' })
    },
    async waitFor(callback, waitOptions = {}) {
      return waitFor(callback, {
        intervalMs: waitOptions.intervalMs ?? options.intervalMs,
        message: waitOptions.message,
        timeoutMs: waitOptions.timeoutMs ?? options.timeoutMs,
      })
    },
  }
}
