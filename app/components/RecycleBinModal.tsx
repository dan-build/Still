'use client'

interface Item {
  id: string
  label: string
  type: 'password' | 'key' | 'note'
  encryptedValue: string
}

interface RecycledLens {
  id: string
  name: string
  createdAt: string
  itemCount: number
  masterKey: Uint8Array
  items: Item[]
  deletedAt: string
}

interface RecycleBinModalProps {
  isOpen: boolean
  onClose: () => void
  recycleBin: RecycledLens[]
  onRestore: (lens: RecycledLens) => void
  onPermanentDelete: (id: string) => void
}

export default function RecycleBinModal({ 
  isOpen, 
  onClose, 
  recycleBin, 
  onRestore, 
  onPermanentDelete 
}: RecycleBinModalProps) {
  if (!isOpen) return null

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40" onClick={onClose}>
      <div className="bg-white w-full max-w-[480px] mx-4 rounded-[18px] p-8" onClick={e => e.stopPropagation()}>
        <div className="flex justify-between items-center mb-8">
          <div>
            <div className="text-[15px] font-medium">Recycle Bin</div>
            <div className="text-[14px] text-[#151515]/50 mt-0.5">Forgotten Lenses live here for 7 days, then gone forever</div>
          </div>
          <button 
            onClick={onClose} 
            className="text-[#151515]/40 hover:text-[#151515] text-xl leading-none transition-colors"
          >
            ✕
          </button>
        </div>

        {recycleBin.length === 0 ? (
          <div className="text-center py-16">
            <div className="mx-auto mb-4 w-12 h-12 rounded-full flex items-center justify-center">
              <svg 
                width="28" 
                height="28" 
                viewBox="0 0 24 24" 
                fill="none" 
                xmlns="http://www.w3.org/2000/svg"
                className="text-[#151515]/40"
              >
                <path 
                  d="M13 19H17.2942C19.1594 19 20.092 19 20.6215 18.6092C21.0832 18.2685 21.3763 17.7459 21.4263 17.1743C21.4836 16.5187 20.9973 15.7229 20.0247 14.1313L19.0278 12.5M6.13014 10.6052L3.97528 14.1314C3.00267 15.7229 2.51637 16.5187 2.57372 17.1743C2.62372 17.7459 2.91681 18.2685 3.37846 18.6092C3.90799 19 4.84059 19 6.70578 19H8.5M16.8889 8.99999L14.7305 5.46808C13.8277 3.99079 13.3763 3.25214 12.7952 3.00033C12.2879 2.78049 11.7121 2.78049 11.2048 3.00033C10.6237 3.25214 10.1723 3.99079 9.2695 5.46809L8.24967 7.13689M18 5.00006L16.9019 9.09813L12.8038 8.00006M2 11.5981L6.09808 10.5L7.19615 14.5981M15.5 22L12.5 19L15.5 16" 
                  stroke="currentColor" 
                  strokeWidth="2" 
                  strokeLinecap="round" 
                  strokeLinejoin="round"
                />
              </svg>
            </div>
            <div className="text-[#151515]/60 text-[14px]">Recycle Bin is empty</div>
            <div className="text-xs text-[#151515]/40 mt-1">Lenses you forget will appear here for 7 days</div>
          </div>
        ) : (
          <div className="space-y-3 max-h-[400px] overflow-auto pr-1">
            {recycleBin.map((item) => (
              <div 
                key={item.id} 
                className="group flex items-center justify-between bg-[#F8F9FA] hover:bg-white border border-transparent hover:border-black/10 rounded-[16px] px-6 py-5 transition-all duration-200"
              >
                <div className="min-w-0">
                    <div className="flex items-baseline gap-3">
                  <div className="font-medium text-[13px]">{item.name}</div>
                  <div className="flex items-center gap-2 mt-1 text-xs text-[#151515]/50">
                    <span>{item.itemCount ?? 0} secrets</span>
        
                    <span className="text-[11px]">deleted {new Date(item.deletedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span>
                  </div>
                  </div>
                </div>

                <div className="flex gap-2 opacity-70 group-hover:opacity-100 transition-opacity">
                  <button 
                    onClick={() => onRestore(item)}
                    className="px-3 py-2 text-xs font-medium text-[#151515]/80 hover:text-[#151515] hover:bg-white rounded-[10px] border border-black/10 transition-all active:scale-[0.985]"
                  >
                    Restore
                  </button>
                  <button 
                    onClick={() => onPermanentDelete(item.id)}
                    className="px-4 py-2 text-xs font-medium text-red-600/70 hover:text-red-600 hover:bg-red-50 rounded-[10px] transition-all active:scale-[0.985]"
                  >
                    Delete forever
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}