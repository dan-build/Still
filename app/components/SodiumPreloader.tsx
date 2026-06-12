'use client'

import { useEffect } from 'react'

export default function SodiumPreloader() {
  useEffect(() => {
    import('libsodium-wrappers-sumo').then((mod) => {
      const sodium = mod.default || mod
      sodium.ready.then(() => {
        console.log('%c[Sodium] Preloaded successfully', 'color: #22c55e')
      })
    })
  }, [])

  return null
}