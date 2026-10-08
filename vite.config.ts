import { fileURLToPath } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // macOS's webview is the system Safari. Tailwind 4 needs Safari 15.4 (CSS
  // cascade layers); Lightning CSS adds fallbacks for anything newer, in dev
  // and in release, so macOS 12 renders exactly like current macOS.
  css: {
    transformer: 'lightningcss',
    lightningcss: { targets: { safari: (15 << 16) | (4 << 8) } },
  },
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
    cssMinify: 'lightningcss',
    // Never inline fonts as data: URLs: the CSP's font-src 'self' blocks
    // them (scripts/check-dist.mjs checks). Other small assets may inline.
    assetsInlineLimit: (file) => (/\.(woff2?|ttf|otf)$/.test(file) ? false : undefined),
    rolldownOptions: {
      // Strip console.* calls from release builds.
      output: { minify: { compress: { dropConsole: true } } },
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'scripts/**/*.test.mjs', '*.test.ts'],
    // No crypto runs here: it's Rust's, tested in crates/still-core. The
    // version script's tests copy files and run slower when files run in
    // parallel, hence more than the 5 s default.
    testTimeout: 30_000,
  },
})
