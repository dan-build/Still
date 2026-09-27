import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['app/**/*.test.ts', 'app/**/*.test.tsx'],
    // Argon2id with libsodium's SENSITIVE limits allocates 1 GiB and takes
    // several seconds per derivation.
    testTimeout: 120_000,
  },
})
