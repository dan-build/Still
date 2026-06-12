'use client'

interface AboutModalProps {
  isOpen: boolean
  onClose: () => void
}

export default function AboutModal({ isOpen, onClose }: AboutModalProps) {
  if (!isOpen) return null

  return (
    <div 
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/40"
      onClick={onClose}
    >
      <div 
        className="bg-white w-full max-w-[420px] mx-4 rounded-3xl p-10 shadow-xl"
        onClick={e => e.stopPropagation()}
      >
        <div className="text-center mb-8">
          <div className="mx-auto mb-6 w-16 h-16 rounded-2xl bg-[#2B5A8F] flex items-center justify-center">
            <span className="text-white text-4xl font-medium tracking-tighter">S</span>
          </div>
          
          <div className="text-[28px] font-medium tracking-tight mb-1">Still</div>
          <div className="text-[#606F7B] text-sm">v0.1 • Local &amp; Private</div>
        </div>

        <div className="text-center text-[#606F7B] text-[15px] leading-relaxed mb-8">
          A calm, encrypted space for your most important secrets.<br />
          Encrypted at rest on this device and protected by your master password.<br />
          Explicitly forget a Lens to remove it.
        </div>

        <div className="border-t border-[#DCE5EE] pt-6 text-center">
          <div className="text-xs text-[#606F7B] mb-4">Built with obsessive care using</div>
          <div className="flex justify-center gap-4 text-xs text-[#2B5A8F]">
            <span>Next.js 16</span>
            <span>•</span>
            <span>Tauri v2</span>
            <span>•</span>
            <span>libsodium</span>
          </div>
        </div>

        <button
          onClick={onClose}
          className="mt-8 w-full py-3.5 text-sm font-medium text-[#606F7B] hover:bg-[#F8F9FA] rounded-2xl transition-colors"
        >
          Close
        </button>
      </div>
    </div>
  )
}