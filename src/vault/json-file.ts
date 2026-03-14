import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

import type { JsonFile, JsonFileUpdater } from '../core/types'

export function createJsonFile<T = unknown>(
  filePath: string,
  beforeMutate?: () => Promise<void>,
): JsonFile<T> {
  return {
    async patch(updater: JsonFileUpdater<T>) {
      await beforeMutate?.()

      const currentValue = await this.read()
      const draft = structuredClone(currentValue)
      const result = await updater(draft)
      const nextValue = result ?? draft

      await this.write(nextValue)

      return nextValue
    },
    async read() {
      const value = await readFile(filePath, 'utf8')
      return JSON.parse(value) as T
    },
    async write(value: T) {
      await beforeMutate?.()
      await mkdir(path.dirname(filePath), { recursive: true })
      await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    },
  }
}
