#!/usr/bin/env bun

import {
  collectClaudeInChromeReadinessSummary,
  getManifestCheckStatus,
} from '../src/utils/claudeInChrome/readiness.ts'

function printSection(title: string): void {
  console.log('')
  console.log(title)
  console.log('-'.repeat(title.length))
}

const summary = await collectClaudeInChromeReadinessSummary()
const existingBrowserRoots = summary.browserRoots.filter(entry => entry.exists)

console.log('Claude in Chrome readiness check')
console.log('================================')
console.log('Result: ' + (summary.ready ? 'READY' : 'NOT READY'))

printSection('Browser data roots')
if (existingBrowserRoots.length === 0) {
  console.log('No supported Chromium browser data directories found.')
} else {
  for (const entry of existingBrowserRoots) {
    console.log('[' + entry.browser + '] ' + entry.path)
  }
}

printSection('Extension detection')
console.log(
  summary.extension.isInstalled
    ? 'Installed in ' + summary.extension.browser
    : 'Claude browser extension not found in supported browser profiles',
)

printSection('Native host manifests')
for (const check of summary.manifestChecks) {
  const status = getManifestCheckStatus(check)
  const binary = check.binaryPath
    ? ' -> ' +
      check.binaryPath +
      (check.binaryExists === false
        ? ' (missing target)'
        : check.binaryExecutable === false
          ? ' (not executable)'
          : '')
    : ''
  console.log(
    '[' + check.browser + '] ' + status + ': ' + check.manifestPath + binary,
  )
}

printSection('Native sockets')
if (summary.socketChecks.some(check => check.exists)) {
  for (const check of summary.socketChecks) {
    if (!check.exists) continue
    console.log('connected: ' + check.path)
  }
} else {
  console.log('No live browser bridge sockets detected')
}

process.exit(summary.ready ? 0 : 1)
