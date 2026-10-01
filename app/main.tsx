import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './globals.css'
import SodiumPreloader from './components/SodiumPreloader'
import StillHome from './page'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <SodiumPreloader />
    <div className="min-h-screen flex justify-center">
      <StillHome />
    </div>
  </StrictMode>,
)
