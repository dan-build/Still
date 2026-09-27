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
    // Each crypto test file allocates 1 GiB for Argon2id. Running files one at
    // a time keeps peak memory near 1 GiB (CI's macOS runner has 7 GB) and is
    // no slower, since Argon2id is memory-bound.
    fileParallelism: false,
    hookTimeout: 120_000,
  },
})
