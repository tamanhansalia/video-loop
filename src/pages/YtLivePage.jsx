import { useCallback, useEffect, useRef, useState } from 'react'
import Layout from '../components/Layout'

function formatUptime(seconds) {
  if (!seconds || seconds <= 0) return '0:00:00'
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

function formatDuration(sec) {
  if (!sec || sec <= 0) return '0:00'
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

const STATUS_COLORS = {
  offline: 'bg-zinc-600',
  starting: 'bg-amber-500 animate-pulse',
  live: 'bg-emerald-500 animate-pulse',
  error: 'bg-red-600',
}

const STATUS_LABELS = {
  offline: 'Offline',
  starting: 'Starting...',
  live: 'Live',
  error: 'Error',
}

export default function YtLivePage() {
  const [state, setState] = useState(null)
  const [keyInput, setKeyInput] = useState('')
  const [keyVisible, setKeyVisible] = useState(false)
  const [notice, setNotice] = useState(null)
  const [uploading, setUploading] = useState({ audio: false, bg: false })
  const audioInputRef = useRef(null)
  const bgInputRef = useRef(null)
  const wsRef = useRef(null)
  const noticeTimer = useRef(null)

  const showNotice = useCallback((text, type = 'info') => {
    setNotice({ text, type })
    if (noticeTimer.current) clearTimeout(noticeTimer.current)
    noticeTimer.current = setTimeout(() => setNotice(null), 5000)
  }, [])

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/yt-live/status')
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed to fetch status')
      setState(data)
    } catch (err) {
      showNotice(err.message, 'error')
    }
  }, [showNotice])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchStatus()

    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const wsUrl = `${proto}//${window.location.hostname}:5000`
    let cancelled = false

    function connect() {
      if (cancelled) return
      const ws = new WebSocket(wsUrl)
      wsRef.current = ws
      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data)
          if (msg.type === 'yt_live_status') setState(msg.state)
        } catch { /* ignore */ }
      }
      ws.onclose = () => { if (!cancelled) setTimeout(connect, 3000) }
      ws.onerror = () => ws.close()
    }
    connect()

    return () => {
      cancelled = true
      if (wsRef.current) wsRef.current.close()
    }
  }, [fetchStatus])

  async function apiPost(url, body) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || 'Request failed')
    return data
  }

  async function apiDelete(url) {
    const res = await fetch(url, { method: 'DELETE' })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || 'Request failed')
    return data
  }

  async function handleSaveKey() {
    if (!keyInput.trim()) return
    try {
      await apiPost('/api/yt-live/stream-key', { streamKey: keyInput.trim() })
      setKeyInput('')
      setKeyVisible(false)
      showNotice('Stream key saved.', 'success')
    } catch (err) { showNotice(err.message, 'error') }
  }

  async function handleBgUpload(e) {
    const file = e.target.files?.[0]
    if (!file) return
    setUploading(u => ({ ...u, bg: true }))
    try {
      const form = new FormData()
      form.append('background', file)
      const res = await fetch('/api/yt-live/background', { method: 'POST', body: form })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Upload failed')
      showNotice('Background uploaded.', 'success')
    } catch (err) { showNotice(err.message, 'error') }
    setUploading(u => ({ ...u, bg: false }))
    if (bgInputRef.current) bgInputRef.current.value = ''
  }

  async function handleBgRemove() {
    try {
      await apiDelete('/api/yt-live/background')
      showNotice('Background removed.', 'success')
    } catch (err) { showNotice(err.message, 'error') }
  }

  async function handleAudioUpload(e) {
    const files = e.target.files
    if (!files || files.length === 0) return
    setUploading(u => ({ ...u, audio: true }))
    try {
      const form = new FormData()
      for (const f of files) form.append('audio', f)
      const res = await fetch('/api/yt-live/audio', { method: 'POST', body: form })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Upload failed')
      showNotice(`${files.length} track(s) uploaded.`, 'success')
    } catch (err) { showNotice(err.message, 'error') }
    setUploading(u => ({ ...u, audio: false }))
    if (audioInputRef.current) audioInputRef.current.value = ''
  }

  async function handleAudioRemove(id) {
    try {
      await apiDelete(`/api/yt-live/audio/${id}`)
    } catch (err) { showNotice(err.message, 'error') }
  }

  async function handleStart() {
    try {
      const result = await apiPost('/api/yt-live/start')
      if (result.error) throw new Error(result.error)
      showNotice('Stream starting...', 'success')
    } catch (err) { showNotice(err.message, 'error') }
  }

  async function handleStop() {
    try {
      await apiPost('/api/yt-live/stop')
      showNotice('Stream stopped.', 'success')
    } catch (err) { showNotice(err.message, 'error') }
  }

  async function handleRestart() {
    try {
      await apiPost('/api/yt-live/restart')
      showNotice('Stream restarting...', 'success')
    } catch (err) { showNotice(err.message, 'error') }
  }

  const s = state || {}
  const isLive = s.status === 'live' || s.status === 'starting'
  const canStart = s.hasStreamKey && (s.audioFiles?.length > 0) && !!s.background && !isLive

  return (
    <Layout>
      <div className="max-w-screen-lg mx-auto px-6 py-8">
        <div className="text-center mb-8">
          <p className="text-2xl font-bold tracking-widest text-white">YOUTUBE LIVE</p>
          <p className="text-xs text-zinc-600 font-mono mt-1">24/7 VPS Streaming Proof of Concept</p>
        </div>

        {notice && (
          <div className={`mb-6 px-4 py-2 text-xs font-mono border ${
            notice.type === 'error' ? 'border-red-800 text-red-400 bg-red-950/30'
            : notice.type === 'success' ? 'border-emerald-800 text-emerald-400 bg-emerald-950/30'
            : 'border-zinc-800 text-zinc-400 bg-zinc-950/30'
          }`}>
            {notice.text}
          </div>
        )}

        {/* Status Panel */}
        <div className="border border-zinc-800 p-6 mb-6">
          <div className="flex items-center gap-3 mb-4">
            <span className={`w-2.5 h-2.5 rounded-full ${STATUS_COLORS[s.status] || STATUS_COLORS.offline}`} />
            <span className="text-sm font-bold uppercase tracking-wider text-white">
              {STATUS_LABELS[s.status] || 'Offline'}
            </span>
            {s.ffmpegRunning && (
              <span className="text-xs font-mono text-emerald-600 ml-auto">FFmpeg running</span>
            )}
            {!s.ffmpegRunning && s.status !== 'offline' && (
              <span className="text-xs font-mono text-zinc-600 ml-auto">FFmpeg stopped</span>
            )}
          </div>
          {(s.status === 'live' || s.status === 'starting') && (
            <div className="grid grid-cols-2 gap-4 text-xs font-mono">
              <div>
                <span className="text-zinc-600">Now Playing</span>
                <p className="text-white mt-1 truncate">{s.currentSongName || '--'}</p>
              </div>
              <div>
                <span className="text-zinc-600">Uptime</span>
                <p className="text-white mt-1">{formatUptime(s.elapsedSeconds)}</p>
              </div>
            </div>
          )}
          {s.status === 'error' && s.errorMessage && (
            <p className="text-xs font-mono text-red-400 mt-2">{s.errorMessage}</p>
          )}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
          {/* Stream Key */}
          <div className="border border-zinc-800 p-6">
            <p className="text-xs font-bold uppercase tracking-widest text-zinc-400 mb-4">Stream Key</p>
            {s.hasStreamKey && (
              <p className="text-xs font-mono text-zinc-500 mb-3">
                Saved: {s.streamKeyPreview}
              </p>
            )}
            <div className="flex gap-2">
              <input
                type={keyVisible ? 'text' : 'password'}
                value={keyInput}
                onChange={e => setKeyInput(e.target.value)}
                placeholder="Paste YouTube stream key"
                className="flex-1 bg-zinc-950 border border-zinc-800 px-3 py-2 text-xs font-mono text-white placeholder-zinc-700 focus:outline-none focus:border-zinc-600"
              />
              <button
                onClick={() => setKeyVisible(!keyVisible)}
                className="px-2 text-xs text-zinc-600 hover:text-zinc-400 transition-colors"
              >
                {keyVisible ? 'Hide' : 'Show'}
              </button>
              <button
                onClick={handleSaveKey}
                disabled={!keyInput.trim()}
                className="px-4 py-2 text-xs font-bold uppercase tracking-wider bg-zinc-900 border border-zinc-700 text-white hover:bg-zinc-800 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
              >
                Save
              </button>
            </div>
          </div>

          {/* Background */}
          <div className="border border-zinc-800 p-6">
            <p className="text-xs font-bold uppercase tracking-widest text-zinc-400 mb-4">Background</p>
            {s.background ? (
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-xs font-mono text-zinc-600 uppercase">{s.background.type}</span>
                  <span className="text-xs font-mono text-white truncate">{s.background.name}</span>
                </div>
                <button
                  onClick={handleBgRemove}
                  disabled={isLive}
                  className="text-xs text-red-500 hover:text-red-400 transition-colors disabled:opacity-30 shrink-0"
                >
                  Remove
                </button>
              </div>
            ) : (
              <p className="text-xs font-mono text-zinc-700 mb-1">No background set</p>
            )}
            <div className="mt-3">
              <input
                ref={bgInputRef}
                type="file"
                accept="image/*,video/*"
                onChange={handleBgUpload}
                className="hidden"
              />
              <button
                onClick={() => bgInputRef.current?.click()}
                disabled={uploading.bg || isLive}
                className="text-xs font-mono text-zinc-500 hover:text-zinc-300 transition-colors disabled:opacity-30"
              >
                {uploading.bg ? 'Uploading...' : 'Upload image or video'}
              </button>
            </div>
          </div>
        </div>

        {/* Audio Playlist */}
        <div className="border border-zinc-800 p-6 mb-6">
          <div className="flex items-center justify-between mb-4">
            <p className="text-xs font-bold uppercase tracking-widest text-zinc-400">
              Audio Playlist ({s.audioFiles?.length || 0} tracks)
            </p>
            <div>
              <input
                ref={audioInputRef}
                type="file"
                accept="audio/*"
                multiple
                onChange={handleAudioUpload}
                className="hidden"
              />
              <button
                onClick={() => audioInputRef.current?.click()}
                disabled={uploading.audio || isLive}
                className="text-xs font-mono text-zinc-500 hover:text-zinc-300 transition-colors disabled:opacity-30"
              >
                {uploading.audio ? 'Uploading...' : '+ Add tracks'}
              </button>
            </div>
          </div>
          {(s.audioFiles?.length || 0) === 0 ? (
            <p className="text-xs font-mono text-zinc-700">No audio files uploaded</p>
          ) : (
            <div className="space-y-1">
              {s.audioFiles.map((f, i) => (
                <div
                  key={f.id}
                  className={`flex items-center justify-between px-3 py-2 text-xs font-mono ${
                    s.status === 'live' && s.currentSongIndex === i
                      ? 'bg-emerald-950/30 border border-emerald-800'
                      : 'bg-zinc-950 border border-zinc-900'
                  }`}
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <span className="text-zinc-600 w-5 text-right shrink-0">{i + 1}</span>
                    {s.status === 'live' && s.currentSongIndex === i && (
                      <span className="text-emerald-400 shrink-0">▶</span>
                    )}
                    <span className="text-white truncate">{f.name}</span>
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    <span className="text-zinc-600">{formatDuration(f.durationSec)}</span>
                    <button
                      onClick={() => handleAudioRemove(f.id)}
                      disabled={isLive}
                      className="text-zinc-700 hover:text-red-400 transition-colors disabled:opacity-30"
                    >
                      ×
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Controls */}
        <div className="flex items-center gap-3 mb-6">
          <button
            onClick={handleStart}
            disabled={!canStart}
            className="px-6 py-3 text-xs font-bold uppercase tracking-wider bg-emerald-900 border border-emerald-700 text-white hover:bg-emerald-800 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
          >
            Start Stream
          </button>
          <button
            onClick={handleStop}
            disabled={!isLive}
            className="px-6 py-3 text-xs font-bold uppercase tracking-wider bg-red-900 border border-red-700 text-white hover:bg-red-800 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
          >
            Stop
          </button>
          <button
            onClick={handleRestart}
            disabled={!isLive}
            className="px-6 py-3 text-xs font-bold uppercase tracking-wider bg-zinc-900 border border-zinc-700 text-white hover:bg-zinc-800 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
          >
            Restart
          </button>
        </div>

        {/* Info */}
        <div className="text-xs font-mono text-zinc-700 space-y-1">
          {isLive && (
            <p>Stream continues running on the server even if you close this page or shut down your laptop.</p>
          )}
          {s.status === 'error' && (
            <p>FFmpeg will auto-restart in 5 seconds if it crashes unexpectedly.</p>
          )}
          <p>
            VPS deployment: run the server with PM2 for process-level recovery.
            <span className="text-zinc-800 ml-1">pm2 start server/index.js --name loopstudio</span>
          </p>
        </div>
      </div>
    </Layout>
  )
}
