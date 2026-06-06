import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import Layout from '../components/Layout'

const basename = value => value?.replace(/\\/g, '/').split('/').pop() || ''

const formatBytes = bytes => {
  if (!bytes) return '—'
  const units = ['B', 'KB', 'MB', 'GB']
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), 3)
  return `${(bytes / Math.pow(1024, i)).toFixed(i >= 2 ? 1 : 0)} ${units[i]}`
}

const formatDuration = seconds => {
  if (!seconds || Number.isNaN(Number(seconds))) return '—'
  const value = Number(seconds)
  const h = Math.floor(value / 3600)
  const m = Math.floor((value % 3600) / 60)
  const s = Math.floor(value % 60)
  return h ? `${h}h ${m}m ${s}s` : m ? `${m}m ${s}s` : `${s}s`
}

export default function Mp4ToMp3Page() {
  const [video, setVideo] = useState(null)
  const [drag, setDrag] = useState(false)
  const [sysInfo, setSysInfo] = useState(null)
  const [job, setJob] = useState(null)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(null)
  const inputRef = useRef(null)

  useEffect(() => {
    fetch('/api/system-info').then(r => r.json()).then(setSysInfo).catch(() => setSysInfo(null))
  }, [])

  useEffect(() => {
    if (!job?.id || ['completed', 'failed', 'cancelled'].includes(job.status)) return
    const refresh = async () => {
      try {
        const response = await fetch(`/api/jobs/${job.id}`)
        if (response.ok) setJob(await response.json())
      } catch { /* keep the last known progress visible */ }
    }
    const interval = setInterval(refresh, 1000)
    return () => clearInterval(interval)
  }, [job])

  const chooseVideo = file => {
    setError(null)
    if (!file) return setVideo(null)
    if (!/\.mp4$/i.test(file.name) && file.type !== 'video/mp4') {
      setVideo(null)
      setError('Unsupported format. Select an MP4 video file.')
      return
    }
    setVideo(file)
  }

  const submit = async event => {
    event.preventDefault()
    setError(null)
    if (!video) return setError('Select an MP4 video file.')
    setSubmitting(true)
    try {
      const body = new FormData()
      body.append('video', video)
      body.append('filename', video.name)
      const response = await fetch('/api/mp4-to-mp3-jobs', { method: 'POST', body })
      if (!response.ok) {
        const data = await response.json().catch(() => ({}))
        throw new Error(data.error || 'Conversion request failed.')
      }
      setJob(await response.json())
    } catch (err) {
      setError(err.message)
    } finally {
      setSubmitting(false)
    }
  }

  const reset = () => {
    setVideo(null)
    setJob(null)
    setError(null)
    if (inputRef.current) inputRef.current.value = ''
  }

  const outputFile = basename(job?.output_path)
  const active = job && !['completed', 'failed', 'cancelled'].includes(job.status)

  return (
    <Layout>
      <div className="max-w-2xl mx-auto px-6 py-8">
        <h2 className="text-xs font-bold uppercase tracking-widest text-zinc-400 mb-2">MP4 to MP3 Converter</h2>
        <p className="text-xs text-zinc-600 mb-6">Extract the complete audio track from an MP4 and encode a constant-bitrate 320kbps MP3.</p>

        {!job ? (
          <form className="space-y-6" onSubmit={submit}>
            <div>
              <label className="block text-xs font-bold uppercase tracking-wider text-zinc-500 mb-2">MP4 Video *</label>
              <div
                onClick={() => inputRef.current?.click()}
                onDragOver={event => { event.preventDefault(); setDrag(true) }}
                onDragLeave={() => setDrag(false)}
                onDrop={event => { event.preventDefault(); setDrag(false); chooseVideo(event.dataTransfer.files[0]) }}
                className={`border p-4 cursor-pointer transition-colors ${drag ? 'border-white bg-zinc-900' : video ? 'border-zinc-700 bg-zinc-950' : 'border-zinc-900 bg-zinc-950 hover:border-zinc-700'}`}
              >
                <input ref={inputRef} className="hidden" type="file" accept="video/mp4,.mp4" onChange={event => chooseVideo(event.target.files?.[0])} />
                {video ? (
                  <div className="flex justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-sm text-white truncate">{video.name}</p>
                      <p className="text-xs text-zinc-700 font-mono mt-1">{formatBytes(video.size)}</p>
                    </div>
                    <button type="button" className="text-zinc-700 hover:text-white text-xl" onClick={event => { event.stopPropagation(); reset() }}>×</button>
                  </div>
                ) : <p className="text-xs text-zinc-600 text-center py-3">Drop an MP4 video or click to browse</p>}
              </div>
            </div>

            <div className="border border-zinc-900 px-4 py-3 text-xs text-zinc-600">
              Output format: <span className="text-white font-mono">MP3 · CBR 320kbps</span>
            </div>
            {sysInfo && (!sysInfo.ffmpegInstalled || !sysInfo.ffprobeInstalled) && <p className="border border-red-900 bg-red-950/20 px-4 py-3 text-xs text-red-400">FFmpeg and FFprobe are required. Configure them in <Link className="text-white underline" to="/settings">Settings</Link>.</p>}
            {error && <p className="border border-red-900 bg-red-950/20 px-4 py-3 text-xs text-red-400">{error}</p>}
            <button disabled={!video || submitting || !sysInfo?.ffmpegInstalled || !sysInfo?.ffprobeInstalled} className="w-full py-3 text-sm font-bold uppercase tracking-widest bg-white text-black hover:bg-zinc-200 disabled:bg-zinc-900 disabled:text-zinc-700 disabled:cursor-not-allowed">{submitting ? 'Uploading...' : 'Convert to MP3'}</button>
          </form>
        ) : (
          <div className="border border-zinc-800 p-6 space-y-5">
            <div>
              <p className="text-xs uppercase tracking-widest text-zinc-600">Conversion Job</p>
              <p className="text-sm text-white mt-1 truncate">{job.filename}</p>
            </div>

            {active && (
              <div>
                <div className="flex justify-between text-xs font-mono text-zinc-600 mb-2">
                  <span>{job.status === 'pending' ? 'Waiting in queue' : 'Extracting audio'}</span>
                  <span className="text-white">{job.progress || 0}%</span>
                </div>
                <div className="h-px bg-zinc-800 overflow-hidden">
                  <div className="h-full bg-white transition-all duration-700" style={{ width: `${job.progress || 0}%` }} />
                </div>
              </div>
            )}

            {job.status === 'completed' && (
              <div className="space-y-4">
                <p className="text-sm text-emerald-400">MP3 ready for download.</p>
                <div className="flex gap-4 text-xs font-mono text-zinc-600">
                  <span>{formatDuration(job.target_duration)}</span>
                  <span>{formatBytes(job.output_size)}</span>
                  <span>320kbps</span>
                </div>
                <a href={`/outputs/${outputFile}`} download={outputFile} className="block w-full py-3 text-center text-sm font-bold uppercase tracking-widest bg-white text-black hover:bg-zinc-200">Download MP3</a>
              </div>
            )}

            {job.status === 'failed' && <p className="border border-red-900 bg-red-950/20 px-4 py-3 text-xs text-red-400">{job.error_message || 'Conversion failed.'}</p>}
            {job.status === 'cancelled' && <p className="text-xs text-zinc-500">Conversion cancelled.</p>}
            <div className="flex items-center justify-between">
              <button onClick={reset} className="text-xs font-mono text-zinc-500 hover:text-white">Convert another</button>
              <Link to="/loop" className="text-xs font-mono text-zinc-500 hover:text-white underline">Generation library</Link>
            </div>
          </div>
        )}
      </div>
    </Layout>
  )
}
