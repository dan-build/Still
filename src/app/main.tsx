import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './globals.css'
import StillHome from './App'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <div className="min-h-screen flex justify-center">
      <StillHome />
    </div>
  </StrictMode>,
)
