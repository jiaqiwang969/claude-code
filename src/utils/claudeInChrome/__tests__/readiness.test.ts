import { describe, expect, test } from 'bun:test'

import {
  classifyClaudeInChromeReadiness,
  collectClaudeInChromeReadinessSummary,
  getManifestCheckStatus,
} from '../readiness.js'

const NATIVE_HOST_IDENTIFIER = 'com.anthropic.claude_code_browser_extension'

function makeDependencies({
  browserRootExists = true,
  extensionInstalled = true,
  manifestExists = true,
  manifestJson = JSON.stringify({ path: '/wrapper' }),
  wrapperExists = true,
  wrapperExecutable = true,
  socketExists = true,
}: {
  browserRootExists?: boolean
  extensionInstalled?: boolean
  manifestExists?: boolean
  manifestJson?: string
  wrapperExists?: boolean
  wrapperExecutable?: boolean
  socketExists?: boolean
} = {}) {
  const manifestPath =
    '/native-hosts/' + NATIVE_HOST_IDENTIFIER + '.json'

  return {
    browserPaths: [{ browser: 'chrome' as const, path: '/browser-root' }],
    detectExtensionInstallation: async () => ({
      isInstalled: extensionInstalled,
      browser: extensionInstalled ? ('chrome' as const) : null,
    }),
    getNativeMessagingHostsDirs: () => [
      { browser: 'chrome' as const, path: '/native-hosts' },
    ],
    getSocketPaths: () => ['/socket-a'],
    pathExists: async (path: string) => {
      if (path === '/browser-root') return browserRootExists
      if (path === manifestPath) return manifestExists
      if (path === '/wrapper') return wrapperExists
      if (path === '/socket-a') return socketExists
      return false
    },
    pathExecutable: async (path: string) =>
      path === '/wrapper' ? wrapperExecutable : false,
    readTextFile: async (path: string) => {
      if (path === manifestPath) return manifestJson
      throw new Error('unexpected path: ' + path)
    },
  }
}

describe('classifyClaudeInChromeReadiness', () => {
  test('returns no-browser-roots when no supported browser data roots exist', async () => {
    const summary = await collectClaudeInChromeReadinessSummary(
      makeDependencies({ browserRootExists: false }),
    )

    expect(summary.status).toBe('no-browser-roots')
    expect(summary.ready).toBe(false)
  })

  test('returns extension-missing when the browser extension is absent', async () => {
    const summary = await collectClaudeInChromeReadinessSummary(
      makeDependencies({ extensionInstalled: false }),
    )

    expect(summary.status).toBe('extension-missing')
  })

  test('returns manifest-missing when no native host manifest is present', async () => {
    const summary = await collectClaudeInChromeReadinessSummary(
      makeDependencies({ manifestExists: false }),
    )

    expect(summary.status).toBe('manifest-missing')
  })

  test('returns manifest-invalid when the manifest does not expose a path', async () => {
    const summary = await collectClaudeInChromeReadinessSummary(
      makeDependencies({ manifestJson: '{}' }),
    )

    expect(summary.status).toBe('manifest-invalid')
  })

  test('returns manifest-target-missing when the wrapper target is gone', async () => {
    const summary = await collectClaudeInChromeReadinessSummary(
      makeDependencies({ wrapperExists: false }),
    )

    expect(summary.status).toBe('manifest-target-missing')
  })

  test('returns manifest-target-not-executable when the wrapper is not executable', async () => {
    const summary = await collectClaudeInChromeReadinessSummary(
      makeDependencies({ wrapperExecutable: false }),
    )

    expect(summary.status).toBe('manifest-target-not-executable')
  })

  test('returns socket-missing when the extension is installed but no live socket exists', async () => {
    const summary = await collectClaudeInChromeReadinessSummary(
      makeDependencies({ socketExists: false }),
    )

    expect(summary.status).toBe('socket-missing')
    expect(summary.ready).toBe(false)
  })

  test('returns ready when browser roots, extension, manifest, wrapper, and socket all exist', async () => {
    const summary = await collectClaudeInChromeReadinessSummary(
      makeDependencies(),
    )

    expect(summary.status).toBe('ready')
    expect(summary.ready).toBe(true)
  })

  test('classifies manifest checks for human-readable reporting', () => {
    expect(
      getManifestCheckStatus({
        browser: 'chrome',
        dir: '/native-hosts',
        manifestPath: '/native-hosts/manifest.json',
        exists: true,
        binaryPath: '/wrapper',
        binaryExists: true,
        binaryExecutable: true,
      }),
    ).toBe('present')

    expect(
      getManifestCheckStatus({
        browser: 'chrome',
        dir: '/native-hosts',
        manifestPath: '/native-hosts/manifest.json',
        exists: true,
        binaryPath: '/wrapper',
        binaryExists: false,
        binaryExecutable: undefined,
      }),
    ).toBe('broken-target')

    expect(
      classifyClaudeInChromeReadiness({
        browserRoots: [{ browser: 'chrome', path: '/browser-root', exists: true }],
        extension: { isInstalled: true, browser: 'chrome' },
        manifestChecks: [
          {
            browser: 'chrome',
            dir: '/native-hosts',
            manifestPath: '/native-hosts/manifest.json',
            exists: true,
            binaryPath: '/wrapper',
            binaryExists: true,
            binaryExecutable: true,
          },
        ],
        socketChecks: [{ path: '/socket-a', exists: true }],
      }),
    ).toBe('ready')
  })
})
