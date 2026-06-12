import type { Metadata } from 'next'
import '@/app/globals.css'
import SodiumPreloader from './components/SodiumPreloader'

export const metadata: Metadata = {
  title: {
    default: 'Still',
    template: '%s • Still',
  },
  description: 'Own it all. Ephemeral personal key & asset manager.',
  icons: {
    icon: '/icon.png',
  },
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="font-sans antialiased bg-[#F8F9FA] text-[#1A2530] selection:bg-[#DCE5EE] selection:text-[#1A2530]">
        <SodiumPreloader />
        <div className="min-h-screen flex justify-center">
          {children}
        </div>
      </body>
    </html>
  )
}