import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  // Tauri prints its own output; keep Vite's next to it.
  clearScreen: false,
  server: {
    // tauri dev keeps its vault under the origin http://localhost:3000.
    // Another port or host would hide it, so fail instead of moving.
    port: 3000,
    strictPort: true,
    host: 'localhost',
    watch: { ignored: ['**/src-tauri/**'] },
  },
  build: {
    outDir: 'dist',
    rolldownOptions: {
      // Strip console.* calls from release builds.
      output: { minify: { compress: { dropConsole: true } } },
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'scripts/**/*.test.mjs', '*.test.ts'],
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
