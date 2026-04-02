// /dream skill — triggers nightly memory distillation for KAIROS assistant mode.
//
// Distills daily logs into MEMORY.md and topic files.

import { registerBundledSkill } from '../bundledSkills.js'
import { getAutoMemPath } from '../../memdir/paths.js'
import { join } from 'path'
import { readdirSync, readFileSync, existsSync, statSync } from 'fs'

export function registerDreamSkill(): void {
  const SKILL_PROMPT = `# Dream — Memory Distillation

## Goal
Distill daily logs from KAIROS assistant sessions into structured memory files.

## Context
In KAIROS assistant mode, you write memories append-only to daily log files:
\`~/.claude/projects/<project>/memory/logs/YYYY/MM/YYYY-MM-DD.md\`

The /dream skill consolidates these logs into:
- \`MEMORY.md\` — distilled index of key facts, decisions, patterns
- Topic files (e.g., \`architecture.md\`, \`bugs.md\`) — organized by theme

## Steps

### 1. Locate and read daily logs
Find all log files in \`${getAutoMemPath()}/logs/\` from the last 7 days.
Read each file and extract entries.

**Success criteria**: You have all recent log entries loaded.

### 2. Categorize entries
Group entries by theme:
- **Architecture** — system design, component structure, tech stack decisions
- **Bugs** — known issues, workarounds, root causes
- **Tasks** — pending work, TODOs, blocked items
- **Patterns** — coding conventions, common workflows, best practices
- **Context** — project background, team structure, deployment info

**Success criteria**: Entries are grouped by theme.

### 3. Distill into MEMORY.md
Write a concise MEMORY.md that captures:
- Key facts about the project
- Important decisions and their rationale
- Active tasks and blockers
- Known issues and workarounds

Keep it under 500 lines. Focus on what's actionable and relevant.

**Success criteria**: MEMORY.md is updated with distilled content.

### 4. Update topic files
For each theme with >5 entries, create/update a topic file:
- \`architecture.md\` — system design notes
- \`bugs.md\` — known issues
- \`tasks.md\` — pending work
- \`patterns.md\` — conventions

**Success criteria**: Topic files are created/updated.

### 5. Archive processed logs
Move processed log files to \`logs/archive/\` to mark them as distilled.

**Success criteria**: Logs are archived.

## Output
Report:
- Number of log entries processed
- Themes identified
- Files created/updated
- Key insights surfaced

## Notes
- This is a nightly maintenance task, typically run via cron
- Preserve important details but compress repetitive entries
- If logs are empty, report "No new entries to distill"
`

  registerBundledSkill({
    name: 'dream',
    description: 'Distill daily logs into structured memory files',
    prompt: SKILL_PROMPT,
    isEnabled: () => {
      // Only available in KAIROS mode
      try {
        const { getKairosActive } = require('../../bootstrap/state.js')
        return getKairosActive()
      } catch {
        return false
      }
    },
  })
}
