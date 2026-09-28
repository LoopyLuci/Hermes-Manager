let configDirty = false

/** Global "config has unsaved edits" flag consulted by App before navigating away. */
export function isConfigDirty(): boolean {
  return configDirty
}

export function setConfigDirty(dirty: boolean): void {
  configDirty = dirty
}
