import { describe, expect, test } from 'bun:test'
import { requireInProcessMcpServer } from '../inProcessServerBoundary'

describe('requireInProcessMcpServer', () => {
  test('accepts a connectable in-process MCP server', () => {
    const server = {
      connect() {
        return undefined
      },
    }

    expect(
      requireInProcessMcpServer(
        'claude-in-chrome',
        server,
        '@ant/claude-for-chrome-mcp',
      ),
    ).toBe(server)
  })

  test('turns an incomplete in-process server into an explicit boundary error', () => {
    expect(() =>
      requireInProcessMcpServer(
        'claude-in-chrome',
        null,
        '@ant/claude-for-chrome-mcp',
      ),
    ).toThrow(
      'In-process MCP server "claude-in-chrome" is unavailable in this fork: @ant/claude-for-chrome-mcp returned a stubbed or incomplete implementation.',
    )
  })
})
