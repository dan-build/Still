import { describe, expect, it } from 'vitest'
import config from './vite.config'

// tauri dev keeps its vault under the origin http://localhost:3000. If Vite
// moved to another port or host, the dev vault would seem to disappear.
describe('vite dev server', () => {
  it('stays on http://localhost:3000 and never picks another port', () => {
    expect(config.server).toMatchObject({ port: 3000, strictPort: true, host: 'localhost' })
  })
})
