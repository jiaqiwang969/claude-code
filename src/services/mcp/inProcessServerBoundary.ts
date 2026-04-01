import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'

export type ConnectableInProcessMcpServer = {
  connect(transport: Transport): Promise<void> | void
}

function isConnectableInProcessMcpServer(
  candidate: unknown,
): candidate is ConnectableInProcessMcpServer {
  return (
    typeof candidate === 'object' &&
    candidate !== null &&
    'connect' in candidate &&
    typeof (candidate as { connect?: unknown }).connect === 'function'
  )
}

export function requireInProcessMcpServer(
  serverName: string,
  server: unknown,
  source: string,
): ConnectableInProcessMcpServer {
  if (isConnectableInProcessMcpServer(server)) {
    return server
  }

  throw new Error(
    `In-process MCP server "${serverName}" is unavailable in this fork: ${source} returned a stubbed or incomplete implementation.`,
  )
}
