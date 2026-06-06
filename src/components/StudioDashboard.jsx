import { useState, useEffect, useRef } from 'react'
import { Link } from 'react-router-dom'
import PreviewModal from './PreviewModal'
import LogViewer from './LogViewer'

// ─── Utilities ──────────────────────────────────────────────────────────────

const basename = (p) => {
  if (!p) return ''
  return p.replace(/\\/g, '/').split('/').pop()
}

const formatBytes = (bytes) => {
  if (!bytes || bytes <= 0 || isNaN(bytes)) return '—'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), 4)
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

const formatDate = (iso) => {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleString('en-US', {
      month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit', hour12: false
    })
  } catch { return '—' }
}

const STATUS_MAP = {
  pending:     { label: 'PENDING',     cls: 'text-zinc-500',  dot: false },
  preparing:   { label: 'PREPARING',   cls: 'text-amber-400', dot: true  },
  processing:  { label: 'RENDERING',   cls: 'text-white',     dot: true  },
  finalizing:  { label: 'FINALIZING',  cls: 'text-white',     dot: true  },
  completed:   { label: 'COMPLETE',    cls: 'text-emerald-400', dot: false },
  failed:      { label: 'FAILED',      cls: 'text-red-400',   dot: false },
  cancelled:   { label: 'CANCELLED',   cls: 'text-zinc-600',  dot: false },
  interrupted: { label: 'INTERRUPTED', cls: 'text-amber-400', dot: false },
}

// ─── Main Component ──────────────────────────────────────────────────────────

export default function StudioDashboard() {
  // System info — sysInfoReady stays false until the first API response lands,
  // preventing the FFmpeg warning from flashing before we actually know the status.
  const [sysInfo, setSysInfo] = useState({
    ffmpegInstalled: false,
    ffprobeInstalled: false,
    gpuEncoders: { nvenc: false, amf: false, qsv: false, list: [] },
    diskSpace: { free: null, total: null },
    ffmpegPath: 'ffmpeg',
    ffprobePath: 'ffprobe',
  })
  const [sysInfoReady, setSysInfoReady] = useState(false)

  // Jobs
  const [jobs, setJobs] = useState([])

  // Form
  const [videoFile, setVideoFile] = useState(null)
  const [audioFile, setAudioFile] = useState(null)
  const [hours, setHours] = useState('01')
  const [mins, setMins] = useState('30')
  const [secs, setSecs] = useState('00')
  const [crossfade, setCrossfade] = useState('0')
  const [hwMode, setHwMode] = useState('auto')
  const [outName, setOutName] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [formErr, setFormErr] = useState(null)

  // Reverse / loop settings
  const [reverseMode, setReverseMode] = useState('disabled')
  const [loopStyle, setLoopStyle] = useState('standard')
  const [audioFade, setAudioFade] = useState('off')

  // Drag state
  const [videoDrag, setVideoDrag] = useState(false)
  const [audioDrag, setAudioDrag] = useState(false)

  // Library controls
  const [filter, setFilter] = useState('all')
  const [search, setSearch] = useState('')
  const [sortBy, setSortBy] = useState('newest')

  // Modals
  const [previewUrl, setPreviewUrl] = useState(null)
  const [previewName, setPreviewName] = useState('')
  const [logJobId, setLogJobId] = useState(null)
  const [logJobName, setLogJobName] = useState('')

  // Custom confirm dialog (replaces window.confirm)
  const [dialog, setDialog] = useState(null)

  // Notification banner
  const [notification, setNotification] = useState(null)

  const videoInputRef = useRef(null)
  const audioInputRef = useRef(null)

  // ─── Data Loading ──────────────────────────────────────────────────────────

  const loadJobs = async () => {
    try {
      const r = await fetch('/api/jobs')
      if (r.ok) setJobs(await r.json())
    } catch { /* silent - WS handles updates */ }
  }

  const loadSysInfo = async () => {
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

  useEffect(() => {
    const initialLoad = setTimeout(() => {
      loadJobs()
      loadSysInfo()
    }, 0)

    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const ws = new WebSocket(`${proto}//localhost:5000`)

    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data)
        if (msg.type === 'job_update' && msg.job) {
          setJobs(prev => {
            const idx = prev.findIndex(j => j.id === msg.job.id)
            if (idx === -1) return [msg.job, ...prev]
            const next = [...prev]
            next[idx] = msg.job
            return next
          })
          if (['completed', 'failed', 'cancelled'].includes(msg.job.status)) {
            loadSysInfo()
          }
        }
      } catch { /* ignore malformed messages */ }
    }

    ws.onerror = () => { /* silent - app works without WS */ }

    return () => {
      clearTimeout(initialLoad)
      try { ws.close() } catch { /* ignore */ }
    }
  }, [])

  // ─── Computed Values ───────────────────────────────────────────────────────

  const targetSec =
    (parseInt(hours || '0', 10) * 3600) +
    (parseInt(mins || '0', 10) * 60) +
    (parseInt(secs || '0', 10))

  const isFormValid = !!videoFile && targetSec >= 60 && sysInfoReady && sysInfo.ffmpegInstalled

  const gpuLabel = sysInfo.gpuEncoders.nvenc ? 'NVENC'
    : sysInfo.gpuEncoders.amf ? 'AMF'
    : sysInfo.gpuEncoders.qsv ? 'QSV'
    : 'None'

  const activeJobs = jobs.filter(j =>
    ['pending', 'preparing', 'processing', 'finalizing'].includes(j.status)
  )

  const filteredJobs = jobs
    .filter(j => {
      if (search && !j.filename.toLowerCase().includes(search.toLowerCase())) return false
      if (filter === 'active') return ['pending', 'preparing', 'processing', 'finalizing'].includes(j.status)
      if (filter === 'done') return j.status === 'completed'
      if (filter === 'failed') return ['failed', 'cancelled', 'interrupted'].includes(j.status)
      return true
    })
    .sort((a, b) => {
      if (sortBy === 'duration') return (b.target_duration || 0) - (a.target_duration || 0)
      if (sortBy === 'size') return (b.output_size || 0) - (a.output_size || 0)
      return new Date(b.created_at) - new Date(a.created_at)
    })

  // ─── Actions ───────────────────────────────────────────────────────────────

  const showNotif = (message, type = 'info') => {
    setNotification({ message, type })
    setTimeout(() => setNotification(null), 4000)
  }

  const confirm = (message, onYes) => {
    setDialog({ message, onYes })
  }

  const handleSubmit = async (e) => {
    e.preventDefault()
    setFormErr(null)

    if (!videoFile) return setFormErr('No video file selected.')
    if (targetSec < 60) return setFormErr('Duration must be at least 1 minute.')
    if (!sysInfo.ffmpegInstalled) return setFormErr('FFmpeg is not installed or not found in PATH.')

    setSubmitting(true)
    const fd = new FormData()
    fd.append('video', videoFile)
    if (audioFile) fd.append('audio', audioFile)
    fd.append('target_duration', targetSec)
    fd.append('crossfade', crossfade)
    fd.append('hw_accel', hwMode)
    fd.append('filename', outName || videoFile.name)
    fd.append('reverse_mode', reverseMode)
    fd.append('loop_style', loopStyle)
    fd.append('audio_fade', audioFade)

    try {
      const r = await fetch('/api/jobs', { method: 'POST', body: fd })
      if (!r.ok) {
        const d = await r.json()
        throw new Error(d.error || 'Server rejected the request.')
      }
      // Reset form on success
      setVideoFile(null)
      setAudioFile(null)
      setOutName('')
      setHours('01')
      setMins('30')
      setSecs('00')
      setCrossfade('0')
      setReverseMode('disabled')
      setLoopStyle('standard')
      setAudioFade('off')
      if (videoInputRef.current) videoInputRef.current.value = ''
      if (audioInputRef.current) audioInputRef.current.value = ''
      showNotif('Job queued successfully.', 'success')
    } catch (err) {
      setFormErr(err.message)
    } finally {
      setSubmitting(false)
    }
  }

  const handleCancel = (id) => {
    confirm('Cancel this render? Progress will be lost.', async () => {
      const r = await fetch(`/api/jobs/${id}/cancel`, { method: 'POST' })
      if (!r.ok) showNotif('Failed to cancel job.', 'error')
    })
  }

  const handleRetry = async (id) => {
    const r = await fetch(`/api/jobs/${id}/retry`, { method: 'POST' })
    if (!r.ok) showNotif('Failed to retry job.', 'error')
  }

  const handleDuplicate = async (id) => {
    const r = await fetch(`/api/jobs/${id}/duplicate`, { method: 'POST' })
    if (!r.ok) showNotif('Failed to duplicate job.', 'error')
    else showNotif('Job duplicated and queued.', 'success')
  }

  const handleReveal = async (id) => {
    const r = await fetch(`/api/jobs/${id}/reveal`, { method: 'POST' })
    if (!r.ok) {
      const d = await r.json()
      showNotif(d.error || 'Could not open folder.', 'error')
    }
  }

  const handleDelete = (id, name) => {
    confirm(`Delete "${name}"? This will remove the job record and output file.`, async () => {
      const r = await fetch(`/api/jobs/${id}`, { method: 'DELETE' })
      if (r.ok) {
        setJobs(prev => prev.filter(j => j.id !== id))
        loadSysInfo()
      } else {
        showNotif('Failed to delete job.', 'error')
      }
    })
  }

  const handleDeleteAll = () => {
    if (filteredJobs.length === 0) return
    const count = filteredJobs.length
    const label = filter === 'done' ? 'all completed'
      : filter === 'failed' ? 'all failed/cancelled'
      : filter === 'active' ? 'all active'
      : 'all'
    confirm(
      `Delete ${label} ${count} job${count !== 1 ? 's' : ''}? Output files will be permanently removed.`,
      async () => {
        const ids = filteredJobs.map(j => j.id)
        try {
          const r = await fetch('/api/jobs', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ids }),
          })
          if (r.ok) {
            const d = await r.json()
            setJobs(prev => prev.filter(j => !ids.includes(j.id)))
            loadSysInfo()
            showNotif(`Deleted ${d.deleted} job${d.deleted !== 1 ? 's' : ''}.`, 'success')
          } else {
            showNotif('Failed to delete jobs.', 'error')
          }
        } catch {
          showNotif('Failed to delete jobs.', 'error')
        }
      }
    )
  }

  // ─── Drag & Drop ───────────────────────────────────────────────────────────

  const onVideoDrop = (e) => {
    e.preventDefault()
    setVideoDrag(false)
    const f = e.dataTransfer.files[0]
    if (!f) return
    if (f.type.startsWith('video/') || /\.(mp4|mov|webm|mkv|avi|m4v)$/i.test(f.name)) {
      setVideoFile(f)
      if (!outName) setOutName(f.name)
    } else {
      showNotif('Please drop a valid video file (MP4, MOV, WEBM, MKV).', 'error')
    }
  }

  const onAudioDrop = (e) => {
    e.preventDefault()
    setAudioDrag(false)
    const f = e.dataTransfer.files[0]
    if (!f) return
    if (f.type.startsWith('audio/') || /\.(mp3|wav|m4a|aac|flac|ogg)$/i.test(f.name)) {
      setAudioFile(f)
    } else {
      showNotif('Please drop a valid audio file (MP3, WAV, M4A, AAC, FLAC).', 'error')
    }
  }

  // ─── Duration input pad helper ─────────────────────────────────────────────
  const clampPad = (v, max) =>
    String(Math.min(max, Math.max(0, parseInt(v, 10) || 0))).padStart(2, '0')

  // ─── Render ────────────────────────────────────────────────────────────────

  return (
    <>

      {/* ── NOTIFICATION BANNER ───────────────────────────────────────────── */}
      {notification && (
        <div className={`fixed top-12 left-1/2 -translate-x-1/2 z-50 px-4 py-2 text-xs font-mono border
          ${notification.type === 'error' ? 'bg-red-950 border-red-800 text-red-300'
          : notification.type === 'success' ? 'bg-zinc-900 border-zinc-700 text-emerald-400'
          : 'bg-zinc-900 border-zinc-700 text-zinc-300'}`}>
          {notification.message}
        </div>
      )}

      {/* ── MAIN LAYOUT ──────────────────────────────────────────────────────── */}
      <main className="max-w-screen-xl mx-auto px-6 py-6 grid lg:grid-cols-12 gap-6 items-start">

        {/* ── LEFT PANEL: CREATE JOB ──────────────────────────────────────── */}
        <section className="lg:col-span-5 space-y-5">

          <SectionHeader title="New Loop Job" />

          {/* FFmpeg not found — only shown after check resolves, never flashes on load */}
          {sysInfoReady && (!sysInfo.ffmpegInstalled || !sysInfo.ffprobeInstalled) && (
            <Alert type="error">
              <strong>FFmpeg not detected.</strong> Install FFmpeg and ensure it's in your system PATH,
              or set a custom path in <Link to="/settings" className="underline hover:text-red-300">Settings</Link>.
            </Alert>
          )}

          {/* Form error */}
          {formErr && <Alert type="error">{formErr}</Alert>}

          <form onSubmit={handleSubmit} className="space-y-5">

            {/* Video dropzone */}
            <div>
              <Label>Video Source *</Label>
              <Dropzone
                drag={videoDrag}
                hasFile={!!videoFile}
                onDragOver={e => { e.preventDefault(); setVideoDrag(true) }}
                onDragLeave={() => setVideoDrag(false)}
                onDrop={onVideoDrop}
                onClick={() => videoInputRef.current?.click()}
              >
                <input
                  type="file" ref={videoInputRef} accept="video/*,.mkv" className="hidden"
                  onChange={e => {
                    const f = e.target.files?.[0]
                    if (f) { setVideoFile(f); if (!outName) setOutName(f.name) }
                  }}
                />
                {videoFile ? (
                  <DropzoneFill
                    tag="VIDEO"
                    name={videoFile.name}
                    meta={formatBytes(videoFile.size)}
                    onClear={e => {
                      e.stopPropagation()
                      setVideoFile(null)
                      setOutName('')
                      if (videoInputRef.current) videoInputRef.current.value = ''
                    }}
                  />
                ) : (
                  <DropzoneEmpty hint="Drop video or click to browse" sub="MP4 · MOV · WEBM · MKV" />
                )}
              </Dropzone>
            </div>

            {/* Audio dropzone */}
            <div>
              <Label sub="optional">Separate Audio Track</Label>
              <Dropzone
                drag={audioDrag}
                hasFile={!!audioFile}
                onDragOver={e => { e.preventDefault(); setAudioDrag(true) }}
                onDragLeave={() => setAudioDrag(false)}
                onDrop={onAudioDrop}
                onClick={() => audioInputRef.current?.click()}
              >
                <input
                  type="file" ref={audioInputRef} accept="audio/*" className="hidden"
                  onChange={e => {
                    const f = e.target.files?.[0]
                    if (f) setAudioFile(f)
                  }}
                />
                {audioFile ? (
                  <DropzoneFill
                    tag="AUDIO"
                    name={audioFile.name}
                    meta={formatBytes(audioFile.size)}
                    onClear={e => {
                      e.stopPropagation()
                      setAudioFile(null)
                      if (audioInputRef.current) audioInputRef.current.value = ''
                    }}
                  />
                ) : (
                  <DropzoneEmpty hint="Drop audio or click to browse" sub="MP3 · WAV · M4A · AAC · FLAC" />
                )}
              </Dropzone>
            </div>

            {/* Output filename */}
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

            {/* Duration input */}
            <div>
              <Label>Target Duration</Label>
              <div className="grid grid-cols-3 gap-2">
                {[
                  { lbl: 'Hours', val: hours, set: setHours, max: 23 },
                  { lbl: 'Minutes', val: mins, set: setMins, max: 59 },
                  { lbl: 'Seconds', val: secs, set: setSecs, max: 59 },
                ].map(({ lbl, val, set, max }) => (
                  <div key={lbl}>
                    <span className="block text-xs text-zinc-700 font-mono mb-1">{lbl}</span>
                    <input
                      type="number" min="0" max={max} value={val}
                      onFocus={e => e.target.select()}
                      onChange={e => set(clampPad(e.target.value, max))}
                      className="w-full bg-zinc-950 border border-zinc-800 text-center font-mono text-2xl text-white py-2 focus:border-zinc-600 outline-none transition-colors"
                    />
                  </div>
                ))}
              </div>
              <div className="mt-2 flex items-center justify-between text-xs font-mono">
                <span className={targetSec >= 60 ? 'text-zinc-400' : 'text-red-400'}>
                  {targetSec >= 60 ? `→ ${formatDuration(targetSec)}` : '→ minimum 1 minute'}
                </span>
                {videoFile && targetSec >= 60 && (
                  <span className="text-zinc-700">
                    source: {formatBytes(videoFile.size)}
                  </span>
                )}
              </div>
            </div>

            {/* Crossfade */}
            <div>
              <Label>Audio Crossfade</Label>
              <div className="grid grid-cols-4 gap-2">
                {[['0', 'Off'], ['0.2', '0.2s'], ['0.5', '0.5s'], ['1.0', '1.0s']].map(([v, lbl]) => (
                  <ToggleBtn key={v} active={crossfade === v} onClick={() => setCrossfade(v)}>
                    {lbl}
                  </ToggleBtn>
                ))}
              </div>
              <p className="mt-1.5 text-xs text-zinc-700">
                Smooth audio between loop boundaries. Requires audio source.
              </p>
            </div>

            {/* ── Reverse Options ───────────────────────────────────────────── */}
            <div>
              <Label>Reverse Options</Label>
              <div className="grid grid-cols-4 gap-2">
                {[
                  ['disabled', 'Off'],
                  ['video',    'Video'],
                  ['audio',    'Audio'],
                  ['both',     'Both'],
                ].map(([v, lbl]) => (
                  <ToggleBtn key={v} active={reverseMode === v} onClick={() => setReverseMode(v)}>
                    {lbl}
                  </ToggleBtn>
                ))}
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

            {/* ── Loop Style ────────────────────────────────────────────────── */}
            <div>
              <Label>Loop Style</Label>
              <div className="grid grid-cols-3 gap-2">
                {[
                  ['standard',  'Standard',  '▶ ▶ ▶ ▶'],
                  ['reverse',   'Reverse',   '◀ ◀ ◀ ◀'],
                  ['pingpong',  'Ping Pong', '▶ ◀ ▶ ◀'],
                ].map(([v, lbl, timeline]) => (
                  <button
                    key={v} type="button" onClick={() => setLoopStyle(v)}
                    className={`p-2.5 text-left border transition-colors
                      ${loopStyle === v
                        ? 'border-zinc-600 bg-zinc-900 text-white'
                        : 'border-zinc-800 text-zinc-500 hover:border-zinc-700 hover:text-zinc-300'}`}
                  >
                    <div className="text-xs font-bold">{lbl}</div>
                    <div className="text-xs font-mono mt-1 text-zinc-700 tracking-widest">{timeline}</div>
                  </button>
                ))}
              </div>

              {/* Loop style description / impact notice */}
              <p className="mt-1.5 text-xs text-zinc-700">
                {loopStyle === 'standard' && 'Clip repeats forward from start to end.'}
                {loopStyle === 'reverse'  && 'Clip repeats in reverse — plays end to start.'}
                {loopStyle === 'pingpong' && (
                  <>Seamless bounce — forward then backward. Best for ambient content.{' '}
                    <span className="text-zinc-600">~15% longer render time.</span>
                  </>
                )}
              </p>
            </div>

            {/* ── Audio Transition (shown when any reversal is active) ───────── */}
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
                <p className="mt-1.5 text-xs text-zinc-700">
                  Fade audio at reversal seams to prevent clicks and pops.
                </p>
              </div>
            )}

            {/* Render mode */}
            <div>
              <Label>Render Engine</Label>
              <div className="grid grid-cols-3 gap-2">
                {[
                  ['auto', 'Auto', 'Direct copy · fastest · lossless'],
                  ['gpu', 'GPU', `${gpuLabel !== 'None' ? gpuLabel : 'No GPU'} hardware encode`],
                  ['cpu', 'CPU', 'libx264 software encode'],
                ].map(([v, lbl, desc]) => (
                  <button
                    key={v} type="button" onClick={() => setHwMode(v)}
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

            {/* Submit */}
            <button
              type="submit"
              disabled={submitting || !isFormValid}
              className="w-full py-3 text-sm font-bold uppercase tracking-widest transition-colors
                bg-white text-black hover:bg-zinc-200
                disabled:bg-zinc-900 disabled:text-zinc-700 disabled:cursor-not-allowed"
            >
              {submitting ? 'Uploading…' : 'Generate Loop'}
            </button>

          </form>
        </section>

        {/* ── RIGHT PANEL: LIBRARY ─────────────────────────────────────────── */}
        <section className="lg:col-span-7 space-y-4">

          <div className="flex items-center justify-between border-b border-zinc-900 pb-3">
            <SectionHeader title="Generation Library" />
            <div className="flex items-center gap-3">
              {filteredJobs.length > 0 && (
                <button
                  onClick={handleDeleteAll}
                  className="text-xs font-mono text-zinc-600 hover:text-red-400 border border-zinc-900 hover:border-red-900 px-2 py-1 transition-colors"
                >
                  Delete All
                </button>
              )}
              <span className="text-xs text-zinc-700 font-mono">{jobs.length} total</span>
            </div>
          </div>

          {/* Filter tabs */}
          <div className="flex items-center gap-5 border-b border-zinc-900 pb-3">
            {[
              ['all', 'All', jobs.length],
              ['active', 'Active', activeJobs.length],
              ['done', 'Done', jobs.filter(j => j.status === 'completed').length],
              ['failed', 'Failed', jobs.filter(j => ['failed', 'cancelled', 'interrupted'].includes(j.status)).length],
            ].map(([val, lbl, cnt]) => (
              <button
                key={val} onClick={() => setFilter(val)}
                className={`text-xs uppercase tracking-wider transition-colors
                  ${filter === val ? 'text-white border-b border-white pb-0.5' : 'text-zinc-600 hover:text-zinc-400'}`}
              >
                {lbl}{cnt > 0 ? <span className="font-mono ml-1.5 text-zinc-700">{cnt}</span> : ''}
              </button>
            ))}
            <div className="ml-auto">
              <select
                value={sortBy} onChange={e => setSortBy(e.target.value)}
                className="bg-black border border-zinc-800 text-xs text-zinc-500 px-2 py-1 outline-none hover:border-zinc-700 transition-colors"
              >
                <option value="newest">Newest first</option>
                <option value="duration">By duration</option>
                <option value="size">By size</option>
              </select>
            </div>
          </div>

          {/* Search */}
          <input
            value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Search by filename…"
            className="w-full bg-black border border-zinc-900 px-3 py-2 text-sm text-white font-mono placeholder-zinc-800 focus:border-zinc-700 outline-none transition-colors"
          />

          {/* Job list */}
          <div className="space-y-2 max-h-[calc(100vh-300px)] overflow-y-auto pr-1">
            {filteredJobs.length === 0 ? (
              <div className="border border-zinc-900 p-10 text-center">
                <p className="text-zinc-700 text-sm">
                  {jobs.length === 0
                    ? 'No jobs yet. Upload a video and set a target duration.'
                    : 'No jobs match the current filter.'}
                </p>
              </div>
            ) : (
              filteredJobs.map(job => (
                <JobCard
                  key={job.id}
                  job={job}
                  onCancel={handleCancel}
                  onRetry={handleRetry}
                  onDuplicate={handleDuplicate}
                  onReveal={handleReveal}
                  onDelete={handleDelete}
                  onPreview={(url, name) => { setPreviewUrl(url); setPreviewName(name) }}
                  onViewLogs={(id, name) => { setLogJobId(id); setLogJobName(name) }}
                />
              ))
            )}
          </div>
        </section>
      </main>

      {/* ── MODALS ───────────────────────────────────────────────────────────── */}
      {previewUrl && (
        <PreviewModal
          videoUrl={previewUrl}
          filename={previewName}
          onClose={() => { setPreviewUrl(null); setPreviewName('') }}
        />
      )}

      {logJobId && (
        <LogViewer
          jobId={logJobId}
          filename={logJobName}
          onClose={() => { setLogJobId(null); setLogJobName('') }}
        />
      )}

      {/* Confirm dialog */}
      {dialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/95">
          <div className="bg-zinc-950 border border-zinc-800 p-6 w-full max-w-sm mx-4">
            <p className="text-sm text-white mb-6 leading-relaxed">{dialog.message}</p>
            <div className="flex justify-end gap-3">
              <button
                onClick={() => setDialog(null)}
                className="px-4 py-1.5 text-xs text-zinc-400 border border-zinc-800 hover:text-white hover:border-zinc-600 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => { dialog.onYes(); setDialog(null) }}
                className="px-4 py-1.5 text-xs text-white bg-zinc-800 border border-zinc-600 hover:bg-zinc-700 transition-colors"
              >
                Confirm
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

// ─── Job Card ─────────────────────────────────────────────────────────────────

function JobCard({ job, onCancel, onRetry, onDuplicate, onReveal, onDelete, onPreview, onViewLogs }) {
  const isActive = ['pending', 'preparing', 'processing', 'finalizing'].includes(job.status)
  const isFailed = ['failed', 'cancelled', 'interrupted'].includes(job.status)
  const isDone = job.status === 'completed'
  const st = STATUS_MAP[job.status] || STATUS_MAP.pending
  const outFile = basename(job.output_path)

  return (
    <div className={`border transition-colors
      ${isActive ? 'border-zinc-700' : isDone ? 'border-zinc-800' : 'border-zinc-900'}`}>

      {/* ── Top: status + filename ─────────────────────────────────────── */}
      <div className="px-4 py-3 flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">

          {/* Status badge */}
          <div className="flex items-center gap-2 mb-1">
            <span className={`text-xs font-bold font-mono tracking-wider ${st.cls}`}>
              {st.dot && (
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-current mr-1.5 animate-pulse align-middle" />
              )}
              {st.label}
            </span>
          </div>

          {/* Filename */}
          <p className="text-sm text-white font-medium truncate leading-tight" title={job.filename}>
            {job.filename}
          </p>

          {/* Meta row */}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 mt-1.5 text-xs font-mono text-zinc-600">
            <span>{formatDuration(job.target_duration)}</span>
            {job.resolution && <><span className="text-zinc-800">·</span><span>{job.resolution}</span></>}
            {job.encoder_used && <><span className="text-zinc-800">·</span><span>{job.encoder_used}</span></>}
            {job.job_type === 'audio_visual' && (
              <><span className="text-zinc-800">·</span><span className="text-zinc-500">Audio Visual · {job.animation_mode || 'loop'}</span></>
            )}
            {job.job_type === 'mp4_to_mp3' && (
              <><span className="text-zinc-800">·</span><span className="text-zinc-500">MP3 · 320kbps</span></>
            )}
            {job.job_type === 'audio_merge' && (
              <><span className="text-zinc-800">·</span><span className="text-zinc-500">Audio Merger · 320kbps</span></>
            )}
            {job.job_type === 'audio_loop' && (
              <><span className="text-zinc-800">·</span><span className="text-zinc-500">Audio Looper · 320kbps</span></>
            )}
            {job.loop_style && job.loop_style !== 'standard' && (
              <><span className="text-zinc-800">·</span>
              <span className="text-zinc-500">
                {job.loop_style === 'pingpong' ? '▶◀ Ping Pong' : '◀ Reverse'}
              </span></>
            )}
            {job.reverse_mode && job.reverse_mode !== 'disabled' && (
              <><span className="text-zinc-800">·</span>
              <span className="text-zinc-500">
                {job.reverse_mode === 'video' ? 'Rev.Video'
                 : job.reverse_mode === 'audio' ? 'Rev.Audio'
                 : 'Rev.Both'}
              </span></>
            )}
            {isDone && job.output_size > 0 && (
              <><span className="text-zinc-800">·</span><span className="text-zinc-500">{formatBytes(job.output_size)}</span></>
            )}
            <><span className="text-zinc-800">·</span><span>{formatDate(job.created_at)}</span></>
          </div>
        </div>

        {/* Delete */}
        <button
          onClick={() => onDelete(job.id, job.filename)}
          className="text-zinc-800 hover:text-red-400 transition-colors shrink-0 leading-none mt-0.5 text-xl"
          title="Delete"
        >
          ×
        </button>
      </div>

      {/* ── Progress bar (active only) ─────────────────────────────────── */}
      {isActive && (
        <div className="px-4 pb-3">
          <div className="flex items-center justify-between text-xs font-mono text-zinc-600 mb-2">
            <span>
              {job.status === 'pending' ? 'Waiting in queue' : 'Rendering'}
            </span>
            <span className="text-white">{job.progress || 0}%</span>
          </div>

          {/* Progress track */}
          <div className="h-px bg-zinc-800 relative overflow-hidden">
            <div
              className="absolute top-0 left-0 h-full bg-white transition-all duration-700"
              style={{ width: `${job.progress || 0}%` }}
            />
          </div>

          {/* FPS / ETA */}
          {(job.fps > 0 || job.eta > 0) && (
            <div className="flex items-center gap-5 mt-2 text-xs font-mono text-zinc-600">
              {job.fps > 0 && (
                <span>FPS <span className="text-zinc-400">{job.fps}</span></span>
              )}
              {job.eta > 0 && (
                <span>ETA <span className="text-zinc-400">{formatDuration(job.eta)}</span></span>
              )}
            </div>
          )}
        </div>
      )}

      {/* ── Error message ──────────────────────────────────────────────── */}
      {job.error_message && (
        <div className="px-4 pb-3">
          <p className="text-xs text-red-400 font-mono leading-relaxed border-l-2 border-red-900 pl-2">
            {job.error_message}
          </p>
        </div>
      )}

      {/* ── Actions ───────────────────────────────────────────────────── */}
      <div className="px-4 py-2 border-t border-zinc-900 flex flex-wrap items-center gap-3">
        {isActive && (
          <Lnk onClick={() => onCancel(job.id)} cls="text-red-500 hover:text-red-400">Cancel</Lnk>
        )}
        {(isActive || isFailed) && (
          <Lnk onClick={() => onViewLogs(job.id, job.filename)}>Logs</Lnk>
        )}
        {isFailed && (
          <Lnk onClick={() => onRetry(job.id)} cls="text-white hover:text-zinc-300">Retry</Lnk>
        )}
        {isDone && outFile && (
          <>
            <Lnk onClick={() => onPreview(`/outputs/${outFile}`, job.filename)} cls="text-white hover:text-zinc-300">
              Play
            </Lnk>
            <a
              href={`/outputs/${outFile}`}
              download={outFile}
              className="text-xs font-mono transition-colors underline underline-offset-2 decoration-zinc-800 hover:decoration-current text-white hover:text-zinc-300"
            >
              Download
            </a>
            <Lnk onClick={() => onReveal(job.id)}>Open Folder</Lnk>
          </>
        )}
        {(isDone || isFailed) && (
          <Lnk onClick={() => onDuplicate(job.id)}>Duplicate</Lnk>
        )}
      </div>
    </div>
  )
}

// ─── Small Reusable Components ────────────────────────────────────────────────

function SectionHeader({ title }) {
  return (
    <h2 className="text-xs font-bold uppercase tracking-widest text-zinc-400">{title}</h2>
  )
}

function Label({ children, sub }) {
  return (
    <label className="block text-xs font-bold uppercase tracking-wider text-zinc-500 mb-2">
      {children}
      {sub && <span className="ml-1.5 normal-case text-zinc-700 font-normal tracking-normal">{sub}</span>}
    </label>
  )
}

function Alert({ type, children }) {
  const cls = type === 'error'
    ? 'border-red-900 bg-red-950/20 text-red-400'
    : 'border-zinc-800 bg-zinc-900 text-zinc-400'
  return (
    <div className={`border px-4 py-3 text-xs leading-relaxed ${cls}`}>
      {children}
    </div>
  )
}

function Dropzone({ drag, hasFile, children, onDragOver, onDragLeave, onDrop, onClick }) {
  return (
    <div
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      onClick={onClick}
      className={`border cursor-pointer transition-colors p-4
        ${drag
          ? 'border-white bg-zinc-900'
          : hasFile
            ? 'border-zinc-700 bg-zinc-950'
            : 'border-zinc-900 hover:border-zinc-800 bg-zinc-950'}`}
    >
      {children}
    </div>
  )
}

function DropzoneEmpty({ hint, sub }) {
  return (
    <div className="text-center py-3">
      <p className="text-xs text-zinc-600">{hint}</p>
      <p className="text-xs text-zinc-800 mt-1">{sub}</p>
    </div>
  )
}

function DropzoneFill({ tag, name, meta, onClear }) {
  return (
    <div className="flex items-start justify-between gap-2">
      <div className="min-w-0">
        <span className="text-xs font-mono text-zinc-500">{tag}</span>
        <p className="text-sm text-white font-medium truncate mt-0.5">{name}</p>
        <p className="text-xs text-zinc-700 font-mono mt-0.5">{meta}</p>
      </div>
      <button
        type="button" onClick={onClear}
        className="text-zinc-700 hover:text-white transition-colors text-xl leading-none shrink-0"
      >
        ×
      </button>
    </div>
  )
}

function ToggleBtn({ active, onClick, children }) {
  return (
    <button
      type="button" onClick={onClick}
      className={`py-1.5 text-xs font-mono border transition-colors
        ${active
          ? 'border-zinc-600 bg-zinc-900 text-white'
          : 'border-zinc-800 text-zinc-600 hover:border-zinc-700 hover:text-zinc-400'}`}
    >
      {children}
    </button>
  )
}

function Lnk({ onClick, children, cls = 'text-zinc-500 hover:text-zinc-300' }) {
  return (
    <button
      onClick={onClick}
      className={`text-xs font-mono transition-colors underline underline-offset-2 decoration-zinc-800 hover:decoration-current ${cls}`}
    >
      {children}
    </button>
  )
}
