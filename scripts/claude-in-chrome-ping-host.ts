#!/usr/bin/env bun

import { spawn } from 'child_process'
import { access, readdir } from 'fs/promises'
import { constants as fsConstants } from 'node:fs'
import { homedir } from 'os'
import { join } from 'path'

import { getSecureSocketPath, getSocketDir } from '../src/utils/claudeInChrome/common.ts'

function readChromeMessage(buffer: Buffer): unknown {
  if (buffer.length < 4) {
    throw Error('Native host response was shorter than the Chrome framing header')
  }

  const bodyLength = buffer.readUInt32LE(0)
  if (buffer.length < 4 + bodyLength) {
    throw Error('Native host response body was incomplete')
  }
  const body = buffer.subarray(4, 4 + bodyLength).toString('utf8')
  return JSON.parse(body)
}

const hostWrapperPath = join(homedir(), '.claude', 'chrome', 'chrome-native-host')
await access(hostWrapperPath, fsConstants.X_OK).catch(() => {
  throw Error(
    'Claude in Chrome native host wrapper is missing or not executable. Run bun run claude-in-chrome:install-host first.',
  )
})

const socketPath = getSecureSocketPath()
const socketDir = getSocketDir()
const host = spawn(hostWrapperPath, [], {
  stdio: ['pipe', 'pipe', 'pipe'],
})

let stdoutBuffer = Buffer.alloc(0)
let stderrText = ''
let sawSocket = false

host.stdout.on('data', chunk => {
  stdoutBuffer = Buffer.concat([stdoutBuffer, Buffer.from(chunk)])
})
host.stderr.on('data', chunk => {
  stderrText += chunk.toString('utf8')
})

const pollSocket = setInterval(() => {
  void readdir(socketDir)
    .then(() => {
      sawSocket = true
    })
    .catch(() => {})
}, 50)

const pingPayload = Buffer.from(JSON.stringify({ type: 'ping' }), 'utf8')
const lengthPrefix = Buffer.alloc(4)
lengthPrefix.writeUInt32LE(pingPayload.length, 0)
host.stdin.write(lengthPrefix)
host.stdin.write(pingPayload)

const response = await new Promise<unknown>((resolve, reject) => {
  let settled = false
  const timeout = setTimeout(() => {
    if (!settled) {
      settled = true
      reject(Error('Timed out waiting for native host pong'))
    }
  }, 5000)

  const settle = (callback: () => void) => {
    if (settled) {
      return
    }
    settled = true
    clearTimeout(timeout)
    clearInterval(pollSocket)
    callback()
  }

  const tryResolveFromStdout = () => {
    try {
      const payload = readChromeMessage(stdoutBuffer)
      settle(() => resolve(payload))
      host.stdin.end()
      setTimeout(() => {
        host.kill('SIGTERM')
      }, 50)
    } catch {
      // Keep buffering until a full framed message arrives.
    }
  }

  host.on('error', error => {
    settle(() => reject(error))
  })

  host.stdout.on('data', () => {
    tryResolveFromStdout()
  })

  host.on('close', () => {
    try {
      settle(() => resolve(readChromeMessage(stdoutBuffer)))
    } catch (error) {
      settle(() => reject(error))
    }
  })
})

if (
  !response ||
  typeof response !== 'object' ||
  (response as { type?: unknown }).type !== 'pong'
) {
  throw Error('Native host did not return a pong response')
}

const observedSocketCreation =
  sawSocket || stderrText.includes('Creating socket listener:')

console.log('Claude in Chrome native host ping passed')
console.log('Wrapper: ' + hostWrapperPath)
console.log('Secure socket path (current process): ' + socketPath)
console.log('Socket directory: ' + socketDir)
console.log(
  'Observed socket creation: ' + (observedSocketCreation ? 'yes' : 'no'),
)
console.log('Response: ' + JSON.stringify(response))
if (stderrText.trim()) {
  console.log('Host log:')
  console.log(stderrText.trim())
}
