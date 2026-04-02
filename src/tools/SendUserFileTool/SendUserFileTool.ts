// SendUserFileTool — sends a file to the user with an optional message.
// Leverages BriefTool's attachment infrastructure.

import { z } from 'zod/v4'
import { statSync, readFileSync } from 'fs'
import { basename, resolve, extname } from 'path'
import { buildTool } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { getKairosActive } from '../../bootstrap/state.js'
import { getCwd } from '../../utils/cwd.js'

export const SEND_USER_FILE_TOOL_NAME = 'SendUserFile'

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico'])

const inputSchema = lazySchema(() =>
  z.strictObject({
    file_path: z
      .string()
      .describe('Absolute or relative path to the file to send.'),
    message: z
      .string()
      .optional()
      .describe('Optional message to accompany the file.'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    path: z.string(),
    size: z.number(),
    isImage: z.boolean(),
    message: z.string().optional(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

export const SendUserFileTool = buildTool({
  name: SEND_USER_FILE_TOOL_NAME,
  searchHint: 'send file to user screenshot log attachment',
  maxResultSizeChars: 10_000,
  shouldDefer: false,
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  isEnabled() {
    return getKairosActive()
  },
  async description() {
    return 'Send a file to the user (screenshot, log, diff, etc.)'
  },
  async prompt() {
    return `Send a file to the user with an optional message. Use for photos, screenshots, diffs, logs, or any file the user should see.

The file path can be absolute or relative to the current working directory.`
  },
  async call({ file_path, message }) {
    const resolvedPath = resolve(getCwd(), file_path)

    try {
      const stat = statSync(resolvedPath)
      const ext = extname(resolvedPath).toLowerCase()
      const isImage = IMAGE_EXTENSIONS.has(ext)

      return {
        data: {
          path: resolvedPath,
          size: stat.size,
          isImage,
          message,
        },
        resultForAssistant: `Sent file: ${basename(resolvedPath)} (${stat.size} bytes${isImage ? ', image' : ''})${message ? ` — ${message}` : ''}`,
      }
    } catch (error) {
      return {
        data: {
          path: resolvedPath,
          size: 0,
          isImage: false,
          message: `Error: file not found or not readable`,
        },
        resultForAssistant: `Error: could not read file at ${resolvedPath}`,
      }
    }
  },
  renderToolUseMessage(input: z.infer<InputSchema>) {
    return `Sending file: ${input.file_path}`
  },
  renderToolResultMessage(output: z.infer<OutputSchema>) {
    return `Sent: ${basename(output.path)} (${output.size} bytes)`
  },
})
