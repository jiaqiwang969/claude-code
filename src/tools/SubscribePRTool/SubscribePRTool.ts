// SubscribePRTool — subscribe to GitHub PR status changes.
// Simplified implementation using gh CLI polling instead of webhooks.

import { z } from 'zod/v4'
import { execSync } from 'child_process'
import { buildTool } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { getKairosActive } from '../../bootstrap/state.js'

export const SUBSCRIBE_PR_TOOL_NAME = 'SubscribePR'

const inputSchema = lazySchema(() =>
  z.strictObject({
    repo: z
      .string()
      .describe('Repository in owner/name format (e.g. "anthropics/claude-code").'),
    pr_number: z
      .number()
      .int()
      .positive()
      .describe('Pull request number to subscribe to.'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    subscribed: z.boolean(),
    pr_title: z.string().optional(),
    pr_state: z.string().optional(),
    error: z.string().optional(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

export const SubscribePRTool = buildTool({
  name: SUBSCRIBE_PR_TOOL_NAME,
  searchHint: 'subscribe watch pull request PR github',
  maxResultSizeChars: 5000,
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
    return 'Subscribe to a GitHub pull request for status updates'
  },
  async prompt() {
    return `Subscribe to a GitHub pull request to monitor its status.

Uses the gh CLI to fetch PR information. After subscribing, use CronCreate
to set up periodic polling (e.g. every 5 minutes) to check for changes.

Example workflow:
1. SubscribePR(repo: "owner/repo", pr_number: 123)
2. CronCreate(cron: "*/5 * * * *", prompt: "Check PR #123 status on owner/repo")`
  },
  async call({ repo, pr_number }) {
    try {
      const result = execSync(
        `gh pr view ${pr_number} --repo ${repo} --json title,state,statusCheckRollup,mergeable,reviewDecision`,
        { timeout: 15000, encoding: 'utf8' },
      )

      const pr = JSON.parse(result)

      return {
        data: {
          subscribed: true,
          pr_title: pr.title,
          pr_state: pr.state,
        },
        resultForAssistant: `Subscribed to PR #${pr_number}: "${pr.title}" (${pr.state}). Mergeable: ${pr.mergeable ?? 'unknown'}. Review: ${pr.reviewDecision ?? 'pending'}. Set up a cron job to poll for changes.`,
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      // Check if gh CLI is available
      if (msg.includes('command not found') || msg.includes('ENOENT')) {
        return {
          data: { subscribed: false, error: 'gh CLI not installed' },
          resultForAssistant: 'Error: GitHub CLI (gh) is not installed. Install it with: brew install gh',
        }
      }
      return {
        data: { subscribed: false, error: msg },
        resultForAssistant: `Failed to subscribe to PR #${pr_number}: ${msg}`,
      }
    }
  },
  renderToolUseMessage(input: z.infer<InputSchema>) {
    return `Subscribing to ${input.repo}#${input.pr_number}`
  },
  renderToolResultMessage(output: z.infer<OutputSchema>) {
    if (output.subscribed) {
      return `Subscribed: ${output.pr_title} (${output.pr_state})`
    }
    return `Failed: ${output.error}`
  },
})
