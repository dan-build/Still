import { defineConfig } from 'vitest/config'

export default defineConfig({
  // tsconfig keeps "jsx": "preserve" for Next.js, so tell Vite's transformer
  // to compile JSX itself in tests.
  oxc: { jsx: { runtime: 'automatic' } },
  test: {
    environment: 'node',
    include: ['app/**/*.test.ts', 'app/**/*.test.tsx'],
    // Argon2id with libsodium's SENSITIVE limits allocates 1 GiB and takes
    // several seconds per derivation.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
})
