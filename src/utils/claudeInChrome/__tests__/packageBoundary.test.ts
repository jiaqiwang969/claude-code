import { describe, expect, test } from 'bun:test'
import { BROWSER_TOOLS } from '@ant/claude-for-chrome-mcp'
import {
  hasClaudeInChromeMcpImplementation,
  requireClaudeInChromeMcpImplementation,
} from '../packageBoundary'

describe('Claude in Chrome package boundary', () => {
  test('detects that the current workspace package exposes browser tools', () => {
    expect(BROWSER_TOOLS.length).toBeGreaterThan(0)
    expect(hasClaudeInChromeMcpImplementation()).toBe(true)
  })

  test('accepts the restored package without throwing', () => {
    expect(() => requireClaudeInChromeMcpImplementation()).not.toThrow()
  })
})
