// PushNotificationTool — sends a local push notification to the user.
// Uses macOS osascript for native notifications.

import { z } from 'zod/v4'
import { execSync } from 'child_process'
import { buildTool } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { getKairosActive } from '../../bootstrap/state.js'

export const PUSH_NOTIFICATION_TOOL_NAME = 'PushNotification'

const inputSchema = lazySchema(() =>
  z.strictObject({
    title: z.string().describe('Notification title.'),
    body: z.string().describe('Notification body text.'),
    sound: z
      .boolean()
      .optional()
      .describe('Play a sound with the notification (default: true).'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    sent: z.boolean(),
    error: z.string().optional(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

export const PushNotificationTool = buildTool({
  name: PUSH_NOTIFICATION_TOOL_NAME,
  searchHint: 'notify alert push notification',
  maxResultSizeChars: 1000,
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
    return 'Send a push notification to the user'
  },
  async prompt() {
    return `Send a local push notification to the user's desktop.

Use this when:
- A long-running task completes while the user may be away
- You hit a blocker that needs user attention
- An important event occurs (CI failure, PR merged, etc.)

Keep titles short (<50 chars) and bodies concise (<200 chars).`
  },
  async call({ title, body, sound = true }) {
    try {
      const escapedTitle = title.replace(/"/g, '\\"')
      const escapedBody = body.replace(/"/g, '\\"')
      const soundParam = sound ? 'sound name "default"' : ''

      if (process.platform === 'darwin') {
        execSync(
          `osascript -e 'display notification "${escapedBody}" with title "${escapedTitle}" ${soundParam}'`,
          { timeout: 5000 },
        )
      } else if (process.platform === 'linux') {
        execSync(`notify-send "${escapedTitle}" "${escapedBody}"`, {
          timeout: 5000,
        })
      } else {
        return {
          data: { sent: false, error: 'Unsupported platform' },
          resultForAssistant: `Push notification not supported on ${process.platform}`,
        }
      }

      return {
        data: { sent: true },
        resultForAssistant: `Notification sent: "${title}"`,
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      return {
        data: { sent: false, error: msg },
        resultForAssistant: `Failed to send notification: ${msg}`,
      }
    }
  },
  renderToolUseMessage(input: z.infer<InputSchema>) {
    return `Sending notification: ${input.title}`
  },
  renderToolResultMessage(output: z.infer<OutputSchema>) {
    return output.sent ? 'Notification sent' : `Failed: ${output.error}`
  },
})
