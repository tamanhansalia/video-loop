import { useCallback, useEffect, useRef, useState } from 'react'

export default function LogViewer({ jobId, filename, onClose }) {
  const [logs, setLogs] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const scrollRef = useRef(null)

  const fetchLogs = useCallback(async ({ showLoading = true } = {}) => {
    if (showLoading) setLoading(true)
    setError(null)
    try {
      const r = await fetch(`/api/jobs/${jobId}/logs`)
      if (!r.ok) throw new Error('Failed to load logs')
      const d = await r.json()
      setLogs(d.logs || '(no logs)')
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [jobId])

  useEffect(() => {
    const initial = setTimeout(() => { fetchLogs({ showLoading: false }) }, 0)
    const iv = setInterval(fetchLogs, 4000)
    return () => {
      clearTimeout(initial)
      clearInterval(iv)
    }
  }, [fetchLogs])

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [logs])

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/95"
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="relative w-full max-w-4xl h-[80vh] mx-4 border border-zinc-800 flex flex-col bg-black">

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-zinc-800">
          <div>
            <p className="text-xs text-zinc-600 font-mono uppercase tracking-wider">Render Logs</p>
            <p className="text-sm text-white font-medium truncate mt-0.5 max-w-md">{filename}</p>
            <p className="text-xs text-zinc-700 font-mono mt-0.5">{jobId}</p>
          </div>
          <div className="flex items-center gap-3 ml-4 shrink-0">
            <button
              onClick={fetchLogs}
              disabled={loading}
              className="text-xs font-mono text-zinc-600 hover:text-white transition-colors disabled:opacity-40 flex items-center gap-1.5"
            >
              {loading ? '↻ Refreshing…' : '↻ Refresh'}
            </button>
            <button
              onClick={onClose}
              className="text-zinc-600 hover:text-white transition-colors text-xl leading-none"
            >
              ×
            </button>
          </div>
        </div>

        {/* Log terminal */}
        <div
          ref={scrollRef}
          className="flex-1 overflow-y-auto p-5 bg-black font-mono text-xs leading-relaxed select-text"
        >
          {error ? (
            <p className="text-red-400">Error: {error}</p>
          ) : logs ? (
            <pre className="whitespace-pre-wrap text-zinc-400">{logs}</pre>
          ) : (
            <p className="text-zinc-700">Loading…</p>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-2 border-t border-zinc-900 flex items-center justify-between text-xs font-mono text-zinc-800">
          <span>Auto-refresh every 4s</span>
          <span>ESC to close · drag to select</span>
        </div>
      </div>
    </div>
  )
}
