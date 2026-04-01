// Stub for ant-only AntModelSwitchCallout component
export function AntModelSwitchCallout({ onDone }: { onDone: (selection: string, modelAlias?: string) => void }) {
  return null
}

export function shouldShowModelSwitchCallout(): boolean {
  return false
}
