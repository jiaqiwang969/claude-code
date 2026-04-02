import { describe, expect, test } from 'bun:test'

import { buildMemoryEditorHint, openMemoryFile } from '../memory.js'

describe('buildMemoryEditorHint', () => {
  test('prefers VISUAL over EDITOR', () => {
    expect(buildMemoryEditorHint({ VISUAL: 'zed --wait', EDITOR: 'vim' })).toBe(
      '> Using $VISUAL="zed --wait". To change editor, set $EDITOR or $VISUAL environment variable.',
    )
  })

  test('falls back to EDITOR and then the default hint', () => {
    expect(buildMemoryEditorHint({ EDITOR: 'vim' })).toBe(
      '> Using $EDITOR="vim". To change editor, set $EDITOR or $VISUAL environment variable.',
    )
    expect(buildMemoryEditorHint({})).toBe(
      '> To use a different editor, set the $EDITOR or $VISUAL environment variable.',
    )
  })
})

describe('openMemoryFile', () => {
  test('creates the config directory for user memory and opens the editor', async () => {
    const calls: string[] = []
    const message = await openMemoryFile('/tmp/claude-config/CLAUDE.md', {
      claudeConfigHomeDir: '/tmp/claude-config',
      env: { VISUAL: 'zed --wait' },
      mkdirImpl: async (path, options) => {
        calls.push(`mkdir:${path}:${String(options?.recursive)}`)
      },
      writeFileImpl: async (path, data, options) => {
        calls.push(`write:${path}:${String(data)}:${String(options?.flag)}`)
      },
      editFileInEditorImpl: async (path) => {
        calls.push(`edit:${path}`)
      },
    })

    expect(calls).toEqual([
      'mkdir:/tmp/claude-config:true',
      'write:/tmp/claude-config/CLAUDE.md::wx',
      'edit:/tmp/claude-config/CLAUDE.md',
    ])
    expect(message).toContain('Opened memory file at /tmp/claude-config/CLAUDE.md')
    expect(message).toContain('Using $VISUAL="zed --wait"')
  })

  test('ignores EEXIST and still opens project memory in the editor', async () => {
    const calls: string[] = []
    const message = await openMemoryFile('/tmp/project/CLAUDE.md', {
      claudeConfigHomeDir: '/tmp/claude-config',
      env: {},
      mkdirImpl: async () => {
        calls.push('mkdir')
      },
      writeFileImpl: async () => {
        const error = new Error('already exists') as Error & { code?: string }
        error.code = 'EEXIST'
        throw error
      },
      editFileInEditorImpl: async (path) => {
        calls.push(`edit:${path}`)
      },
    })

    expect(calls).toEqual(['edit:/tmp/project/CLAUDE.md'])
    expect(message).toContain('Opened memory file at /tmp/project/CLAUDE.md')
    expect(message).toContain('To use a different editor')
  })

  test('rethrows unexpected file creation errors', async () => {
    await expect(
      openMemoryFile('/tmp/project/CLAUDE.md', {
        claudeConfigHomeDir: '/tmp/claude-config',
        writeFileImpl: async () => {
          const error = new Error('permission denied') as Error & { code?: string }
          error.code = 'EACCES'
          throw error
        },
        editFileInEditorImpl: async () => {},
      }),
    ).rejects.toThrow('permission denied')
  })
})
