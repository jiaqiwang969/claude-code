// KAIROS session chooser — Ink component for selecting an assistant session.

import React from 'react'
import type { AssistantSession } from './sessionDiscovery.js'

type Props = {
  sessions: AssistantSession[]
  onSelect: (session: AssistantSession) => void
  onCancel: () => void
}

/**
 * Minimal session chooser component.
 * In the original implementation this was a full interactive list.
 * For now, auto-selects the most recent session or returns null.
 */
export function AssistantSessionChooser({ sessions, onSelect, onCancel }: Props): React.ReactElement | null {
  // Auto-select most recent session if available
  React.useEffect(() => {
    if (sessions.length > 0) {
      onSelect(sessions[0]!)
    } else {
      onCancel()
    }
  }, [sessions, onSelect, onCancel])

  return null
}
