// KAIROS assistant module — core entry point for autonomous agent mode.
//
// Original implementation was removed by dead code elimination in the
// external build. This is a functional reconstruction based on:
// - main.tsx call sites (lines 79, 1050-1087, 2216-2219, 3270-3365)
// - proactive mode patterns (src/proactive/index.ts)
// - constants/prompts.ts proactive prompt (line 867-879)

import { isEnvTruthy } from '../utils/envUtils.js'
import { setKairosActive } from '../bootstrap/state.js'

let _assistantMode = false
let _assistantForced = false

/**
 * Check if we're running in assistant/KAIROS mode.
 * True when: --assistant flag passed, or CLAUDE_CODE_KAIROS=1 env var set.
 */
export function isAssistantMode(): boolean {
  if (_assistantMode) return true
  // Auto-detect from env var
  if (isEnvTruthy(process.env.CLAUDE_CODE_KAIROS)) {
    _assistantMode = true
    return true
  }
  return false
}

/**
 * Mark assistant mode as forced (--assistant CLI flag).
 * Called by main.tsx when the daemon passes --assistant.
 */
export function markAssistantForced(): void {
  _assistantForced = true
  _assistantMode = true
}

/**
 * Check if assistant mode was explicitly forced via --assistant flag.
 */
export function isAssistantForced(): boolean {
  return _assistantForced
}

/**
 * Initialize the in-process assistant team context.
 * Pre-seeds a team so Agent(name: "foo") spawns teammates without TeamCreate.
 */
export async function initializeAssistantTeam(): Promise<void> {
  // In the original implementation, this called setCliTeammateModeOverride()
  // and set up an in-process team. For now, we just activate KAIROS state.
  setKairosActive(true)
}

/**
 * Get the system prompt addendum for assistant mode.
 * Appended to the system prompt when KAIROS is active.
 */
export function getAssistantSystemPromptAddendum(): string {
  return `# KAIROS Assistant Mode

You are running as a persistent autonomous assistant. Key behaviors:

- You persist across sessions and maintain long-term memory via daily logs.
- Use the Sleep tool when idle — it's cheaper than busy-waiting.
- Proactively check for work: pending PRs, failing CI, stale branches.
- When you complete a task, send a brief summary via SendUserMessage.
- Record important decisions and context in today's daily log.
- If you hit a blocker, notify the user and move to the next task.

You will receive periodic <tick> prompts — treat them as "you're awake, what now?"
Check your task list, look for new work, or sleep if there's nothing to do.`
}

/**
 * Get the activation path for analytics/logging.
 */
export function getAssistantActivationPath(): string | undefined {
  if (_assistantForced) return 'cli-flag'
  if (isEnvTruthy(process.env.CLAUDE_CODE_KAIROS)) return 'env-var'
  return 'gate'
}
