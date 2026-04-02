// Proactive mode — lightweight autonomous agent activation.
// When active, Claude receives periodic <tick> prompts and can use SleepTool.

let _active = false
let _paused = false
let _source: string | undefined

export function isProactiveActive(): boolean {
  return _active
}

export function activateProactive(source?: string): void {
  _active = true
  _paused = false
  _source = source
}

export function deactivateProactive(): void {
  _active = false
  _paused = false
  _source = undefined
}

export function isProactivePaused(): boolean {
  return _paused
}

export function pauseProactive(): void {
  _paused = true
}

export function resumeProactive(): void {
  _paused = false
}

export function getProactiveSource(): string | undefined {
  return _source
}
