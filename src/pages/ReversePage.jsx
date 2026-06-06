import { useState, useEffect, useRef } from 'react'
import { Link } from 'react-router-dom'
import Layout from '../components/Layout'

// ─── Utilities ───────────────────────────────────────────────────────────────

const formatBytes = (bytes) => {
  if (!bytes || bytes <= 0 || isNaN(bytes)) return '—'
  const units = ['B', 'KB', 'MB', 'GB']
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), 3)
  return `${(bytes / Math.pow(1024, i)).toFixed(i >= 2 ? 1 : 0)} ${units[i]}`
}

const formatDuration = (sec) => {
  if (!sec || isNaN(sec) || sec < 0) return '—'
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = Math.floor(sec % 60)
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function Label({ children }) {
  return (
    <label className="block text-xs font-bold uppercase tracking-wider text-zinc-500 mb-2">
      {children}
    </label>
  )
}

function ToggleBtn({ active, onClick, children, disabled }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`py-1.5 text-xs font-mono border transition-colors
        ${disabled
          ? 'border-zinc-800 text-zinc-600 opacity-30 cursor-not-allowed pointer-events-none'
          : active
            ? 'border-zinc-600 bg-zinc-900 text-white'
            : 'border-zinc-800 text-zinc-600 hover:border-zinc-700 hover:text-zinc-400'}`}
    >
      {children}
    </button>
  )
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function ReversePage() {
  // File state
  const [videoFile, setVideoFile] = useState(null)
  const [videoDrag, setVideoDrag] = useState(false)

  // Probe state
  const [probing, setProbing] = useState(false)
  const [probeResult, setProbeResult] = useState(null)
  const [probeError, setProbeError] = useState(null)

  // Form state
  const [outName, setOutName] = useState('')
  const [loopCount, setLoopCount] = useState(1)
  const [reverseMode, setReverseMode] = useState('video')
  const [loopStyle, setLoopStyle] = useState('pingpong')
  const [audioFade, setAudioFade] = useState('short')
  const [hwMode, setHwMode] = useState('auto')

  // Submit state
  const [submitting, setSubmitting] = useState(false)
  const [formErr, setFormErr] = useState(null)
  const [success, setSuccess] = useState(false)

  // System info
  const [sysInfo, setSysInfo] = useState({
    ffmpegInstalled: false,
    gpuEncoders: { nvenc: false, amf: false, qsv: false },
    ffmpegPath: 'ffmpeg',
  })
  const [sysInfoReady, setSysInfoReady] = useState(false)

  const videoInputRef = useRef(null)

  // ─── On mount: fetch system info ─────────────────────────────────────────

  useEffect(() => {
    const load = async () => {
      try {
        const r = await fetch('/api/system-info')
        if (r.ok) {
          const d = await r.json()
          setSysInfo(d)
        }
      } catch { /* silent */ } finally {
        setSysInfoReady(true)
      }
    }
    load()
  }, [])

  // ─── Auto-probe when videoFile changes ───────────────────────────────────

  useEffect(() => {
    if (!videoFile) {
      const resetProbe = setTimeout(() => {
        setProbeResult(null)
        setProbeError(null)
      }, 0)
      return () => clearTimeout(resetProbe)
    }

    let cancelled = false

    const probe = async () => {
      setProbing(true)
      setProbeResult(null)
      setProbeError(null)

      try {
        const fd = new FormData()
        fd.append('video', videoFile)
        const r = await fetch('/api/probe', { method: 'POST', body: fd })
        if (!r.ok) {
          const d = await r.json().catch(() => ({}))
          throw new Error(d.error || 'Failed to analyze video.')
        }
        const data = await r.json()
        if (!cancelled) setProbeResult(data)
      } catch (err) {
        if (!cancelled) setProbeError(err.message)
      } finally {
        if (!cancelled) setProbing(false)
      }
    }

    probe()

    return () => { cancelled = true }
  }, [videoFile])

  // ─── Computed values ──────────────────────────────────────────────────────

  const targetDuration = probeResult ? Math.ceil(probeResult.duration * loopCount) : null
  const targetDurationDisplay = targetDuration !== null ? formatDuration(targetDuration) : null

  const gpuLabel = sysInfo.gpuEncoders?.nvenc ? 'NVENC'
    : sysInfo.gpuEncoders?.amf ? 'AMF'
    : sysInfo.gpuEncoders?.qsv ? 'QSV'
    : 'None'

  const isFormValid = !!(videoFile && probeResult && !probing && sysInfoReady && sysInfo.ffmpegInstalled)

  // ─── Drag & drop handlers ─────────────────────────────────────────────────

  const onVideoDrop = (e) => {
    e.preventDefault()
    setVideoDrag(false)
    const f = e.dataTransfer.files[0]
    if (!f) return
    if (f.type.startsWith('video/') || /\.(mp4|mov|webm|mkv|avi|m4v)$/i.test(f.name)) {
      setVideoFile(f)
      if (!outName) setOutName(f.name)
    }
  }

  const clearVideo = (e) => {
    e.stopPropagation()
    setVideoFile(null)
    setOutName('')
    if (videoInputRef.current) videoInputRef.current.value = ''
  }

  // ─── Submit ───────────────────────────────────────────────────────────────

  const handleSubmit = async (e) => {
    e.preventDefault()
    setFormErr(null)

    if (!videoFile) return setFormErr('No video file selected.')
    if (!probeResult) return setFormErr('Video analysis not complete.')
    if (!sysInfo.ffmpegInstalled) return setFormErr('FFmpeg is not installed or not found in PATH.')

    const effectiveDuration = Math.max(60, targetDuration ?? 60)

    setSubmitting(true)
    try {
      const fd = new FormData()
      fd.append('video', videoFile)
      fd.append('target_duration', effectiveDuration)
      fd.append('crossfade', '0')
      fd.append('hw_accel', hwMode)
      fd.append('filename', outName || videoFile.name)
      fd.append('reverse_mode', reverseMode)
      fd.append('loop_style', loopStyle)
      fd.append('audio_fade', audioFade)

      const r = await fetch('/api/jobs', { method: 'POST', body: fd })
      if (!r.ok) {
        const d = await r.json().catch(() => ({}))
        throw new Error(d.error || 'Server rejected the request.')
      }

      // Reset form on success
      setSuccess(true)
      setVideoFile(null)
      setProbeResult(null)
      setOutName('')
      setLoopCount(1)
      if (videoInputRef.current) videoInputRef.current.value = ''
    } catch (err) {
      setFormErr(err.message)
    } finally {
      setSubmitting(false)
    }
  }

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <Layout>
      <div className="max-w-2xl mx-auto px-6 py-8">

        <h2 className="text-xs font-bold uppercase tracking-widest text-zinc-400 mb-6">Reverse Video</h2>

        {/* ── Success state ────────────────────────────────────────────── */}
        {success ? (
          <div className="border border-zinc-800 p-8 text-center space-y-4">
            <p className="text-sm text-white">Job queued successfully.</p>
            <p className="text-xs text-zinc-600">
              Track progress in the{' '}
              <Link to="/loop" className="text-white underline">Loop Generator</Link> library.
            </p>
            <button
              onClick={() => setSuccess(false)}
              className="text-xs text-zinc-600 hover:text-white font-mono transition-colors"
            >
              ← Reverse another video
            </button>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-6">

            {/* ── 1. Video dropzone ───────────────────────────────────── */}
            <div>
              <Label>Video Source *</Label>
              <div
                onDragOver={e => { e.preventDefault(); setVideoDrag(true) }}
                onDragLeave={() => setVideoDrag(false)}
                onDrop={onVideoDrop}
                onClick={() => videoInputRef.current?.click()}
                className={`border cursor-pointer transition-colors p-4
                  ${videoDrag
                    ? 'border-white bg-zinc-900'
                    : videoFile
                      ? 'border-zinc-700 bg-zinc-950'
                      : 'border-zinc-900 hover:border-zinc-800 bg-zinc-950'}`}
              >
                <input
                  type="file"
                  ref={videoInputRef}
                  accept="video/*,.mkv"
                  className="hidden"
                  onChange={e => {
                    const f = e.target.files?.[0]
                    if (f) {
                      setVideoFile(f)
                      if (!outName) setOutName(f.name)
                    }
                  }}
                />
                {videoFile ? (
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <span className="text-xs font-mono text-zinc-500">VIDEO</span>
                      <p className="text-sm text-white font-medium truncate mt-0.5">{videoFile.name}</p>
                      <p className="text-xs text-zinc-700 font-mono mt-0.5">{formatBytes(videoFile.size)}</p>
                    </div>
                    <button
                      type="button"
                      onClick={clearVideo}
                      className="text-zinc-700 hover:text-white transition-colors text-xl leading-none shrink-0"
                    >
                      ×
                    </button>
                  </div>
                ) : (
                  <div className="text-center py-3">
                    <p className="text-xs text-zinc-600">Drop video or click to browse</p>
                    <p className="text-xs text-zinc-800 mt-1">MP4 · MOV · WEBM · MKV</p>
                  </div>
                )}
              </div>
            </div>

            {/* ── 2. Probe result panel ────────────────────────────────── */}
            {(probing || probeResult || probeError) && (
              <div>
                {probing && (
                  <div className="flex items-center gap-2 py-2 text-xs text-zinc-500 font-mono">
                    <span className="w-1.5 h-1.5 rounded-full bg-zinc-500 animate-pulse" />
                    Analyzing...
                  </div>
                )}

                {probeError && !probing && (
                  <div className="border border-red-900 bg-red-950/20 px-4 py-3 text-xs text-red-400">
                    {probeError}
                  </div>
                )}

                {probeResult && !probing && (
                  <div className="border border-zinc-900 px-4 py-3">
                    <div className="grid grid-cols-3 gap-3">
                      <div>
                        <span className="block text-xs text-zinc-600 font-mono">Duration</span>
                        <span className="block text-xs text-white font-mono font-medium mt-0.5">
                          {formatDuration(probeResult.duration)}
                        </span>
                      </div>
                      <div>
                        <span className="block text-xs text-zinc-600 font-mono">FPS</span>
                        <span className="block text-xs text-white font-mono font-medium mt-0.5">
                          {Number(probeResult.fps).toFixed(2)}
                        </span>
                      </div>
                      <div>
                        <span className="block text-xs text-zinc-600 font-mono">Resolution</span>
                        <span className="block text-xs text-white font-mono font-medium mt-0.5">
                          {probeResult.width}×{probeResult.height}
                        </span>
                      </div>
                      <div>
                        <span className="block text-xs text-zinc-600 font-mono">Codec</span>
                        <span className="block text-xs text-white font-mono font-medium mt-0.5">
                          {String(probeResult.codec).toUpperCase()}
                        </span>
                      </div>
                      <div>
                        <span className="block text-xs text-zinc-600 font-mono">Audio</span>
                        <span className={`block text-xs font-mono font-medium mt-0.5 ${probeResult.hasAudio ? 'text-emerald-400' : 'text-zinc-600'}`}>
                          {probeResult.hasAudio ? 'Yes' : 'No'}
                        </span>
                      </div>
                    </div>
                    {targetDuration !== null && targetDuration < 60 && (
                      <p className="text-xs text-amber-400 font-mono mt-2">
                        Output will be padded to 60s minimum
                      </p>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* ── 3. Output Filename ───────────────────────────────────── */}
            {videoFile && (
              <div>
                <Label>Output Filename</Label>
                <input
                  value={outName}
                  onChange={e => setOutName(e.target.value)}
                  placeholder={videoFile?.name || 'output'}
                  className="w-full bg-zinc-950 border border-zinc-800 px-3 py-2 text-sm text-white font-mono focus:border-zinc-600 outline-none placeholder-zinc-700 transition-colors"
                />
              </div>
            )}

            {/* ── 4. Loop Count ────────────────────────────────────────── */}
            <div>
              <Label>Loop Count</Label>
              <div className="grid grid-cols-5 gap-2">
                {[1, 2, 3, 5, 10].map(n => (
                  <ToggleBtn key={n} active={loopCount === n} onClick={() => setLoopCount(n)}>
                    {n}×
                  </ToggleBtn>
                ))}
              </div>
              {targetDurationDisplay && (
                <p className="text-xs text-zinc-700 font-mono mt-1.5">
                  → {targetDurationDisplay} total
                </p>
              )}
            </div>

            {/* ── 5. Reverse Options ───────────────────────────────────── */}
            <div>
              <Label>Reverse Options</Label>
              <div className="grid grid-cols-4 gap-2">
                {[
                  ['disabled', 'Off'],
                  ['video',    'Video'],
                  ['audio',    'Audio'],
                  ['both',     'Both'],
                ].map(([v, lbl]) => {
                  const needsAudio = v === 'audio' || v === 'both'
                  const dimmed = needsAudio && !probeResult?.hasAudio
                  return (
                    <ToggleBtn
                      key={v}
                      active={reverseMode === v}
                      onClick={() => setReverseMode(v)}
                      disabled={dimmed}
                    >
                      {lbl}
                    </ToggleBtn>
                  )
                })}
              </div>
              <p className="mt-1.5 text-xs text-zinc-700">
                {reverseMode === 'disabled'
                  ? 'Normal forward playback.'
                  : reverseMode === 'video'
                    ? 'Video reversed · audio plays forward.'
                    : reverseMode === 'audio'
                      ? 'Audio reversed · video plays forward.'
                      : 'Both video and audio reversed.'}
              </p>
            </div>

            {/* ── 6. Loop Style ────────────────────────────────────────── */}
            <div>
              <Label>Loop Style</Label>
              <div className="grid grid-cols-3 gap-2">
                {[
                  ['standard',  'Standard',  '▶ ▶ ▶ ▶', 'Clip repeats forward.'],
                  ['reverse',   'Reverse',   '◀ ◀ ◀ ◀', 'Clip plays end to start.'],
                  ['pingpong',  'Ping Pong', '▶ ◀ ▶ ◀', 'Forward then backward — seamless bounce.'],
                ].map(([v, lbl, glyph]) => (
                  <button
                    key={v}
                    type="button"
                    onClick={() => setLoopStyle(v)}
                    className={`p-2.5 text-left border transition-colors
                      ${loopStyle === v
                        ? 'border-zinc-600 bg-zinc-900 text-white'
                        : 'border-zinc-800 text-zinc-500 hover:border-zinc-700 hover:text-zinc-300'}`}
                  >
                    <div className="text-xs font-bold">{lbl}</div>
                    <div className="text-xs font-mono mt-1 text-zinc-700 tracking-widest">{glyph}</div>
                  </button>
                ))}
              </div>
              <p className="mt-1.5 text-xs text-zinc-700">
                {loopStyle === 'standard' && 'Clip repeats forward.'}
                {loopStyle === 'reverse'  && 'Clip plays end to start.'}
                {loopStyle === 'pingpong' && 'Forward then backward — seamless bounce.'}
              </p>
            </div>

            {/* ── 7. Smooth Audio Transition ───────────────────────────── */}
            {(reverseMode !== 'disabled' || loopStyle !== 'standard') && (
              <div>
                <Label>Smooth Audio Transition</Label>
                <div className="grid grid-cols-4 gap-2">
                  {[
                    ['off',    'Off'],
                    ['short',  '0.1s'],
                    ['medium', '0.3s'],
                    ['long',   '0.5s'],
                  ].map(([v, lbl]) => (
                    <ToggleBtn key={v} active={audioFade === v} onClick={() => setAudioFade(v)}>
                      {lbl}
                    </ToggleBtn>
                  ))}
                </div>
              </div>
            )}

            {/* ── 8. Render Engine ─────────────────────────────────────── */}
            <div>
              <Label>Render Engine</Label>
              <div className="grid grid-cols-3 gap-2">
                {[
                  ['auto', 'Auto', 'Direct copy · fastest · lossless'],
                  ['gpu',  'GPU',  gpuLabel !== 'None' ? gpuLabel : 'No GPU'],
                  ['cpu',  'CPU',  'libx264 software encode'],
                ].map(([v, lbl, desc]) => (
                  <button
                    key={v}
                    type="button"
                    onClick={() => setHwMode(v)}
                    className={`p-2.5 text-left border transition-colors
                      ${hwMode === v
                        ? 'border-zinc-600 bg-zinc-900 text-white'
                        : 'border-zinc-800 text-zinc-500 hover:border-zinc-700 hover:text-zinc-300'}`}
                  >
                    <div className="text-xs font-bold">{lbl}</div>
                    <div className="text-xs text-zinc-700 mt-0.5 leading-tight">{desc}</div>
                  </button>
                ))}
              </div>
            </div>

            {/* ── 9. FFmpeg not installed alert ────────────────────────── */}
            {sysInfoReady && !sysInfo.ffmpegInstalled && (
              <div className="border border-red-900 bg-red-950/20 px-4 py-3 text-xs text-red-400">
                FFmpeg not detected. Install FFmpeg or configure in{' '}
                <Link to="/settings" className="text-white underline">Settings</Link>.
              </div>
            )}

            {/* ── 10. Form error ───────────────────────────────────────── */}
            {formErr && (
              <div className="border border-red-900 bg-red-950/20 px-4 py-3 text-xs text-red-400">
                {formErr}
              </div>
            )}

            {/* ── 11. Submit button ────────────────────────────────────── */}
            <button
              type="submit"
              disabled={submitting || !isFormValid}
              className="w-full py-3 text-sm font-bold uppercase tracking-widest transition-colors bg-white text-black hover:bg-zinc-200 disabled:bg-zinc-900 disabled:text-zinc-700 disabled:cursor-not-allowed"
            >
              {submitting ? 'Uploading…' : 'Generate Reverse'}
            </button>

          </form>
        )}
      </div>
    </Layout>
  )
}
