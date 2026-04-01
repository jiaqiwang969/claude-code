#!/usr/bin/env bun

import { spawn } from 'child_process'
import { access, cp, mkdir } from 'fs/promises'
import { constants as fsConstants } from 'node:fs'
import { join } from 'path'

import { getAllNativeMessagingHostsDirs } from '../src/utils/claudeInChrome/common.ts'
import {
  getIsolatedChromeProfilePaths,
  getOfficialClaudeExtensionPaths,
} from '../src/utils/claudeInChrome/officialExtension.ts'
import { which } from '../src/utils/which.ts'

async function resolveChromeExecutable(): Promise<string> {
  switch (process.platform) {
    case 'darwin':
      return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    case 'linux': {
      const chrome =
        (await which('google-chrome')) ??
        (await which('google-chrome-stable')) ??
        (await which('chromium')) ??
        (await which('chromium-browser'))
      if (chrome) {
        return chrome
      }
      break
    }
  }

  throw Error(
    'Direct unpacked launch helper currently supports macOS and Linux Chrome-family binaries only',
  )
}

const extensionPaths = getOfficialClaudeExtensionPaths()
const profilePaths = getIsolatedChromeProfilePaths(
  process.env.CLAUDE_CHROME_PROFILE_NAME || 'direct-profile',
)
const manifestPath = join(extensionPaths.unpackedDir, 'manifest.json')

await access(manifestPath, fsConstants.F_OK).catch(() => {
  throw Error(
    'Official unpacked extension not found. Run bun run claude-in-chrome:download-extension first.',
  )
})

const chromeNativeHostDir = getAllNativeMessagingHostsDirs().find(
  entry => entry.browser === 'chrome',
)?.path

if (!chromeNativeHostDir) {
  throw Error('Google Chrome native messaging host directory not found')
}

const sourceNativeHostManifest = join(
  chromeNativeHostDir,
  'com.anthropic.claude_code_browser_extension.json',
)

await access(sourceNativeHostManifest, fsConstants.F_OK).catch(() => {
  throw Error(
    'Chrome native host manifest is missing. Run bun run claude-in-chrome:install-host first.',
  )
})

await mkdir(profilePaths.nativeMessagingHostsDir, { recursive: true })
await cp(sourceNativeHostManifest, profilePaths.nativeHostManifestPath)

const chromeExecutable = await resolveChromeExecutable()
const openUrl = process.env.CLAUDE_CHROME_OPEN_URL || 'https://claude.ai/chrome'
const args = [
  `--user-data-dir=${profilePaths.profileDir}`,
  '--no-first-run',
  '--no-default-browser-check',
  `--disable-extensions-except=${extensionPaths.unpackedDir}`,
  `--load-extension=${extensionPaths.unpackedDir}`,
  '--new-window',
]

const remoteDebuggingPort = process.env.CLAUDE_CHROME_REMOTE_DEBUGGING_PORT
if (remoteDebuggingPort) {
  args.push(`--remote-debugging-port=${remoteDebuggingPort}`)
}

args.push(openUrl)

const child = spawn(chromeExecutable, args, {
  detached: true,
  stdio: 'ignore',
})
child.unref()

console.log('Launched Google Chrome with unpacked official Claude extension')
console.log('Chrome: ' + chromeExecutable)
console.log('Profile: ' + profilePaths.profileDir)
console.log('Profile manifest: ' + profilePaths.nativeHostManifestPath)
console.log('Extension: ' + extensionPaths.unpackedDir)
console.log('URL: ' + openUrl)
if (remoteDebuggingPort) {
  console.log(
    'Remote debugging: http://127.0.0.1:' + remoteDebuggingPort + '/json/version',
  )
}
console.log('')
console.log(
  'Note: this helper launches an unpacked runtime extension. The readiness check still focuses on persisted profile installs plus live sockets, so extension detection may remain negative until the browser runtime fully connects.',
)
