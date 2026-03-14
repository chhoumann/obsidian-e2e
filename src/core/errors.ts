export class ObsidianCommandError extends Error {
  readonly argv: string[]
  readonly command: string
  readonly exitCode: number
  readonly stderr: string
  readonly stdout: string

  constructor(args: {
    argv: string[]
    command: string
    exitCode: number
    stderr: string
    stdout: string
  }) {
    const detail = args.stderr || args.stdout || 'No output received.'
    super(
      [
        `Obsidian command failed: ${args.command}`,
        `Exit code: ${args.exitCode}`,
        `Details: ${detail}`,
      ].join('\n'),
    )
    this.name = 'ObsidianCommandError'
    this.argv = args.argv
    this.command = args.command
    this.exitCode = args.exitCode
    this.stderr = args.stderr
    this.stdout = args.stdout
  }
}

export class WaitForTimeoutError extends Error {
  readonly intervalMs: number
  readonly timeoutMs: number

  constructor(message: string, timeoutMs: number, intervalMs: number) {
    super(`${message} Timed out after ${timeoutMs}ms (interval ${intervalMs}ms).`)
    this.name = 'WaitForTimeoutError'
    this.timeoutMs = timeoutMs
    this.intervalMs = intervalMs
  }
}
