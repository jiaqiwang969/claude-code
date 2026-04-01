import { constants as fsConstants } from 'node:fs'
import { access, readFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  getAllNativeMessagingHostsDirs,
  getAllSocketPaths,
} from './common.js'
import {
  detectExtensionInstallationPortable,
  getAllBrowserDataPathsPortable,
} from './setupPortable.js'
import type { BrowserPath, ChromiumBrowser } from './setupPortable.js'

const NATIVE_HOST_IDENTIFIER = 'com.anthropic.claude_code_browser_extension'

export type BrowserRootCheck = BrowserPath & {
  exists: boolean
}

export type ManifestCheck = {
  browser: string
  dir: string
  manifestPath: string
  exists: boolean
  binaryPath?: string
  binaryExists?: boolean
  binaryExecutable?: boolean
}

export type SocketCheck = {
  path: string
  exists: boolean
}

export type ExtensionDetectionResult = {
  isInstalled: boolean
  browser: ChromiumBrowser | null
}

export type ClaudeInChromeReadinessStatus =
  | 'ready'
  | 'no-browser-roots'
  | 'extension-missing'
  | 'manifest-missing'
  | 'manifest-invalid'
  | 'manifest-target-missing'
  | 'manifest-target-not-executable'
  | 'socket-missing'

export type ClaudeInChromeReadinessSummary = {
  ready: boolean
  status: ClaudeInChromeReadinessStatus
  browserRoots: BrowserRootCheck[]
  extension: ExtensionDetectionResult
  manifestChecks: ManifestCheck[]
  socketChecks: SocketCheck[]
}

type ReadinessDependencies = {
  browserPaths?: BrowserPath[]
  detectExtensionInstallation?: (
    browserPaths: BrowserPath[],
  ) => Promise<ExtensionDetectionResult>
  getNativeMessagingHostsDirs?: () => Array<{
    browser: ChromiumBrowser
    path: string
  }>
  getSocketPaths?: () => string[]
  pathExists?: (path: string) => Promise<boolean>
  pathExecutable?: (path: string) => Promise<boolean>
  readTextFile?: (path: string) => Promise<string>
}

async function defaultPathExists(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.F_OK)
    return true
  } catch {
    return false
  }
}

async function defaultPathExecutable(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.X_OK)
    return true
  } catch {
    return false
  }
}

async function readManifestBinaryPath(
  manifestPath: string,
  readTextFile: (path: string) => Promise<string>,
): Promise<string | undefined> {
  try {
    const raw = await readTextFile(manifestPath)
    const manifest = JSON.parse(raw) as { path?: unknown }
    return typeof manifest.path === 'string' ? manifest.path : undefined
  } catch {
    return undefined
  }
}

export function getManifestCheckStatus(
  check: ManifestCheck,
):
  | 'missing'
  | 'invalid-manifest'
  | 'broken-target'
  | 'not-executable'
  | 'present' {
  if (!check.exists) {
    return 'missing'
  }
  if (!check.binaryPath) {
    return 'invalid-manifest'
  }
  if (!check.binaryExists) {
    return 'broken-target'
  }
  if (!check.binaryExecutable) {
    return 'not-executable'
  }
  return 'present'
}

export function classifyClaudeInChromeReadiness(
  summary: Omit<ClaudeInChromeReadinessSummary, 'ready' | 'status'>,
): ClaudeInChromeReadinessStatus {
  if (!summary.browserRoots.some(root => root.exists)) {
    return 'no-browser-roots'
  }

  if (!summary.extension.isInstalled) {
    return 'extension-missing'
  }

  if (!summary.manifestChecks.some(check => check.exists)) {
    return 'manifest-missing'
  }

  if (
    !summary.manifestChecks.some(check => check.exists && Boolean(check.binaryPath))
  ) {
    return 'manifest-invalid'
  }

  if (
    !summary.manifestChecks.some(
      check => check.exists && check.binaryExists === true,
    )
  ) {
    return 'manifest-target-missing'
  }

  if (
    !summary.manifestChecks.some(
      check =>
        check.exists &&
        check.binaryExists === true &&
        check.binaryExecutable === true,
    )
  ) {
    return 'manifest-target-not-executable'
  }

  if (!summary.socketChecks.some(check => check.exists)) {
    return 'socket-missing'
  }

  return 'ready'
}

export async function collectClaudeInChromeReadinessSummary(
  dependencies: ReadinessDependencies = {},
): Promise<ClaudeInChromeReadinessSummary> {
  const browserPaths =
    dependencies.browserPaths ?? getAllBrowserDataPathsPortable()
  const detectExtensionInstallation =
    dependencies.detectExtensionInstallation ??
    detectExtensionInstallationPortable
  const nativeMessagingDirs =
    dependencies.getNativeMessagingHostsDirs?.() ??
    getAllNativeMessagingHostsDirs()
  const socketPaths = Array.from(
    new Set(
      dependencies.getSocketPaths?.() ??
        getAllSocketPaths(),
    ),
  )
  const pathExists = dependencies.pathExists ?? defaultPathExists
  const pathExecutable =
    dependencies.pathExecutable ?? defaultPathExecutable
  const readTextFile =
    dependencies.readTextFile ?? (path => readFile(path, 'utf8'))

  const browserRoots = await Promise.all(
    browserPaths.map(async entry => ({
      ...entry,
      exists: await pathExists(entry.path),
    })),
  )

  const extension = await detectExtensionInstallation(browserPaths)

  const manifestChecks = await Promise.all(
    nativeMessagingDirs.map(async ({ browser, path }) => {
      const manifestPath = join(path, NATIVE_HOST_IDENTIFIER + '.json')
      const exists = await pathExists(manifestPath)
      const binaryPath = exists
        ? await readManifestBinaryPath(manifestPath, readTextFile)
        : undefined
      const binaryExists = binaryPath
        ? await pathExists(binaryPath)
        : undefined
      const binaryExecutable =
        binaryExists === true
          ? process.platform === 'win32'
            ? true
            : await pathExecutable(binaryPath!)
          : undefined

      return {
        browser,
        dir: path,
        manifestPath,
        exists,
        binaryPath,
        binaryExists,
        binaryExecutable,
      }
    }),
  )

  const socketChecks = await Promise.all(
    socketPaths.map(async path => ({
      path,
      exists: await pathExists(path),
    })),
  )

  const summaryBase = {
    browserRoots,
    extension,
    manifestChecks,
    socketChecks,
  }
  const status = classifyClaudeInChromeReadiness(summaryBase)

  return {
    ...summaryBase,
    status,
    ready: status === 'ready',
  }
}
