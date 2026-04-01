import { describe, expect, test } from 'bun:test'

import { resolveChromeNativeHostCommand } from '../setup.js'

describe('resolveChromeNativeHostCommand', () => {
  test('uses bundled dist cli path when setup code lives inside dist', () => {
    const command = resolveChromeNativeHostCommand({
      modulePath: '/tmp/claude-code/dist/cli.js',
      execPath: '/usr/local/bin/node',
      pathExists: path => path === '/tmp/claude-code/dist/cli.js',
    })

    expect(command).toBe(
      '"/usr/local/bin/node" "/tmp/claude-code/dist/cli.js" --chrome-native-host',
    )
  })

  test('falls back to repo dist cli path in source mode', () => {
    const command = resolveChromeNativeHostCommand({
      modulePath:
        '/repo/claude-code/src/utils/claudeInChrome/setup.ts',
      execPath: '/usr/local/bin/bun',
      pathExists: path => path === '/repo/claude-code/dist/cli.js',
    })

    expect(command).toBe(
      '"/usr/local/bin/bun" "/repo/claude-code/dist/cli.js" --chrome-native-host',
    )
  })

  test('falls back to source cli entrypoint when dist is unavailable', () => {
    const command = resolveChromeNativeHostCommand({
      modulePath:
        '/repo/claude-code/src/utils/claudeInChrome/setup.ts',
      execPath: '/usr/local/bin/bun',
      pathExists: path => path === '/repo/claude-code/src/entrypoints/cli.tsx',
    })

    expect(command).toBe(
      '"/usr/local/bin/bun" "/repo/claude-code/src/entrypoints/cli.tsx" --chrome-native-host',
    )
  })

  test('throws when no compatible cli entrypoint exists', () => {
    expect(() =>
      resolveChromeNativeHostCommand({
        modulePath:
          '/repo/claude-code/src/utils/claudeInChrome/setup.ts',
        execPath: '/usr/local/bin/bun',
        pathExists: () => false,
      }),
    ).toThrow('Claude in Chrome CLI entrypoint not found.')
  })
})
