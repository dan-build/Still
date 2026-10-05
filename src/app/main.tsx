import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './globals.css'
import StillApp from './StillApp'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <StillApp />
  </StrictMode>,
)
