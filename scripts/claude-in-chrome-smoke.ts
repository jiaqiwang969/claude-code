#!/usr/bin/env bun

import { createChromeSocketClient } from '@ant/claude-for-chrome-mcp'

import { getAllSocketPaths, getSecureSocketPath } from '../src/utils/claudeInChrome/common.ts'
import {
  detectExtensionInstallationPortable,
  getAllBrowserDataPathsPortable,
} from '../src/utils/claudeInChrome/setupPortable.ts'

type TextContent = { type?: unknown; text?: unknown }

const logger = {
  info() {},
  error() {},
  warn() {},
  debug() {},
  silly() {},
}

function extractAvailableTabs(result: unknown): Array<{
  tabId: number
  title?: string
  url?: string
}> {
  if (!result || typeof result !== 'object') return []

  const response = result as {
    result?: { content?: TextContent[] }
  }
  const content = response.result?.content
  if (!Array.isArray(content)) return []

  for (const item of content) {
    if (item?.type !== 'text' || typeof item.text !== 'string') continue
    try {
      const parsed = JSON.parse(item.text) as {
        availableTabs?: Array<{ tabId: number; title?: string; url?: string }>
      }
      if (Array.isArray(parsed.availableTabs)) {
        return parsed.availableTabs
      }
    } catch {
      // Ignore non-JSON text segments.
    }
  }

  return []
}

const browserPaths = getAllBrowserDataPathsPortable()
const extension = await detectExtensionInstallationPortable(browserPaths)
if (!extension.isInstalled) {
  console.error(
    'Claude in Chrome extension not detected. Install it from https://claude.ai/chrome and restart Chrome, then rerun this smoke.',
  )
  process.exit(1)
}

const socketClient = createChromeSocketClient({
  serverName: 'claude-in-chrome-smoke',
  logger,
  socketPath: getSecureSocketPath(),
  getSocketPaths: getAllSocketPaths,
  clientTypeId: 'claude-code',
  onToolCallDisconnected: () => 'Browser extension is not connected',
  onAuthenticationError: () => {
    throw Error(
      'Chrome extension authentication failed. Ensure Chrome is logged into the same claude.ai account as Claude Code.',
    )
  },
})

try {
  await socketClient.ensureConnected()
} catch (error) {
  console.error(
    'Chrome extension is installed but no native socket is connected. Restart Chrome and ensure the extension is active, then rerun this smoke.',
  )
  if (error instanceof Error) {
    console.error(error.message)
  }
  process.exit(1)
}

const initialContext = await socketClient.callTool('tabs_context_mcp', {
  createIfEmpty: true,
})
const initialTabs = extractAvailableTabs(initialContext)

console.log('Initial tabs: ' + initialTabs.length)
for (const tab of initialTabs) {
  console.log(
    '- tabId ' + tab.tabId + ': ' + (tab.title || '(untitled)') + ' ' + (tab.url || ''),
  )
}

await socketClient.callTool('tabs_create_mcp', {})

const updatedContext = await socketClient.callTool('tabs_context_mcp', {})
const updatedTabs = extractAvailableTabs(updatedContext)

console.log('Updated tabs: ' + updatedTabs.length)
for (const tab of updatedTabs) {
  console.log(
    '- tabId ' + tab.tabId + ': ' + (tab.title || '(untitled)') + ' ' + (tab.url || ''),
  )
}

if (updatedTabs.length < initialTabs.length) {
  console.error(
    'tabs_create_mcp did not preserve tab context as expected. Recheck the extension/runtime state.',
  )
  process.exit(1)
}

console.log('Claude in Chrome smoke passed')
