import React, { useEffect } from 'react'

export default function PreviewModal({ videoUrl, filename, onClose }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  if (!videoUrl) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/95"
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="relative w-full max-w-4xl mx-4 border border-zinc-800 flex flex-col bg-black">

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-zinc-800">
          <div className="min-w-0">
            <p className="text-xs text-zinc-600 font-mono uppercase tracking-wider">Preview</p>
            <p className="text-sm text-white font-medium truncate mt-0.5">{filename}</p>
          </div>
          <button
            onClick={onClose}
            className="text-zinc-600 hover:text-white transition-colors ml-4 shrink-0 text-xl leading-none"
          >
            ×
          </button>
        </div>

        {/* Video player */}
        <div className="bg-black flex items-center justify-center">
          <video
            src={videoUrl}
            className="w-full max-h-[70vh] object-contain"
            controls
            autoPlay
            playsInline
          />
        </div>

        {/* Footer */}
        <div className="px-5 py-2 border-t border-zinc-900 flex items-center justify-between text-xs font-mono text-zinc-800">
          <span>{videoUrl}</span>
          <span>ESC or click outside to close</span>
        </div>
      </div>
    </div>
  )
}
