import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './globals.css'
import StillApp from './StillApp'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <div className="min-h-screen flex justify-center">
      <StillApp />
    </div>
  </StrictMode>,
)
