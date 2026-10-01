import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './globals.css'
import SodiumPreloader from '@/platform/crypto/SodiumPreloader'
import StillHome from './App'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <SodiumPreloader />
    <div className="min-h-screen flex justify-center">
      <StillHome />
    </div>
  </StrictMode>,
)
