// KAIROS session discovery — finds active assistant sessions.
//
// Scans ~/.claude/projects/ for sessions with KAIROS activity markers.

import { readdirSync, readFileSync, statSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

export type AssistantSession = {
  id: string
  projectPath: string
  lastActive: number
  title?: string
}

/**
 * Discover active KAIROS assistant sessions across all projects.
 * Returns sessions sorted by most recently active first.
 */
export async function discoverAssistantSessions(): Promise<AssistantSession[]> {
  const sessions: AssistantSession[] = []
  const claudeDir = join(homedir(), '.claude', 'projects')

  try {
    const projects = readdirSync(claudeDir)
    for (const project of projects) {
      const projectDir = join(claudeDir, project)
      try {
        const stat = statSync(projectDir)
        if (!stat.isDirectory()) continue

        // Look for session files
        const files = readdirSync(projectDir).filter(f => f.endsWith('.json'))
        for (const file of files) {
          try {
            const filePath = join(projectDir, file)
            const fileStat = statSync(filePath)
            const content = readFileSync(filePath, 'utf8')
            const data = JSON.parse(content)

            // Check if this session has KAIROS markers
            if (data.kairosActive || data.assistantMode) {
              sessions.push({
                id: file.replace('.json', ''),
                projectPath: project,
                lastActive: fileStat.mtimeMs,
                title: data.title || data.customTitle,
              })
            }
          } catch {
            // Skip unreadable session files
          }
        }
      } catch {
        // Skip unreadable project dirs
      }
    }
  } catch {
    // ~/.claude/projects/ doesn't exist yet
  }

  // Sort by most recently active
  return sessions.sort((a, b) => b.lastActive - a.lastActive)
}
