import { BROWSER_TOOLS } from '@ant/claude-for-chrome-mcp'

export function hasClaudeInChromeMcpImplementation(): boolean {
  return BROWSER_TOOLS.length > 0
}

export function requireClaudeInChromeMcpImplementation(): void {
  if (hasClaudeInChromeMcpImplementation()) {
    return
  }

  throw new Error(
    '@ant/claude-for-chrome-mcp is present but does not expose any browser tools in this workspace build.',
  )
}
