import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { ObsidianCommandError } from './errors'
import type { ExecOptions, ExecResult } from './types'

const execFileAsync = promisify(execFile)
const DEFAULT_TIMEOUT_MS = 10_000
const MAX_BUFFER_BYTES = 10 * 1024 * 1024

export async function runObsidianCommand(
  bin: string,
  command: string,
  argv: string[],
  options: ExecOptions = {},
): Promise<ExecResult> {
  const commandString = [bin, ...argv].join(' ')

  try {
    const result = await execFileAsync(bin, argv, {
      encoding: 'utf8',
      maxBuffer: MAX_BUFFER_BYTES,
      timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    })

    return {
      argv,
      command: commandString,
      exitCode: 0,
      stderr: result.stderr.trim(),
      stdout: result.stdout.trim(),
    }
  } catch (error) {
    const stderr =
      typeof error === 'object' &&
      error !== null &&
      'stderr' in error &&
      typeof error.stderr === 'string'
        ? error.stderr.trim()
        : ''
    const stdout =
      typeof error === 'object' &&
      error !== null &&
      'stdout' in error &&
      typeof error.stdout === 'string'
        ? error.stdout.trim()
        : ''
    const exitCode =
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      typeof error.code === 'number'
        ? error.code
        : 1

    const result: ExecResult = {
      argv,
      command: commandString,
      exitCode,
      stderr,
      stdout,
    }

    if (options.allowNonZeroExit) {
      return result
    }

    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'ENOENT'
    ) {
      throw new Error(
        `Obsidian binary "${bin}" was not found. Ensure the Obsidian CLI is installed and available in PATH.`,
      )
    }

    throw new ObsidianCommandError(result)
  }
}
