import { z } from 'zod/v4'
import { buildTool } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { SLEEP_TOOL_NAME, DESCRIPTION, SLEEP_TOOL_PROMPT } from './prompt.js'

// Lazy-load to avoid circular dependency with proactive module
const isProactiveActive = (): boolean => {
  try {
    const mod = require('../../proactive/index.js')
    return mod.isProactiveActive()
  } catch {
    return false
  }
}

const inputSchema = lazySchema(() =>
  z.strictObject({
    duration_seconds: z
      .number()
      .min(1)
      .max(3600)
      .describe('How long to sleep in seconds (1-3600).'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    slept_seconds: z.number(),
    interrupted: z.boolean(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

export const SleepTool = buildTool({
  name: SLEEP_TOOL_NAME,
  searchHint: 'wait sleep pause idle',
  maxResultSizeChars: 1000,
  shouldDefer: false,
  interruptBehavior: 'cancel' as const,
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  isEnabled() {
    return isProactiveActive()
  },
  async description() {
    return DESCRIPTION
  },
  async prompt() {
    return SLEEP_TOOL_PROMPT
  },
  async call(
    { duration_seconds },
    { abortController },
  ) {
    const startTime = Date.now()
    const durationMs = duration_seconds * 1000

    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, durationMs)

        // Allow interruption via abort signal
        if (abortController?.signal) {
          if (abortController.signal.aborted) {
            clearTimeout(timer)
            resolve()
            return
          }
          abortController.signal.addEventListener(
            'abort',
            () => {
              clearTimeout(timer)
              resolve()
            },
            { once: true },
          )
        }
      })
    } catch {
      // Interrupted
    }

    const elapsed = (Date.now() - startTime) / 1000
    const interrupted = elapsed < duration_seconds - 0.5

    return {
      data: {
        slept_seconds: Math.round(elapsed),
        interrupted,
      },
      resultForAssistant: interrupted
        ? `Woke up after ${Math.round(elapsed)}s (interrupted by user).`
        : `Slept for ${Math.round(elapsed)}s.`,
    }
  },
  renderToolUseMessage(input: z.infer<InputSchema>) {
    return `Sleeping for ${input.duration_seconds}s...`
  },
  renderToolResultMessage(output: z.infer<OutputSchema>) {
    if (output.interrupted) {
      return `Woke up after ${output.slept_seconds}s (interrupted)`
    }
    return `Slept for ${output.slept_seconds}s`
  },
})
