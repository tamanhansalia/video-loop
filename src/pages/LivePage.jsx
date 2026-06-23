import { useCallback, useEffect, useRef, useState } from 'react'
import { apiJson, getLiveStudioWebSocketUrl } from '../lib/liveStudio'

export default function LivePage() {
  const [liveState, setLiveState] = useState(null)
  const [error, setError] = useState(null)
  const videoRef = useRef(null)
  const audioRef = useRef(null)
  const lastTrackIdRef = useRef(null)
  const backgroundVideoPath = liveState?.backgroundVideo?.publicPath || null
  const currentTrack = liveState?.currentTrack || null

  const fetchState = useCallback(async () => {
    try {
      setLiveState(await apiJson('/api/live-studio/state'))
      setError(null)
    } catch (err) {
      setError(err.message)
    }
  }, [])

  useEffect(() => {
    let cancelled = false

    ;(async () => {
      try {
        const state = await apiJson('/api/live-studio/state')
        if (!cancelled) {
          setLiveState(state)
          setError(null)
        }
      } catch (err) {
        if (!cancelled) setError(err.message)
      }
    })()

    const ws = new WebSocket(getLiveStudioWebSocketUrl())
    ws.onmessage = event => {
      try {
        const message = JSON.parse(event.data)
        if (message.type === 'live_state' && message.state) {
          setLiveState(message.state)
          setError(null)
        }
      } catch {
        // Ignore malformed websocket payloads.
      }
    }
    ws.onerror = () => setError('Live connection interrupted.')

    const interval = setInterval(fetchState, 15000)
    return () => {
      cancelled = true
      clearInterval(interval)
      ws.close()
    }
  }, [fetchState])

  useEffect(() => {
    const video = videoRef.current
    if (!video) return

    if (!backgroundVideoPath) {
      video.pause()
      video.removeAttribute('src')
      video.load()
      return
    }

    if (video.getAttribute('data-src') !== backgroundVideoPath) {
      video.src = backgroundVideoPath
      video.setAttribute('data-src', backgroundVideoPath)
      video.load()
    }

    video.play().catch(() => {
      // Browser autoplay may be blocked outside OBS.
    })
  }, [backgroundVideoPath, liveState?.revision])

  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return

    if (!currentTrack?.publicPath) {
      audio.pause()
      audio.removeAttribute('src')
      audio.load()
      lastTrackIdRef.current = null
      return
    }

    const desiredOffset = Math.max(0, Math.min(
      Number(liveState?.elapsedInTrack || 0),
      Math.max(0, Number(currentTrack.durationSec || 0) - 0.25)
    ))

    const syncPlayback = () => {
      if (Number.isFinite(desiredOffset) && Math.abs((audio.currentTime || 0) - desiredOffset) > 1.5) {
        try {
          audio.currentTime = desiredOffset
        } catch {
          // Ignore seek timing errors before metadata is ready.
        }
      }

      audio.play().catch(() => {
        // Browser autoplay may be blocked outside OBS.
      })
    }

    if (lastTrackIdRef.current !== currentTrack.id || audio.getAttribute('data-src') !== currentTrack.publicPath) {
      const handleLoaded = () => {
        syncPlayback()
        audio.removeEventListener('loadedmetadata', handleLoaded)
      }

      audio.src = currentTrack.publicPath
      audio.setAttribute('data-src', currentTrack.publicPath)
      audio.load()
      audio.addEventListener('loadedmetadata', handleLoaded)
      lastTrackIdRef.current = currentTrack.id

      return () => audio.removeEventListener('loadedmetadata', handleLoaded)
    }

    syncPlayback()
  }, [currentTrack, liveState?.elapsedInTrack, liveState?.revision])

  return (
    <main className="w-screen h-screen bg-black overflow-hidden relative">
      <video
        ref={videoRef}
        className="absolute inset-0 w-full h-full object-cover"
        autoPlay
        loop
        muted
        playsInline
      />
      <audio
        ref={audioRef}
        autoPlay
        onEnded={fetchState}
        onError={() => setTimeout(fetchState, 250)}
        className="hidden"
      />

      {!liveState?.backgroundVideo && !liveState?.currentTrack && !error && (
        <div className="absolute inset-0 flex items-center justify-center text-sm text-zinc-700 font-mono">
          Configure a live video and song queue from Live Studio.
        </div>
      )}

      {error && (
        <div className="absolute inset-0 flex items-center justify-center text-sm text-red-400 font-mono">
          {error}
        </div>
      )}
    </main>
  )
}
