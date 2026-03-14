import { describe, expect, test } from 'vite-plus/test'
import { buildCommandArgv } from '../../src/core/args'

describe('buildCommandArgv', () => {
  test('prepends the vault argument and stringifies key-value args', () => {
    expect(
      buildCommandArgv('dev', 'quickadd:run', {
        choice: '__qa-test__',
        count: 2,
      }),
    ).toEqual([
      'vault=dev',
      'quickadd:run',
      'choice=__qa-test__',
      'count=2',
    ])
  })

  test('omits nullish and false args and preserves true flags', () => {
    expect(
      buildCommandArgv('dev', 'vault', {
        info: 'path',
        json: true,
        noop: false,
        empty: undefined,
        none: null,
      }),
    ).toEqual(['vault=dev', 'vault', 'info=path', 'json'])
  })

  test('splits multi-segment commands into argv parts', () => {
    expect(buildCommandArgv('dev', 'vault inspect', {})).toEqual([
      'vault=dev',
      'vault',
      'inspect',
    ])
  })
})
