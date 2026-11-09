// The password generator, as the Add and Edit secret dialogs use it. The
// passwords themselves come from Rust (password_generate, from libsodium);
// this holds the options, which last until Still quits (nothing is stored).

import { createContext } from 'react'
import type { GeneratedPassword, GeneratorOptions } from '@/features/vault/model/types'

export const MIN_LENGTH = 8
export const MAX_LENGTH = 64

export const GENERATOR_DEFAULTS: GeneratorOptions = {
  length: 20,
  lower: true,
  upper: true,
  digits: true,
  symbols: true,
  avoidLookAlikes: true,
}

export interface Generator {
  generate: (options: GeneratorOptions) => Promise<GeneratedPassword>
  options: GeneratorOptions
  setOptions: (options: GeneratorOptions) => void
}

/** Provided while the vault is unlocked; without it, the dialogs offer no generator. */
export const GeneratorContext = createContext<Generator | null>(null)

/** A plain word for a strength in bits. */
export function strengthWord(bits: number): 'weak' | 'fair' | 'strong' {
  if (bits < 50) return 'weak'
  if (bits < 80) return 'fair'
  return 'strong'
}
