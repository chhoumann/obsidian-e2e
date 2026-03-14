import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { posix as pathPosix } from 'node:path'

import type { DeleteOptions, ObsidianClient, VaultApi } from '../core/types'
import { createJsonFile } from './json-file'

interface CreateVaultApiOptions {
  obsidian: ObsidianClient
  root?: string
}

export function createVaultApi(options: CreateVaultApiOptions): VaultApi {
  const scopeRoot = normalizeScope(options.root)

  return {
    async delete(targetPath, deleteOptions: DeleteOptions = {}) {
      const resolvedPath = await resolveFilesystemPath(options.obsidian, scopeRoot, targetPath)
      await rm(resolvedPath, {
        force: true,
        recursive: true,
      })

      if (deleteOptions.permanent === false) {
        return
      }
    },
    async exists(targetPath) {
      try {
        const resolvedPath = await resolveFilesystemPath(options.obsidian, scopeRoot, targetPath)
        await access(resolvedPath)
        return true
      } catch {
        return false
      }
    },
    json<T = unknown>(targetPath: string) {
      const readPath = resolveFilesystemPath(options.obsidian, scopeRoot, targetPath)

      return {
        async patch(updater) {
          const filePath = await readPath
          return createJsonFile<T>(filePath).patch(updater)
        },
        async read() {
          const filePath = await readPath
          return createJsonFile<T>(filePath).read()
        },
        async write(value) {
          const filePath = await readPath
          await createJsonFile<T>(filePath).write(value)
        },
      }
    },
    async mkdir(targetPath) {
      const resolvedPath = await resolveFilesystemPath(options.obsidian, scopeRoot, targetPath)
      await mkdir(resolvedPath, { recursive: true })
    },
    async read(targetPath) {
      const resolvedPath = await resolveFilesystemPath(options.obsidian, scopeRoot, targetPath)
      return readFile(resolvedPath, 'utf8')
    },
    async waitForExists(targetPath, waitOptions) {
      await options.obsidian.waitFor(
        async () => ((await this.exists(targetPath)) ? true : false),
        {
          message: `vault path "${resolveVaultPath(scopeRoot, targetPath)}" to exist`,
          ...waitOptions,
        },
      )
    },
    async waitForMissing(targetPath, waitOptions) {
      await options.obsidian.waitFor(
        async () => ((await this.exists(targetPath)) ? false : true),
        {
          message: `vault path "${resolveVaultPath(scopeRoot, targetPath)}" to be removed`,
          ...waitOptions,
        },
      )
    },
    async write(targetPath, content) {
      const resolvedPath = await resolveFilesystemPath(options.obsidian, scopeRoot, targetPath)
      await mkdir(path.dirname(resolvedPath), { recursive: true })
      await writeFile(resolvedPath, content, 'utf8')
    },
  }
}

function normalizeScope(scope?: string): string {
  if (!scope || scope === '.') {
    return ''
  }

  return scope.replace(/^\/+|\/+$/g, '')
}

function resolveVaultPath(scopeRoot: string, targetPath: string): string {
  if (!targetPath || targetPath === '.') {
    return scopeRoot
  }

  return scopeRoot ? pathPosix.join(scopeRoot, targetPath) : pathPosix.normalize(targetPath)
}

async function resolveFilesystemPath(
  obsidian: ObsidianClient,
  scopeRoot: string,
  targetPath: string,
): Promise<string> {
  const vaultPath = await obsidian.vaultPath()
  const scopedPath = resolveVaultPath(scopeRoot, targetPath)
  const relativePath = scopedPath.split('/').filter(Boolean)
  const resolvedPath = path.resolve(vaultPath, ...relativePath)
  const normalizedVaultPath = path.resolve(vaultPath)

  if (resolvedPath !== normalizedVaultPath && !resolvedPath.startsWith(`${normalizedVaultPath}${path.sep}`)) {
    throw new Error(`Resolved path escapes the vault root: ${targetPath}`)
  }

  return resolvedPath
}
