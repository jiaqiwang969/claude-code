import { describe, expect, test } from 'bun:test'

import { BROWSER_TOOLS } from '../browserTools.js'
import { createClaudeForChromeMcpServer } from '../mcpServer.js'
import type { ClaudeForChromeContext, Logger } from '../types.js'

const logger: Logger = {
  info() {},
  error() {},
  warn() {},
  debug() {},
  silly() {},
}

function createContext(
  overrides: Partial<ClaudeForChromeContext> = {},
): ClaudeForChromeContext {
  return {
    serverName: 'test-chrome-mcp',
    logger,
    socketPath: '/tmp/claude-in-chrome.sock',
    clientTypeId: 'claude-code',
    onToolCallDisconnected: () => 'disconnected',
    onAuthenticationError() {},
    getSocketPaths: () => ['/tmp/claude-in-chrome.sock'],
    ...overrides,
  }
}

async function listToolNames(
  context: ClaudeForChromeContext,
): Promise<string[]> {
  const server = createClaudeForChromeMcpServer(context)
  const handler = (server as any)._requestHandlers.get('tools/list')
  const result = await handler({ method: 'tools/list', params: {} })
  return result.tools.map((tool: { name: string }) => tool.name)
}

describe('createClaudeForChromeMcpServer', () => {
  test('lists local socket tools without switch_browser', async () => {
    const names = await listToolNames(createContext())

    expect(names).toHaveLength(BROWSER_TOOLS.length - 1)
    expect(names).not.toContain('switch_browser')
    expect(names).toContain('tabs_context_mcp')
  })

  test('lists all browser tools when bridge mode is enabled', async () => {
    const names = await listToolNames(
      createContext({
        bridgeConfig: {
          url: 'ws://localhost:8765',
          getUserId: async () => undefined,
          getOAuthToken: async () => undefined,
        },
      }),
    )

    expect(names).toHaveLength(BROWSER_TOOLS.length)
    expect(names).toContain('switch_browser')
  })

  test('returns no tools when the chrome integration is disabled', async () => {
    const names = await listToolNames(
      createContext({
        isDisabled: () => true,
      }),
    )

    expect(names).toEqual([])
  })
})
