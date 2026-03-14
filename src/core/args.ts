import type { ObsidianArg } from './types'

export function buildCommandArgv(
  vaultName: string,
  command: string,
  args: Record<string, ObsidianArg> = {},
): string[] {
  const argv = [`vault=${vaultName}`]
  const commandSegments = command
    .split(/\s+/)
    .map((segment) => segment.trim())
    .filter(Boolean)

  argv.push(...commandSegments)

  for (const [key, value] of Object.entries(args)) {
    if (value === false || value === null || value === undefined) {
      continue
    }

    if (value === true) {
      argv.push(key)
      continue
    }

    argv.push(`${key}=${String(value)}`)
  }

  return argv
}
