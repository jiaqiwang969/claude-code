// KAIROS gate — determines whether KAIROS assistant mode is available.
// Simplified from original: checks env var + always returns true for local builds.

import { isEnvTruthy } from '../utils/envUtils.js'

/**
 * Check if KAIROS assistant mode is enabled.
 * Original implementation checked GrowthBook `tengu_kairos` flag + env vars.
 * For our local build, we enable it when:
 * 1. CLAUDE_CODE_KAIROS=1 env var is set, OR
 * 2. --assistant CLI flag is passed (handled by caller), OR
 * 3. Always enabled (since we control the build)
 */
export async function isKairosEnabled(): Promise<boolean> {
  // Allow explicit disable via env var
  if (isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_KAIROS)) {
    return false
  }
  return true
}
