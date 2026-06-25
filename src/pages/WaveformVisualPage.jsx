import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import Layout from '../components/Layout'
import {
  clampWaveBox,
  DEFAULT_WAVEFORM_VISUAL_CONFIG,
  FRAME_PRESETS,
  WAVEFORM_COLOR_PRESETS,
  getFrameDimensions,
  sanitizeWaveformVisualConfig,
} from '../lib/waveformVisual'

const formatBytes = bytes => {
  if (!bytes) return '—'
  const units = ['B', 'KB', 'MB', 'GB']
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), 3)
  return `${(bytes / Math.pow(1024, i)).toFixed(i >= 2 ? 1 : 0)} ${units[i]}`
}

const formatDuration = sec => {
  if (!Number.isFinite(sec)) return 'Analyzing...'
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = Math.floor(sec % 60)
  return h > 0 ? `${h}h ${m}m ${s}s` : m > 0 ? `${m}m ${s}s` : `${s}s`
}

const clamp = (value, min, max) => Math.min(max, Math.max(min, value))

function detectVisualType(file) {
  if (!file) return 'none'
  if (file.type?.startsWith('image/')) return 'image'
  if (file.type?.startsWith('video/')) return 'video'
  const name = file.name?.toLowerCase() || ''
  if (/\.(png|jpe?g|webp|bmp|gif)$/i.test(name)) return 'image'
  if (/\.(mp4|mov|webm|mkv|avi|m4v)$/i.test(name)) return 'video'
  return 'unknown'
}

function FileDropzone({ label, file, accept, hint, inputRef, optional = false, onFile }) {
  const [drag, setDrag] = useState(false)

  const select = selected => {
    if (selected) onFile(selected)
  }

  return (
    <div>
      <label className="block text-xs font-bold uppercase tracking-wider text-zinc-500 mb-2">
        {label}{optional ? ' (Optional)' : ' *'}
      </label>
      <div
        onClick={() => inputRef.current?.click()}
        onDragOver={event => { event.preventDefault(); setDrag(true) }}
        onDragLeave={() => setDrag(false)}
        onDrop={event => {
          event.preventDefault()
          setDrag(false)
          select(event.dataTransfer.files?.[0])
        }}
        className={`border p-4 cursor-pointer transition-colors ${drag ? 'border-white bg-zinc-900' : file ? 'border-zinc-700 bg-zinc-950' : 'border-zinc-900 bg-zinc-950 hover:border-zinc-700'}`}
      >
        <input ref={inputRef} className="hidden" type="file" accept={accept} onChange={event => select(event.target.files?.[0])} />
        {file ? (
          <div className="flex justify-between gap-2">
            <div className="min-w-0">
              <p className="text-sm text-white truncate">{file.name}</p>
              <p className="text-xs text-zinc-700 font-mono mt-1">{formatBytes(file.size)}</p>
            </div>
            <button
              type="button"
              className="text-zinc-700 hover:text-white text-xl"
              onClick={event => {
                event.stopPropagation()
                onFile(null)
                if (inputRef.current) inputRef.current.value = ''
              }}
            >
              ×
            </button>
          </div>
        ) : (
          <p className="text-xs text-zinc-600 text-center py-3">{hint}</p>
        )}
      </div>
    </div>
  )
}

function RangeField({ label, min, max, step, value, suffix = '', onChange }) {
  return (
    <label className="block">
      <div className="flex items-center justify-between gap-3 mb-2 text-xs uppercase tracking-wider">
        <span className="text-zinc-500 font-bold">{label}</span>
        <span className="text-zinc-700 font-mono">{value}{suffix}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={event => onChange(Number(event.target.value))}
        className="w-full accent-white"
      />
    </label>
  )
}

function SegmentedButtons({ label, options, value, onChange }) {
  return (
    <div>
      <label className="block text-xs font-bold uppercase tracking-wider text-zinc-500 mb-2">{label}</label>
      <div className="grid grid-cols-2 gap-2">
        {options.map(option => (
          <button
            key={option.value}
            type="button"
            onClick={() => onChange(option.value)}
            className={`border p-3 text-left transition-colors ${value === option.value ? 'border-zinc-600 bg-zinc-900 text-white' : 'border-zinc-800 text-zinc-500 hover:border-zinc-700'}`}
          >
            <span className="block text-xs font-bold">{option.label}</span>
            {option.description ? <span className="block text-xs text-zinc-700 mt-1">{option.description}</span> : null}
          </button>
        ))}
      </div>
    </div>
  )
}

function ColorField({ label, value, onChange, presets = [] }) {
  return (
    <div>
      <label className="block text-xs font-bold uppercase tracking-wider text-zinc-500 mb-2">{label}</label>
      <div className="flex items-center gap-3">
        <input type="color" value={value} onChange={event => onChange(event.target.value)} className="h-10 w-14 bg-transparent border border-zinc-800" />
        <input
          value={value}
          onChange={event => onChange(event.target.value)}
          className="flex-1 bg-zinc-950 border border-zinc-800 px-3 py-2 text-sm text-white font-mono outline-none focus:border-zinc-600"
        />
      </div>
      {presets.length > 0 ? (
        <div className="flex flex-wrap gap-2 mt-3">
          {presets.map(color => (
            <button
              key={color}
              type="button"
              onClick={() => onChange(color)}
              className={`h-7 w-7 border transition-transform ${value.toLowerCase() === color.toLowerCase() ? 'border-white scale-110' : 'border-zinc-800 hover:border-zinc-500'}`}
              style={{ backgroundColor: color }}
              title={color}
            />
          ))}
        </div>
      ) : null}
    </div>
  )
}

export default function WaveformVisualPage() {
  const [background, setBackground] = useState(null)
  const [audio, setAudio] = useState(null)
  const [audioDuration, setAudioDuration] = useState(null)
  const [outName, setOutName] = useState('waveform-visual.mp4')
  const [sysInfo, setSysInfo] = useState(null)
  const [config, setConfig] = useState(DEFAULT_WAVEFORM_VISUAL_CONFIG)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(null)
  const [success, setSuccess] = useState(false)
  const [playbackTime, setPlaybackTime] = useState(0)
  const [audioPlaying, setAudioPlaying] = useState(false)

  const backgroundInputRef = useRef(null)
  const audioInputRef = useRef(null)
  const audioElementRef = useRef(null)
  const previewFrameRef = useRef(null)
  const previewCanvasRef = useRef(null)
  const configRef = useRef(config)
  const animationRef = useRef(null)
  const resizeObserverRef = useRef(null)
  const audioContextRef = useRef(null)
  const analyserRef = useRef(null)
  const sourceNodeRef = useRef(null)
  const sampleBufferRef = useRef(null)

  const backgroundType = detectVisualType(background)
  const frameDimensions = getFrameDimensions(config.framePreset)
  const canRender = !!audio && sysInfo?.ffmpegInstalled && sysInfo?.ffprobeInstalled && !submitting
  const backgroundUrl = useMemo(() => (background ? URL.createObjectURL(background) : null), [background])
  const audioUrl = useMemo(() => (audio ? URL.createObjectURL(audio) : null), [audio])

  useEffect(() => {
    configRef.current = config
  }, [config])

  useEffect(() => {
    fetch('/api/system-info')
      .then(response => response.json())
      .then(setSysInfo)
      .catch(() => setSysInfo(null))
  }, [])

  useEffect(() => {
    return () => {
      if (backgroundUrl) URL.revokeObjectURL(backgroundUrl)
    }
  }, [backgroundUrl])

  useEffect(() => {
    const audioEl = audioElementRef.current
    if (!audioEl) return

    if (!audio) {
      audioEl.removeAttribute('src')
      audioEl.load()
      return
    }

    const onLoaded = () => setAudioDuration(audioEl.duration)
    const onTime = () => setPlaybackTime(audioEl.currentTime)
    const onPlay = () => {
      ensureAudioGraph()
      audioContextRef.current?.resume().catch(() => {})
      setAudioPlaying(true)
    }
    const onPause = () => setAudioPlaying(false)
    const onEnded = () => {
      setAudioPlaying(false)
      setPlaybackTime(audioEl.duration || 0)
    }

    audioEl.src = audioUrl
    audioEl.load()
    audioEl.addEventListener('loadedmetadata', onLoaded)
    audioEl.addEventListener('timeupdate', onTime)
    audioEl.addEventListener('play', onPlay)
    audioEl.addEventListener('pause', onPause)
    audioEl.addEventListener('ended', onEnded)

    return () => {
      audioEl.removeEventListener('loadedmetadata', onLoaded)
      audioEl.removeEventListener('timeupdate', onTime)
      audioEl.removeEventListener('play', onPlay)
      audioEl.removeEventListener('pause', onPause)
      audioEl.removeEventListener('ended', onEnded)
    }
  }, [audio, audioUrl])

  useEffect(() => {
    return () => {
      if (audioUrl) URL.revokeObjectURL(audioUrl)
    }
  }, [audioUrl])

  useEffect(() => {
    const frame = previewFrameRef.current
    const canvas = previewCanvasRef.current
    if (!frame || !canvas) return

    const resizeCanvas = () => {
      const rect = frame.getBoundingClientRect()
      const dpr = window.devicePixelRatio || 1
      canvas.width = Math.max(1, Math.floor(rect.width * dpr))
      canvas.height = Math.max(1, Math.floor(rect.height * dpr))
      canvas.style.width = `${rect.width}px`
      canvas.style.height = `${rect.height}px`
    }

    resizeCanvas()
    resizeObserverRef.current = new ResizeObserver(resizeCanvas)
    resizeObserverRef.current.observe(frame)
    window.addEventListener('resize', resizeCanvas)

    return () => {
      resizeObserverRef.current?.disconnect()
      resizeObserverRef.current = null
      window.removeEventListener('resize', resizeCanvas)
    }
  }, [])

  useEffect(() => {
    const renderFrame = time => {
      drawWaveformFrame(time)
      animationRef.current = window.requestAnimationFrame(renderFrame)
    }

    animationRef.current = window.requestAnimationFrame(renderFrame)
    return () => {
      if (animationRef.current) window.cancelAnimationFrame(animationRef.current)
    }
  }, [])

  useEffect(() => {
    return () => {
      if (audioContextRef.current) audioContextRef.current.close().catch(() => {})
    }
  }, [])

  function ensureAudioGraph() {
    const audioEl = audioElementRef.current
    const currentConfig = configRef.current
    if (!audioEl) return

    if (!audioContextRef.current) {
      const AudioContextCtor = window.AudioContext || window.webkitAudioContext
      if (!AudioContextCtor) return
      audioContextRef.current = new AudioContextCtor()
      analyserRef.current = audioContextRef.current.createAnalyser()
      analyserRef.current.fftSize = 2048
    }

    analyserRef.current.smoothingTimeConstant = currentConfig.smoothing
    sampleBufferRef.current = new Uint8Array(analyserRef.current.frequencyBinCount)

    if (!sourceNodeRef.current) {
      sourceNodeRef.current = audioContextRef.current.createMediaElementSource(audioEl)
      sourceNodeRef.current.connect(analyserRef.current)
      analyserRef.current.connect(audioContextRef.current.destination)
    }
  }

  function drawWaveformFrame(time) {
    const frame = previewFrameRef.current
    const canvas = previewCanvasRef.current
    const currentConfig = configRef.current
    if (!frame || !canvas) return

    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const dpr = window.devicePixelRatio || 1
    const width = canvas.width / dpr
    const height = canvas.height / dpr

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, width, height)

    const boxX = currentConfig.positionX * width
    const boxY = currentConfig.positionY * height
    const boxW = currentConfig.sizeWidth * width
    const boxH = currentConfig.sizeHeight * height
    const amplitudePx = (boxH * currentConfig.amplitude) / 2
    const layerGapPx = boxH * currentConfig.lineGap
    const analyser = analyserRef.current
    const audioEl = audioElementRef.current
    const sampleBuffer = sampleBufferRef.current

    let points = null
    if (analyser && sampleBuffer && audioEl && !audioEl.paused) {
      analyser.getByteTimeDomainData(sampleBuffer)
      points = sampleBuffer
    }

    const lineCount = Math.max(1, Math.round(currentConfig.lineCount))
    const timeSeed = time * 0.0012

    ctx.save()
    ctx.beginPath()
    ctx.rect(boxX, boxY, boxW, boxH)
    ctx.clip()

    for (let layer = 0; layer < lineCount; layer += 1) {
      const verticalOffset = (layer - (lineCount - 1) / 2) * layerGapPx
      const alpha = clamp(currentConfig.opacity - layer * 0.08, 0.08, 1)
      const phase = timeSeed + layer * 0.34
      const shift = layer * 6
      const centerY = boxY + boxH / 2 + verticalOffset

      ctx.beginPath()
      ctx.strokeStyle = currentConfig.waveformColor
      ctx.globalAlpha = alpha
      ctx.lineWidth = currentConfig.thickness + Math.max(0, (lineCount - layer - 1) * 0.05)
      ctx.shadowColor = currentConfig.glowColor
      ctx.shadowBlur = currentConfig.glowBlur * currentConfig.glowStrength

      const steps = Math.max(90, Math.floor(boxW / 5))
      for (let step = 0; step <= steps; step += 1) {
        const progress = step / steps
        let waveValue

        if (points) {
          const index = Math.floor((progress * (points.length - 1) + shift) % points.length)
          waveValue = (points[index] - 128) / 128
        } else {
          waveValue = (
            Math.sin(progress * Math.PI * 6 + phase)
            + Math.sin(progress * Math.PI * 10 - phase * 0.7) * 0.45
          ) * 0.55
        }

        const x = boxX + progress * boxW
        const waveEnvelope = 0.5 + 0.5 * Math.sin(progress * Math.PI)
        const y = centerY + waveValue * amplitudePx * waveEnvelope

        if (step === 0) {
          ctx.moveTo(x, y)
        } else {
          const prevX = boxX + ((step - 1) / steps) * boxW
          const controlX = (prevX + x) / 2
          ctx.quadraticCurveTo(controlX, y, x, y)
        }
      }

      ctx.stroke()
    }

    ctx.restore()

    ctx.save()
    ctx.strokeStyle = 'rgba(255,255,255,0.35)'
    ctx.setLineDash([8, 6])
    ctx.lineWidth = 1
    ctx.strokeRect(boxX, boxY, boxW, boxH)
    ctx.restore()
  }

  async function togglePlayback() {
    const audioEl = audioElementRef.current
    if (!audioEl) return

    ensureAudioGraph()
    if (audioEl.paused) {
      await audioContextRef.current?.resume().catch(() => {})
      await audioEl.play().catch(() => {})
    } else {
      audioEl.pause()
    }
  }

  function beginInteraction(type, event) {
    event.preventDefault()
    event.stopPropagation()

    const startConfig = configRef.current
    const startX = event.clientX
    const startY = event.clientY

    const onMove = moveEvent => {
      const frame = previewFrameRef.current
      if (!frame) return

      const rect = frame.getBoundingClientRect()
      const deltaX = (moveEvent.clientX - startX) / rect.width
      const deltaY = (moveEvent.clientY - startY) / rect.height

      setConfig(current => {
        const next = { ...current }

        if (type === 'drag') {
          next.positionX = startConfig.positionX + deltaX
          next.positionY = startConfig.positionY + deltaY
        } else {
          next.sizeWidth = clamp(startConfig.sizeWidth + deltaX, 0.12, 1 - current.positionX)
          next.sizeHeight = clamp(startConfig.sizeHeight + deltaY, 0.1, 1 - current.positionY)
        }

        return clampWaveBox(next)
      })
    }

    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  function updateConfig(partial) {
    setConfig(current => clampWaveBox({ ...current, ...partial }))
  }

  function handleBackground(file) {
    setError(null)
    if (!file) {
      setBackground(null)
      updateConfig({ backgroundMode: 'solid' })
      return
    }

    const visualType = detectVisualType(file)
    if (visualType === 'unknown') {
      setError('Background asset must be an image or video file.')
      return
    }

    setBackground(file)
    if (visualType === 'image' && configRef.current.backgroundMode === 'solid') updateConfig({ backgroundMode: 'still' })
    if (visualType === 'video' && ['solid', 'still'].includes(configRef.current.backgroundMode)) updateConfig({ backgroundMode: 'loop' })
  }

  async function submit(event) {
    event.preventDefault()
    setError(null)

    if (!audio) {
      setError('Select an audio track before rendering.')
      return
    }

    if (background && backgroundType === 'unknown') {
      setError('Background asset must be an image or video file.')
      return
    }

    setSubmitting(true)
    try {
      const body = new FormData()
      body.append('audio', audio)
      if (background) body.append('background', background)
      body.append('filename', outName || 'waveform-visual.mp4')
      body.append('waveform_config', JSON.stringify(sanitizeWaveformVisualConfig(configRef.current)))

      const response = await fetch('/api/waveform-visual-jobs', {
        method: 'POST',
        body,
      })

      if (!response.ok) {
        throw new Error((await response.json().catch(() => ({}))).error || 'Server rejected the request.')
      }

      setSuccess(true)
    } catch (err) {
      setError(err.message)
    } finally {
      setSubmitting(false)
    }
  }

  const showBackgroundPreview = !!background && config.backgroundMode !== 'solid'
  const previewBgStyle = showBackgroundPreview ? null : { background: config.backgroundColor }
  const backgroundMotionOptions = background
    ? backgroundType === 'image'
      ? [
          { value: 'still', label: 'Still', description: 'Static framed background' },
          { value: 'loop', label: 'Loop', description: 'Subtle Ken Burns motion' },
          { value: 'pingpong', label: 'Ping Pong', description: 'Slow zoom pulse' },
          { value: 'solid', label: 'Solid Color', description: 'Ignore the upload and use a clean fill' },
        ]
      : [
          { value: 'loop', label: 'Loop', description: 'Repeat the background video' },
          { value: 'pingpong', label: 'Ping Pong', description: 'Forward and reverse loop' },
          { value: 'solid', label: 'Solid Color', description: 'Ignore the upload and use a clean fill' },
        ]
    : [
        { value: 'solid', label: 'Solid Color', description: 'Render over a color background' },
      ]

  return (
    <Layout>
      <div className="max-w-screen-xl mx-auto px-6 py-8">
        <div className="max-w-3xl">
          <h2 className="text-xs font-bold uppercase tracking-widest text-zinc-400 mb-2">Waveform Visualizer</h2>
          <p className="text-xs text-zinc-600">
            Build a glowing audio-reactive waveform, place it anywhere on the frame, resize it live, and render a finished MP4 over a solid, image, or video background.
          </p>
        </div>

        {success ? (
          <div className="border border-zinc-800 p-8 text-center space-y-4 mt-8 max-w-3xl">
            <p className="text-sm text-white">Waveform video render queued.</p>
            <p className="text-xs text-zinc-600">Track progress in the <Link to="/history" className="text-white underline">history view</Link>.</p>
            <button
              className="text-xs font-mono text-zinc-500 hover:text-white"
              onClick={() => {
                setSuccess(false)
                setError(null)
              }}
            >
              Render another
            </button>
          </div>
        ) : (
          <form className="grid grid-cols-1 xl:grid-cols-[minmax(0,1.15fr)_420px] gap-8 mt-8" onSubmit={submit}>
            <section className="space-y-6">
              <div className="border border-zinc-900 bg-zinc-950/40 p-4">
                <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
                  <div>
                    <p className="text-xs font-bold uppercase tracking-widest text-zinc-500">Live Preview</p>
                    <p className="text-xs text-zinc-700 mt-1">
                      Drag the waveform box to reposition it. Use the corner handle or size sliders to resize it.
                    </p>
                  </div>
                  <div className="flex items-center gap-2 text-xs font-mono text-zinc-600">
                    <span>{frameDimensions.width}x{frameDimensions.height}</span>
                    {audio && <span>{formatDuration(audioDuration)}</span>}
                  </div>
                </div>

                <div
                  ref={previewFrameRef}
                  className="relative w-full overflow-hidden border border-zinc-900 bg-black"
                  style={{ aspectRatio: `${frameDimensions.width} / ${frameDimensions.height}`, ...previewBgStyle }}
                >
                  {showBackgroundPreview && backgroundType === 'image' ? (
                    <img
                      src={backgroundUrl || undefined}
                      alt=""
                      className="absolute inset-0 w-full h-full object-cover pointer-events-none"
                    />
                  ) : null}
                  {showBackgroundPreview && backgroundType === 'video' ? (
                    <video
                      src={backgroundUrl || undefined}
                      className="absolute inset-0 w-full h-full object-cover pointer-events-none"
                      autoPlay
                      muted
                      loop
                      playsInline
                    />
                  ) : null}

                  <canvas ref={previewCanvasRef} className="absolute inset-0 w-full h-full pointer-events-none" />

                  <div
                    className="absolute border border-white/50 bg-white/5 cursor-move"
                    style={{
                      left: `${config.positionX * 100}%`,
                      top: `${config.positionY * 100}%`,
                      width: `${config.sizeWidth * 100}%`,
                      height: `${config.sizeHeight * 100}%`,
                    }}
                    onPointerDown={event => beginInteraction('drag', event)}
                  >
                    <div className="absolute top-2 left-2 text-[10px] font-mono uppercase tracking-wider text-white/80 bg-black/40 px-2 py-1">
                      Wave box
                    </div>
                    <button
                      type="button"
                      aria-label="Resize waveform box"
                      className="absolute right-0 bottom-0 h-5 w-5 border-l border-t border-white/60 bg-black/70 cursor-se-resize"
                      onPointerDown={event => beginInteraction('resize', event)}
                    />
                  </div>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-3 mt-4">
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={togglePlayback}
                      disabled={!audio}
                      className="px-4 py-2 text-xs font-bold uppercase tracking-wider bg-white text-black hover:bg-zinc-200 disabled:bg-zinc-900 disabled:text-zinc-700 disabled:cursor-not-allowed"
                    >
                      {audioPlaying ? 'Pause Preview' : 'Play Preview'}
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfig(DEFAULT_WAVEFORM_VISUAL_CONFIG)}
                      className="px-4 py-2 text-xs uppercase tracking-wider border border-zinc-800 text-zinc-500 hover:border-zinc-700 hover:text-white"
                    >
                      Reset Style
                    </button>
                    <button
                      type="button"
                      onClick={() => updateConfig({
                        positionX: 0.5 - config.sizeWidth / 2,
                        positionY: 0.5 - config.sizeHeight / 2,
                      })}
                      className="px-4 py-2 text-xs uppercase tracking-wider border border-zinc-800 text-zinc-500 hover:border-zinc-700 hover:text-white"
                    >
                      Center Box
                    </button>
                  </div>
                  <span className="text-xs font-mono text-zinc-700">
                    {formatDuration(playbackTime)} / {formatDuration(audioDuration)}
                  </span>
                </div>

                <audio ref={audioElementRef} src={audioUrl || undefined} className="w-full mt-4" controls />
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <FileDropzone
                  label="Audio Track"
                  file={audio}
                  accept="audio/*"
                  hint="Drop the audio track that will drive the waveform"
                  inputRef={audioInputRef}
                  onFile={file => {
                    setError(null)
                    if (!file) {
                      setAudioDuration(null)
                      setPlaybackTime(0)
                      setAudioPlaying(false)
                    }
                    setAudio(file)
                    if (file && (!outName || outName === 'waveform-visual.mp4')) {
                      const stem = file.name.replace(/\.[^.]+$/, '') || 'waveform-visual'
                      setOutName(`${stem}_waveform.mp4`)
                    }
                  }}
                />
                <FileDropzone
                  label="Background Asset"
                  file={background}
                  accept="image/*,video/*,.mkv"
                  hint="Optional image or video behind the waveform"
                  inputRef={backgroundInputRef}
                  optional
                  onFile={handleBackground}
                />
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-6 border border-zinc-900 p-4">
                <SegmentedButtons
                  label="Frame Format"
                  value={config.framePreset}
                  onChange={value => updateConfig({ framePreset: value })}
                  options={Object.entries(FRAME_PRESETS).map(([value, preset]) => ({
                    value,
                    label: preset.label,
                    description: `${preset.width}x${preset.height}`,
                  }))}
                />

                <SegmentedButtons
                  label="Background Motion"
                  value={background ? config.backgroundMode : 'solid'}
                  onChange={value => updateConfig({ backgroundMode: value })}
                  options={backgroundMotionOptions}
                />
              </div>
            </section>

            <aside className="space-y-6">
              <div className="border border-zinc-900 p-4 space-y-4">
                <p className="text-xs font-bold uppercase tracking-widest text-zinc-500">Color + Glow</p>
                <ColorField label="Wave Color" value={config.waveformColor} onChange={value => updateConfig({ waveformColor: value })} presets={WAVEFORM_COLOR_PRESETS} />
                <ColorField label="Glow Color" value={config.glowColor} onChange={value => updateConfig({ glowColor: value })} presets={WAVEFORM_COLOR_PRESETS} />
                <ColorField label="Background Color" value={config.backgroundColor} onChange={value => updateConfig({ backgroundColor: value })} />
                <RangeField label="Opacity" min={0.1} max={1} step={0.01} value={config.opacity} onChange={value => updateConfig({ opacity: value })} />
                <RangeField label="Glow Strength" min={0} max={1.5} step={0.01} value={config.glowStrength} onChange={value => updateConfig({ glowStrength: value })} />
                <RangeField label="Glow Blur" min={0} max={48} step={1} value={config.glowBlur} onChange={value => updateConfig({ glowBlur: value })} />
              </div>

              <div className="border border-zinc-900 p-4 space-y-4">
                <p className="text-xs font-bold uppercase tracking-widest text-zinc-500">Wave Shape</p>
                <RangeField label="Line Count" min={1} max={8} step={1} value={config.lineCount} onChange={value => updateConfig({ lineCount: value })} />
                <RangeField label="Line Gap" min={0} max={0.12} step={0.002} value={config.lineGap} onChange={value => updateConfig({ lineGap: value })} />
                <RangeField label="Thickness" min={1} max={6} step={0.1} value={config.thickness} onChange={value => updateConfig({ thickness: value })} />
                <RangeField label="Amplitude" min={0.2} max={1} step={0.01} value={config.amplitude} onChange={value => updateConfig({ amplitude: value })} />
                <RangeField label="Trail Delay" min={0} max={24} step={1} value={config.trailDelayMs} suffix=" ms" onChange={value => updateConfig({ trailDelayMs: value })} />
                <RangeField label="Smoothing" min={0} max={0.98} step={0.01} value={config.smoothing} onChange={value => updateConfig({ smoothing: value })} />
              </div>

              <div className="border border-zinc-900 p-4 space-y-4">
                <p className="text-xs font-bold uppercase tracking-widest text-zinc-500">Placement + Size</p>
                <RangeField label="Width" min={0.12} max={1} step={0.01} value={config.sizeWidth} onChange={value => updateConfig({ sizeWidth: value })} />
                <RangeField label="Height" min={0.1} max={0.85} step={0.01} value={config.sizeHeight} onChange={value => updateConfig({ sizeHeight: value })} />
                <RangeField label="X Position" min={0} max={Math.max(0, 1 - config.sizeWidth)} step={0.005} value={config.positionX} onChange={value => updateConfig({ positionX: value })} />
                <RangeField label="Y Position" min={0} max={Math.max(0, 1 - config.sizeHeight)} step={0.005} value={config.positionY} onChange={value => updateConfig({ positionY: value })} />
                <div className="grid grid-cols-2 gap-2 text-xs font-mono text-zinc-700 border border-zinc-900 bg-black px-3 py-3">
                  <span>X: {(config.positionX * 100).toFixed(1)}%</span>
                  <span>Y: {(config.positionY * 100).toFixed(1)}%</span>
                  <span>W: {(config.sizeWidth * 100).toFixed(1)}%</span>
                  <span>H: {(config.sizeHeight * 100).toFixed(1)}%</span>
                </div>
              </div>

              <div className="border border-zinc-900 p-4 space-y-4">
                <p className="text-xs font-bold uppercase tracking-widest text-zinc-500">Output</p>
                <div>
                  <label className="block text-xs font-bold uppercase tracking-wider text-zinc-500 mb-2">Output Filename</label>
                  <input
                    value={outName}
                    onChange={event => setOutName(event.target.value)}
                    className="w-full bg-zinc-950 border border-zinc-800 px-3 py-2 text-sm text-white font-mono outline-none focus:border-zinc-600"
                  />
                </div>
                {audio && (
                  <div className="border border-zinc-900 px-4 py-3 flex justify-between text-xs font-mono">
                    <span className="text-zinc-600">Render duration</span>
                    <span className="text-white">{formatDuration(audioDuration)}</span>
                  </div>
                )}
                {sysInfo && (!sysInfo.ffmpegInstalled || !sysInfo.ffprobeInstalled) && (
                  <p className="border border-red-900 bg-red-950/20 px-4 py-3 text-xs text-red-400">
                    FFmpeg and FFprobe are required. Configure them in <Link className="text-white underline" to="/settings">Settings</Link>.
                  </p>
                )}
                {error && <p className="border border-red-900 bg-red-950/20 px-4 py-3 text-xs text-red-400">{error}</p>}
                <button
                  disabled={!canRender}
                  className="w-full py-3 text-sm font-bold uppercase tracking-widest bg-white text-black hover:bg-zinc-200 disabled:bg-zinc-900 disabled:text-zinc-700 disabled:cursor-not-allowed"
                >
                  {submitting ? 'Queueing Render...' : 'Render Waveform Video'}
                </button>
              </div>
            </aside>
          </form>
        )}
      </div>
    </Layout>
  )
}
