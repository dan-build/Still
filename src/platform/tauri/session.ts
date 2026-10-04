// Auto-lock, seen from the page: Rust decides when to lock (5 minutes idle, or
// the computer slept) and tells the page; the page reports that someone is
// using it.

import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'

export type AutoLockReason = 'idle' | 'sleep'

/** Tells Rust someone is using the app. Failures don't matter: the next one tries again. */
export function reportActivity(): void {
  invoke('vault_touch').catch(() => {})
}

/** Calls `onLocked` when Rust has locked the vault by itself. Returns a function that stops listening. */
export function onAutoLocked(onLocked: (reason: AutoLockReason) => void): () => void {
  let stop: (() => void) | undefined
  let stopped = false
  listen<AutoLockReason>('vault-locked', (event) => onLocked(event.payload))
    .then((unlisten) => {
      if (stopped) unlisten()
      else stop = unlisten
    })
    .catch(() => {})
  return () => {
    stopped = true
    stop?.()
  }
}
