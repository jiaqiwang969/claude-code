import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { afterEach, describe, expect, test } from 'bun:test'

import type { BrowserPath } from '../setupPortable.js'
import { detectExtensionInstallationPortable } from '../setupPortable.js'

const PROD_EXTENSION_ID = 'fcoeoabgfenejglbffodgkkbkcdhcgfn'
const DEV_EXTENSION_ID = 'dihbgbndebgnbjfmelmegjepbnkhlgni'

const tempDirs: string[] = []
const originalUserType = process.env.USER_TYPE

afterEach(async () => {
  process.env.USER_TYPE = originalUserType

  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) {
      await rm(dir, { recursive: true, force: true })
    }
  }
})

async function makeBrowserRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'claude-in-chrome-portable-'))
  tempDirs.push(dir)
  return dir
}

async function installExtensionAtProfile(
  browserRoot: string,
  profileName: string,
  extensionId: string,
): Promise<void> {
  await mkdir(join(browserRoot, profileName, 'Extensions', extensionId, '1.0.0'), {
    recursive: true,
  })
}

async function installOperaRootExtension(
  browserRoot: string,
  extensionId: string,
): Promise<void> {
  await mkdir(join(browserRoot, 'Extensions', extensionId, '1.0.0'), {
    recursive: true,
  })
}

describe('detectExtensionInstallationPortable', () => {
  test('returns false when the supported extension IDs are absent', async () => {
    const browserRoot = await makeBrowserRoot()
    await mkdir(join(browserRoot, 'Default', 'Extensions', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'), {
      recursive: true,
    })

    const result = await detectExtensionInstallationPortable([
      { browser: 'chrome', path: browserRoot },
    ])

    expect(result).toEqual({ isInstalled: false, browser: null })
  })

  test('detects the production extension inside a Chromium profile directory', async () => {
    const browserRoot = await makeBrowserRoot()
    await installExtensionAtProfile(browserRoot, 'Default', PROD_EXTENSION_ID)

    const result = await detectExtensionInstallationPortable([
      { browser: 'chrome', path: browserRoot },
    ])

    expect(result).toEqual({ isInstalled: true, browser: 'chrome' })
  })

  test('detects internal dev extension IDs when USER_TYPE=ant', async () => {
    process.env.USER_TYPE = 'ant'
    const browserRoot = await makeBrowserRoot()
    await installExtensionAtProfile(browserRoot, 'Profile 3', DEV_EXTENSION_ID)

    const result = await detectExtensionInstallationPortable([
      { browser: 'chrome', path: browserRoot },
    ])

    expect(result).toEqual({ isInstalled: true, browser: 'chrome' })
  })

  test('detects Opera installs that store Extensions directly under the browser root', async () => {
    const browserRoot = await makeBrowserRoot()
    await installOperaRootExtension(browserRoot, PROD_EXTENSION_ID)

    const result = await detectExtensionInstallationPortable([
      { browser: 'opera', path: browserRoot },
    ])

    expect(result).toEqual({ isInstalled: true, browser: 'opera' })
  })

  test('skips missing browser roots instead of throwing', async () => {
    const missingRoot = join(tmpdir(), 'claude-in-chrome-missing-root')
    const browserPaths: BrowserPath[] = [{ browser: 'chrome', path: missingRoot }]

    const result = await detectExtensionInstallationPortable(browserPaths)

    expect(result).toEqual({ isInstalled: false, browser: null })
  })
})
