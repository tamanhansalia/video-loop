import { useCallback, useEffect, useRef, useState } from 'react'
import Layout from '../components/Layout'
import {
  apiJson,
  formatMediaBytes,
  formatMediaDuration,
  getLiveStudioWebSocketUrl,
} from '../lib/liveStudio'

function SectionHeader({ children }) {
  return (
    <p className="text-xs font-bold uppercase tracking-widest text-zinc-400 mb-4">{children}</p>
  )
}

export default function LiveControlPage() {
  const [liveState, setLiveState] = useState(null)
  const [sysInfo, setSysInfo] = useState(null)
  const [notice, setNotice] = useState(null)
  const [uploadingVideo, setUploadingVideo] = useState(false)
  const [uploadingTracks, setUploadingTracks] = useState(false)
  const [working, setWorking] = useState(false)
  const videoInputRef = useRef(null)
  const audioInputRef = useRef(null)

  const showNotice = useCallback((text, type = 'info') => {
    setNotice({ text, type })
  }, [])

  const fetchState = useCallback(async () => {
    try {
      setLiveState(await apiJson('/api/live-studio/state'))
    } catch (err) {
      showNotice(err.message, 'error')
    }
  }, [showNotice])

  const fetchSystemInfo = useCallback(async () => {
    try {
      setSysInfo(await apiJson('/api/system-info'))
    } catch {
      setSysInfo(null)
    }
  }, [])

  useEffect(() => {
    let cancelled = false

    ;(async () => {
      try {
        const [state, systemInfo] = await Promise.all([
          apiJson('/api/live-studio/state'),
          apiJson('/api/system-info'),
        ])
        if (cancelled) return
        setLiveState(state)
        setSysInfo(systemInfo)
      } catch (err) {
        if (!cancelled) showNotice(err.message, 'error')
      }
    })()

    return () => {
      cancelled = true
    }
  }, [fetchState, fetchSystemInfo, showNotice])

  useEffect(() => {
    const ws = new WebSocket(getLiveStudioWebSocketUrl())
    ws.onmessage = event => {
      try {
        const message = JSON.parse(event.data)
        if (message.type === 'live_state' && message.state) {
          setLiveState(message.state)
        }
      } catch {
        // Ignore malformed websocket messages.
      }
    }
    return () => ws.close()
  }, [])

  const handleVideoUpload = async event => {
    const file = event.target.files?.[0]
    if (!file) return

    setUploadingVideo(true)
    setNotice(null)
    try {
      const body = new FormData()
      body.append('video', file)
      const state = await apiJson('/api/live-studio/video', { method: 'POST', body })
      setLiveState(state)
      showNotice('Looping video updated.', 'success')
    } catch (err) {
      showNotice(err.message, 'error')
    } finally {
      setUploadingVideo(false)
      if (videoInputRef.current) videoInputRef.current.value = ''
    }
  }

  const handleTrackUpload = async event => {
    const files = Array.from(event.target.files || [])
    if (!files.length) return

    setUploadingTracks(true)
    setNotice(null)
    try {
      const body = new FormData()
      files.forEach(file => body.append('audio', file))
      const state = await apiJson('/api/live-studio/tracks', { method: 'POST', body })
      setLiveState(state)
      showNotice(`Added ${files.length} song${files.length !== 1 ? 's' : ''} to the queue.`, 'success')
    } catch (err) {
      showNotice(err.message, 'error')
    } finally {
      setUploadingTracks(false)
      if (audioInputRef.current) audioInputRef.current.value = ''
    }
  }

  const runMutation = async (request, successMessage) => {
    setWorking(true)
    setNotice(null)
    try {
      const state = await request()
      setLiveState(state)
      if (successMessage) showNotice(successMessage, 'success')
    } catch (err) {
      showNotice(err.message, 'error')
    } finally {
      setWorking(false)
    }
  }

  const currentTrackId = liveState?.currentTrack?.id || null

  return (
    <Layout>
      <main className="max-w-5xl mx-auto px-6 py-8">
        <div className="flex flex-col lg:flex-row lg:items-end lg:justify-between gap-4 border-b border-zinc-900 pb-5">
          <div>
            <h2 className="text-xs font-bold uppercase tracking-widest text-zinc-400">Live Studio</h2>
            <p className="text-xs text-zinc-600 mt-2">
              Manage one clean live output for OBS while changing songs and looping video from this separate control surface.
            </p>
          </div>
          <div className="flex flex-wrap gap-3 text-xs font-mono">
            <a href="/live" target="_blank" rel="noreferrer" className="px-3 py-2 border border-zinc-700 text-white hover:bg-zinc-900 transition-colors">
              Open Live Output
            </a>
            <button onClick={fetchState} className="px-3 py-2 border border-zinc-800 text-zinc-400 hover:border-zinc-600 hover:text-white transition-colors">
              Refresh State
            </button>
          </div>
        </div>

        {notice && (
          <div
            className={`mt-5 border px-4 py-3 text-xs ${
              notice.type === 'error'
                ? 'border-red-900 bg-red-950/20 text-red-400'
                : notice.type === 'success'
                  ? 'border-emerald-900 bg-emerald-950/20 text-emerald-400'
                  : 'border-zinc-800 bg-zinc-950 text-zinc-300'
            }`}
          >
            {notice.text}
          </div>
        )}

        <div className="grid grid-cols-1 xl:grid-cols-[1.15fr_0.85fr] gap-8 mt-8">
          <section>
            <SectionHeader>Queue Control</SectionHeader>

            <div className="flex flex-wrap gap-3 mb-4">
              <button
                onClick={() => audioInputRef.current?.click()}
                disabled={uploadingTracks}
                className="px-3 py-2 text-xs border border-zinc-700 bg-zinc-900 text-white hover:bg-zinc-800 transition-colors disabled:opacity-50"
              >
                {uploadingTracks ? 'Adding Songs...' : 'Add Songs'}
              </button>
              <button
                onClick={() => runMutation(() => apiJson('/api/live-studio/skip', { method: 'POST' }), 'Skipped to the next song.')}
                disabled={working || !liveState?.queue?.length}
                className="px-3 py-2 text-xs border border-zinc-800 text-zinc-300 hover:border-zinc-600 hover:text-white transition-colors disabled:opacity-50"
              >
                Skip Current
              </button>
              <button
                onClick={() => {
                  if (!window.confirm('Clear the entire song queue? Live playback will stop until new songs are added.')) return
                  runMutation(() => apiJson('/api/live-studio/clear-queue', { method: 'POST' }), 'Queue cleared.')
                }}
                disabled={working || !liveState?.queue?.length}
                className="px-3 py-2 text-xs border border-red-800 text-red-300 hover:bg-red-950/20 transition-colors disabled:opacity-50"
              >
                Clear Queue
              </button>
              <input
                ref={audioInputRef}
                type="file"
                multiple
                accept="audio/*,.mp3,.wav,.m4a,.aac,.flac,.ogg,.opus,.wma"
                className="hidden"
                onChange={handleTrackUpload}
              />
            </div>

            <div className="border border-zinc-900">
              {!liveState?.queue?.length ? (
                <div className="px-5 py-10 text-center text-sm text-zinc-700">
                  No songs queued yet.
                </div>
              ) : (
                <div className="divide-y divide-zinc-900">
                  {liveState.queue.map((track, index) => {
                    const isCurrent = track.id === currentTrackId
                    return (
                      <div key={track.id} className="px-4 py-4 flex flex-col md:flex-row md:items-center md:justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2 text-xs font-mono">
                            <span className={`uppercase ${isCurrent ? 'text-emerald-400' : 'text-zinc-600'}`}>
                              {isCurrent ? 'Now Playing' : `Queue ${index + 1}`}
                            </span>
                            <span className="text-zinc-700">{formatMediaDuration(track.durationSec)}</span>
                            <span className="text-zinc-700">{formatMediaBytes(track.sizeBytes)}</span>
                          </div>
                          <p className="text-sm text-white truncate mt-1">{track.filename}</p>
                        </div>

                        <div className="flex items-center gap-2 shrink-0">
                          <button
                            onClick={() => runMutation(() => apiJson(`/api/live-studio/tracks/${track.id}/move`, {
                              method: 'POST',
                              headers: { 'Content-Type': 'application/json' },
                              body: JSON.stringify({ direction: 'up' }),
                            }))}
                            disabled={working || index === 0}
                            className="w-9 h-9 border border-zinc-800 text-zinc-300 hover:border-zinc-600 hover:text-white transition-colors disabled:opacity-30"
                          >
                            ↑
                          </button>
                          <button
                            onClick={() => runMutation(() => apiJson(`/api/live-studio/tracks/${track.id}/move`, {
                              method: 'POST',
                              headers: { 'Content-Type': 'application/json' },
                              body: JSON.stringify({ direction: 'down' }),
                            }))}
                            disabled={working || index === liveState.queue.length - 1}
                            className="w-9 h-9 border border-zinc-800 text-zinc-300 hover:border-zinc-600 hover:text-white transition-colors disabled:opacity-30"
                          >
                            ↓
                          </button>
                          <button
                            onClick={() => runMutation(() => apiJson(`/api/live-studio/tracks/${track.id}`, { method: 'DELETE' }))}
                            disabled={working}
                            className="px-3 h-9 border border-red-800 text-red-300 hover:bg-red-950/20 transition-colors disabled:opacity-30"
                          >
                            Remove
                          </button>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          </section>

          <section className="space-y-8">
            <div>
              <SectionHeader>Live Status</SectionHeader>
              <div className="border border-zinc-900 p-5 space-y-3 text-xs font-mono">
                <div className="flex justify-between gap-4">
                  <span className="text-zinc-600">Current Song</span>
                  <span className="text-white text-right">{liveState?.currentTrack?.filename || 'No song playing'}</span>
                </div>
                <div className="flex justify-between gap-4">
                  <span className="text-zinc-600">Queue Length</span>
                  <span className="text-zinc-400">{liveState?.queue?.length || 0} song{liveState?.queue?.length === 1 ? '' : 's'}</span>
                </div>
                <div className="flex justify-between gap-4">
                  <span className="text-zinc-600">Queue Runtime</span>
                  <span className="text-zinc-400">{formatMediaDuration(liveState?.queueTotalDuration || 0)}</span>
                </div>
                <div className="flex justify-between gap-4">
                  <span className="text-zinc-600">Live Video</span>
                  <span className="text-zinc-400 text-right">{liveState?.backgroundVideo?.filename || 'No live video set'}</span>
                </div>
                {sysInfo && (
                  <div className="flex justify-between gap-4">
                    <span className="text-zinc-600">FFprobe</span>
                    <span className={sysInfo.ffprobeInstalled ? 'text-emerald-400' : 'text-red-400'}>
                      {sysInfo.ffprobeInstalled ? 'Ready' : 'Not detected'}
                    </span>
                  </div>
                )}
              </div>
            </div>

            <div>
              <SectionHeader>Looping Video</SectionHeader>
              <div className="border border-zinc-900 p-5 space-y-4">
                {liveState?.backgroundVideo ? (
                  <>
                    <video
                      src={liveState.backgroundVideo.publicPath}
                      className="w-full aspect-video object-cover border border-zinc-900"
                      autoPlay
                      loop
                      muted
                      playsInline
                    />
                    <div className="space-y-1 text-xs font-mono">
                      <p className="text-white truncate">{liveState.backgroundVideo.filename}</p>
                      <p className="text-zinc-600">
                        {formatMediaDuration(liveState.backgroundVideo.durationSec)} · {formatMediaBytes(liveState.backgroundVideo.sizeBytes)}
                      </p>
                    </div>
                  </>
                ) : (
                  <div className="aspect-video border border-dashed border-zinc-900 flex items-center justify-center text-sm text-zinc-700">
                    No live video selected.
                  </div>
                )}

                <div className="flex flex-wrap gap-3">
                  <button
                    onClick={() => videoInputRef.current?.click()}
                    disabled={uploadingVideo}
                    className="px-3 py-2 text-xs border border-zinc-700 bg-zinc-900 text-white hover:bg-zinc-800 transition-colors disabled:opacity-50"
                  >
                    {uploadingVideo ? 'Updating Video...' : liveState?.backgroundVideo ? 'Replace Video' : 'Add Video'}
                  </button>
                  <button
                    onClick={() => runMutation(() => apiJson('/api/live-studio/video', { method: 'DELETE' }), 'Live video removed.')}
                    disabled={working || !liveState?.backgroundVideo}
                    className="px-3 py-2 text-xs border border-red-800 text-red-300 hover:bg-red-950/20 transition-colors disabled:opacity-50"
                  >
                    Remove Video
                  </button>
                  <input
                    ref={videoInputRef}
                    type="file"
                    accept="video/*,.mp4,.mov,.webm,.mkv,.avi,.m4v"
                    className="hidden"
                    onChange={handleVideoUpload}
                  />
                </div>
              </div>
            </div>
          </section>
        </div>
      </main>
    </Layout>
  )
}
