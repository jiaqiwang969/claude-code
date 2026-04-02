import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { loadTranscriptFromFile } from '../sessionStorage.js'

describe('loadTranscriptFromFile', () => {
  test('loads jsonl transcripts that have no file history snapshots', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'session-storage-test-'))
    const filePath = join(dir, 'session.jsonl')
    const sessionId = '00000000-0000-4000-8000-000000000000'
    const userUuid = '00000000-0000-4000-8000-000000000001'
    const assistantUuid = '00000000-0000-4000-8000-000000000002'

    const lines = [
      JSON.stringify({
        parentUuid: null,
        isSidechain: false,
        promptId: 'prompt-1',
        type: 'user',
        message: {
          role: 'user',
          content: 'Remember this token for later: TEST_TOKEN',
        },
        uuid: userUuid,
        timestamp: '2026-04-02T00:00:00.000Z',
        permissionMode: 'bypassPermissions',
        userType: 'ant',
        entrypoint: 'sdk-cli',
        cwd: '/tmp/project',
        sessionId,
        version: '2.1.88',
      }),
      JSON.stringify({
        parentUuid: userUuid,
        isSidechain: false,
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'TEST_TOKEN' }],
          id: 'msg_test_1',
          model: 'claude-sonnet-4-6',
          stop_reason: 'end_turn',
          stop_sequence: null,
          type: 'message',
          usage: {
            input_tokens: 1,
            output_tokens: 1,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
            server_tool_use: {
              web_search_requests: 0,
              web_fetch_requests: 0,
            },
            service_tier: 'standard',
            cache_creation: {
              ephemeral_1h_input_tokens: 0,
              ephemeral_5m_input_tokens: 0,
            },
            inference_geo: '',
            iterations: [],
            speed: 'standard',
          },
        },
        uuid: assistantUuid,
        timestamp: '2026-04-02T00:00:01.000Z',
        userType: 'ant',
        entrypoint: 'sdk-cli',
        cwd: '/tmp/project',
        sessionId,
        version: '2.1.88',
      }),
    ]

    await writeFile(filePath, lines.join('\n') + '\n', 'utf8')

    try {
      const log = await loadTranscriptFromFile(filePath)
      expect(log.messages).toHaveLength(2)
      expect(log.fileHistorySnapshots).toEqual([])
      expect(log.firstPrompt).toBe('Remember this token for later: TEST_TOKEN')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
