import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import Layout from '../components/Layout'

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

function Dropzone({ label, file, accept, hint, inputRef, onFile }) {
  const [drag, setDrag] = useState(false)
  const select = selected => {
    if (selected) onFile(selected)
  }
  return (
    <div>
      <label className="block text-xs font-bold uppercase tracking-wider text-zinc-500 mb-2">{label}</label>
      <div
        onClick={() => inputRef.current?.click()}
        onDragOver={e => { e.preventDefault(); setDrag(true) }}
        onDragLeave={() => setDrag(false)}
        onDrop={e => { e.preventDefault(); setDrag(false); select(e.dataTransfer.files[0]) }}
        className={`border p-4 cursor-pointer transition-colors ${drag ? 'border-white bg-zinc-900' : file ? 'border-zinc-700 bg-zinc-950' : 'border-zinc-900 bg-zinc-950 hover:border-zinc-700'}`}
      >
        <input ref={inputRef} className="hidden" type="file" accept={accept} onChange={e => select(e.target.files?.[0])} />
        {file ? (
          <div className="flex justify-between gap-2">
            <div className="min-w-0">
              <p className="text-sm text-white truncate">{file.name}</p>
              <p className="text-xs text-zinc-700 font-mono mt-1">{formatBytes(file.size)}</p>
            </div>
            <button type="button" className="text-zinc-700 hover:text-white text-xl" onClick={e => { e.stopPropagation(); onFile(null); inputRef.current.value = '' }}>×</button>
          </div>
        ) : <p className="text-xs text-zinc-600 text-center py-3">{hint}</p>}
      </div>
    </div>
  )
}

export default function AudioVisualPage() {
  const [visual, setVisual] = useState(null)
  const [audio, setAudio] = useState(null)
  const [audioDuration, setAudioDuration] = useState(null)
  const [mode, setMode] = useState('loop')
  const [outName, setOutName] = useState('')
  const [sysInfo, setSysInfo] = useState(null)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(null)
  const [success, setSuccess] = useState(false)
  const visualRef = useRef(null)
  const audioRef = useRef(null)
  const isImage = visual?.type.startsWith('image/')

  useEffect(() => {
    fetch('/api/system-info').then(r => r.json()).then(setSysInfo).catch(() => setSysInfo(null))
  }, [])

  useEffect(() => {
    if (!audio) return
    const url = URL.createObjectURL(audio)
    const media = new Audio(url)
    media.onloadedmetadata = () => setAudioDuration(media.duration)
    media.onerror = () => setAudioDuration(null)
    return () => URL.revokeObjectURL(url)
  }, [audio])

  const submit = async e => {
    e.preventDefault()
    setError(null)
    if (!visual || !audio) return setError('Select both a visual asset and an audio track.')
    setSubmitting(true)
    try {
      const body = new FormData()
      body.append('visual', visual)
      body.append('audio', audio)
      body.append('animation_mode', mode)
      body.append('filename', outName || visual.name)
      const r = await fetch('/api/audio-visual-jobs', { method: 'POST', body })
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Server rejected the request.')
      setSuccess(true)
    } catch (err) {
      setError(err.message)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Layout>
      <div className="max-w-2xl mx-auto px-6 py-8">
        <h2 className="text-xs font-bold uppercase tracking-widest text-zinc-400 mb-2">Audio Visual Generator</h2>
        <p className="text-xs text-zinc-600 mb-6">Build one continuous video whose visual track automatically matches the complete audio duration.</p>

        {success ? (
          <div className="border border-zinc-800 p-8 text-center space-y-4">
            <p className="text-sm text-white">Audio-visual render queued.</p>
            <p className="text-xs text-zinc-600">Track progress in the <Link to="/loop" className="text-white underline">generation library</Link>.</p>
            <button className="text-xs font-mono text-zinc-500 hover:text-white" onClick={() => { setSuccess(false); setVisual(null); setAudio(null); setOutName('') }}>Create another</button>
          </div>
        ) : (
          <form className="space-y-6" onSubmit={submit}>
            <Dropzone label="Visual Asset *" file={visual} accept="image/*,video/*,.mkv" hint="Drop an image or video, or click to browse" inputRef={visualRef} onFile={file => { setVisual(file); if (file && !outName) setOutName(file.name) }} />
            <Dropzone label="Audio Track *" file={audio} accept="audio/*" hint="Drop a full-length audio track, or click to browse" inputRef={audioRef} onFile={file => { setAudio(file); setAudioDuration(null) }} />

            {audio && <div className="border border-zinc-900 px-4 py-3 flex justify-between text-xs font-mono"><span className="text-zinc-600">Output duration</span><span className="text-white">{formatDuration(audioDuration)}</span></div>}

            <div>
              <label className="block text-xs font-bold uppercase tracking-wider text-zinc-500 mb-2">Visual Mode</label>
              <div className="grid grid-cols-3 gap-2">
                {[
                  ['still', 'Still', isImage ? 'Static frame' : 'Repeat clip'],
                  ['loop', 'Loop', isImage ? 'Seamless orbit motion' : 'Seamless repeat'],
                  ['pingpong', 'Ping Pong', isImage ? 'Smooth zoom in and out' : 'Forward and reverse'],
                ].map(([value, label, desc]) => (
                  <button key={value} type="button" onClick={() => setMode(value)} className={`border p-3 text-left transition-colors ${mode === value ? 'border-zinc-600 bg-zinc-900 text-white' : 'border-zinc-800 text-zinc-500 hover:border-zinc-700'}`}>
                    <span className="block text-xs font-bold">{label}</span>
                    <span className="block text-xs text-zinc-700 mt-1">{desc}</span>
                  </button>
                ))}
              </div>
            </div>

            {visual && <div><label className="block text-xs font-bold uppercase tracking-wider text-zinc-500 mb-2">Output Filename</label><input value={outName} onChange={e => setOutName(e.target.value)} className="w-full bg-zinc-950 border border-zinc-800 px-3 py-2 text-sm text-white font-mono outline-none focus:border-zinc-600" /></div>}
            {sysInfo && !sysInfo.ffmpegInstalled && <p className="border border-red-900 bg-red-950/20 px-4 py-3 text-xs text-red-400">FFmpeg is not detected. Configure it in <Link className="text-white underline" to="/settings">Settings</Link>.</p>}
            {error && <p className="border border-red-900 bg-red-950/20 px-4 py-3 text-xs text-red-400">{error}</p>}
            <button disabled={!visual || !audio || submitting || !sysInfo?.ffmpegInstalled} className="w-full py-3 text-sm font-bold uppercase tracking-widest bg-white text-black hover:bg-zinc-200 disabled:bg-zinc-900 disabled:text-zinc-700 disabled:cursor-not-allowed">{submitting ? 'Uploading...' : 'Generate Audio Visual'}</button>
          </form>
        )}
      </div>
    </Layout>
  )
}
