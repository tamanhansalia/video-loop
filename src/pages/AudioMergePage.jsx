import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import Layout from '../components/Layout'

const basename = value => value?.replace(/\\/g, '/').split('/').pop() || ''

const formatBytes = bytes => {
  if (!bytes) return '--'
  const units = ['B', 'KB', 'MB', 'GB']
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), 3)
  return `${(bytes / Math.pow(1024, i)).toFixed(i >= 2 ? 1 : 0)} ${units[i]}`
}

const formatDuration = seconds => {
  if (seconds == null || Number.isNaN(Number(seconds))) return '--'
  const value = Number(seconds)
  const h = Math.floor(value / 3600)
  const m = Math.floor((value % 3600) / 60)
  const s = Math.floor(value % 60)
  return h ? `${h}h ${m}m ${s}s` : m ? `${m}m ${s}s` : `${s}s`
}

const readAudioDuration = file => new Promise(resolve => {
  const url = URL.createObjectURL(file)
  const audio = document.createElement('audio')

  const cleanup = () => {
    audio.removeEventListener('loadedmetadata', handleLoadedMetadata)
    audio.removeEventListener('error', handleError)
    URL.revokeObjectURL(url)
  }

  const handleLoadedMetadata = () => {
    const duration = Number(audio.duration)
    cleanup()
    resolve(Number.isFinite(duration) && duration >= 0 ? duration : null)
  }

  const handleError = () => {
    cleanup()
    resolve(null)
  }

  audio.preload = 'metadata'
  audio.addEventListener('loadedmetadata', handleLoadedMetadata)
  audio.addEventListener('error', handleError)
  audio.src = url
})

const getFilesKey = files => files.map(file => `${file.name}:${file.size}:${file.lastModified}`).join('|')

export default function AudioMergePage() {
  const [files, setFiles] = useState([])
  const [drag, setDrag] = useState(false)
  const [outName, setOutName] = useState('Merged audio')
  const [sysInfo, setSysInfo] = useState(null)
  const [job, setJob] = useState(null)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(null)
  const [durationSnapshot, setDurationSnapshot] = useState({ key: '', durations: [] })
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
      } catch { /* keep current progress */ }
    }
    const interval = setInterval(refresh, 1000)
    return () => clearInterval(interval)
  }, [job])

  useEffect(() => {
    let cancelled = false

    if (!files.length) return undefined

    const snapshotKey = getFilesKey(files)

    Promise.all(files.map(readAudioDuration)).then(durations => {
      if (cancelled) return
      setDurationSnapshot({ key: snapshotKey, durations })
    })

    return () => {
      cancelled = true
    }
  }, [files])

  const addFiles = selected => {
    setError(null)
    const next = Array.from(selected || [])
    const invalid = next.find(file => !file.type.startsWith('audio/') && !/\.(mp3|wav|m4a|aac|flac|ogg|opus|wma)$/i.test(file.name))
    if (invalid) {
      setError(`Unsupported audio file: ${invalid.name}`)
      return
    }
    setFiles(prev => [...prev, ...next])
  }

  const removeFile = index => {
    setFiles(prev => prev.filter((_, i) => i !== index))
  }

  const moveFile = (index, dir) => {
    setFiles(prev => {
      const next = [...prev]
      const target = index + dir
      if (target < 0 || target >= next.length) return next
      const item = next[index]
      next[index] = next[target]
      next[target] = item
      return next
    })
  }

  const submit = async event => {
    event.preventDefault()
    setError(null)
    if (files.length < 5) return setError('Select at least 5 audio files.')
    setSubmitting(true)
    try {
      const body = new FormData()
      files.forEach(file => body.append('audio', file))
      body.append('filename', outName || 'Merged audio')
      const response = await fetch('/api/audio-merge-jobs', { method: 'POST', body })
      if (!response.ok) {
        const data = await response.json().catch(() => ({}))
        throw new Error(data.error || 'Merge request failed.')
      }
      setJob(await response.json())
    } catch (err) {
      setError(err.message)
    } finally {
      setSubmitting(false)
    }
  }

  const reset = () => {
    setFiles([])
    setJob(null)
    setError(null)
    setOutName('Merged audio')
    if (inputRef.current) inputRef.current.value = ''
  }

  const outputFile = basename(job?.output_path)
  const active = job && !['completed', 'failed', 'cancelled'].includes(job.status)
  const filesKey = getFilesKey(files)
  const durationsReady = files.length > 0 && durationSnapshot.key === filesKey && durationSnapshot.durations.length === files.length
  const totalSelectedSize = files.reduce((sum, file) => sum + (file.size || 0), 0)
  const totalSelectedDuration = durationsReady
    ? durationSnapshot.durations.reduce((sum, duration) => sum + (duration || 0), 0)
    : null
  const unreadableDurationCount = durationsReady
    ? durationSnapshot.durations.filter(duration => duration == null).length
    : 0

  return (
    <Layout>
      <div className="max-w-2xl mx-auto px-6 py-8">
        <h2 className="text-xs font-bold uppercase tracking-widest text-zinc-400 mb-2">Audio Merger</h2>
        <p className="text-xs text-zinc-600 mb-6">Combine 5 or more audio files in the exact order shown into one continuous output.</p>

        {!job ? (
          <form className="space-y-6" onSubmit={submit}>
            <div>
              <label className="block text-xs font-bold uppercase tracking-wider text-zinc-500 mb-2">Audio Files *</label>
              <div
                onClick={() => inputRef.current?.click()}
                onDragOver={event => { event.preventDefault(); setDrag(true) }}
                onDragLeave={() => setDrag(false)}
                onDrop={event => { event.preventDefault(); setDrag(false); addFiles(event.dataTransfer.files) }}
                className={`border p-4 cursor-pointer transition-colors ${drag ? 'border-white bg-zinc-900' : files.length ? 'border-zinc-700 bg-zinc-950' : 'border-zinc-900 bg-zinc-950 hover:border-zinc-700'}`}
              >
                <input ref={inputRef} className="hidden" type="file" accept="audio/*,.mp3,.wav,.m4a,.aac,.flac,.ogg,.opus,.wma" multiple onChange={event => addFiles(event.target.files)} />
                <p className="text-xs text-zinc-600 text-center py-3">Drop audio files or click to browse</p>
                <p className="text-xs text-zinc-800 text-center">MP3 - WAV - M4A - AAC - FLAC - OGG</p>
              </div>
            </div>

            {files.length > 0 && (
              <div className="space-y-3">
                <div className="border border-zinc-900 divide-y divide-zinc-900">
                  {files.map((file, index) => (
                    <div key={`${file.name}-${file.size}-${index}`} className="flex items-center gap-3 px-3 py-2">
                      <span className="w-7 text-xs font-mono text-zinc-700">{String(index + 1).padStart(2, '0')}</span>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm text-white truncate">{file.name}</p>
                        <p className="text-xs text-zinc-700 font-mono mt-0.5">
                          {formatBytes(file.size)} | {durationsReady ? formatDuration(durationSnapshot.durations[index]) : 'Calculating...'}
                        </p>
                      </div>
                      <button type="button" onClick={() => moveFile(index, -1)} disabled={index === 0} className="text-xs text-zinc-600 hover:text-white disabled:opacity-20">Up</button>
                      <button type="button" onClick={() => moveFile(index, 1)} disabled={index === files.length - 1} className="text-xs text-zinc-600 hover:text-white disabled:opacity-20">Down</button>
                      <button type="button" onClick={() => removeFile(index)} className="text-zinc-700 hover:text-white text-xl leading-none">x</button>
                    </div>
                  ))}
                </div>

                <div className="border border-zinc-900 bg-zinc-950 px-4 py-3">
                  <div className="flex flex-wrap gap-4 text-xs font-mono text-zinc-600">
                    <span>{files.length} file{files.length === 1 ? '' : 's'}</span>
                    <span>{formatBytes(totalSelectedSize)}</span>
                    <span className="text-white">
                      {durationsReady ? formatDuration(totalSelectedDuration) : 'Calculating total duration...'}
                    </span>
                  </div>
                  {unreadableDurationCount > 0 && (
                    <p className="mt-2 text-[11px] text-amber-400">
                      Duration could not be read for {unreadableDurationCount} file{unreadableDurationCount === 1 ? '' : 's'}.
                    </p>
                  )}
                </div>
              </div>
            )}

            <div>
              <label className="block text-xs font-bold uppercase tracking-wider text-zinc-500 mb-2">Output Filename</label>
              <input value={outName} onChange={event => setOutName(event.target.value)} className="w-full bg-zinc-950 border border-zinc-800 px-3 py-2 text-sm text-white font-mono outline-none focus:border-zinc-600" />
            </div>

            <div className="border border-zinc-900 px-4 py-3 text-xs text-zinc-600">
              Merge mode: <span className="text-white font-mono">Sequential - no inserted gaps - no transitions</span>
            </div>
            {sysInfo && (!sysInfo.ffmpegInstalled || !sysInfo.ffprobeInstalled) && <p className="border border-red-900 bg-red-950/20 px-4 py-3 text-xs text-red-400">FFmpeg and FFprobe are required. Configure them in <Link className="text-white underline" to="/settings">Settings</Link>.</p>}
            {error && <p className="border border-red-900 bg-red-950/20 px-4 py-3 text-xs text-red-400">{error}</p>}
            <button disabled={files.length < 5 || submitting || !sysInfo?.ffmpegInstalled || !sysInfo?.ffprobeInstalled} className="w-full py-3 text-sm font-bold uppercase tracking-widest bg-white text-black hover:bg-zinc-200 disabled:bg-zinc-900 disabled:text-zinc-700 disabled:cursor-not-allowed">{submitting ? 'Uploading...' : 'Merge Audio'}</button>
          </form>
        ) : (
          <div className="border border-zinc-800 p-6 space-y-5">
            <div>
              <p className="text-xs uppercase tracking-widest text-zinc-600">Merge Job</p>
              <p className="text-sm text-white mt-1 truncate">{job.filename}</p>
            </div>

            {active && (
              <div>
                <div className="flex justify-between text-xs font-mono text-zinc-600 mb-2">
                  <span>{job.status === 'pending' ? 'Waiting in queue' : 'Merging audio'}</span>
                  <span className="text-white">{job.progress || 0}%</span>
                </div>
                <div className="h-px bg-zinc-800 overflow-hidden">
                  <div className="h-full bg-white transition-all duration-700" style={{ width: `${job.progress || 0}%` }} />
                </div>
              </div>
            )}

            {job.status === 'completed' && (
              <div className="space-y-4">
                <p className="text-sm text-emerald-400">Merged audio ready.</p>
                <div className="flex gap-4 text-xs font-mono text-zinc-600">
                  <span>{formatDuration(job.target_duration)}</span>
                  <span>{formatBytes(job.output_size)}</span>
                  <span>320kbps MP3</span>
                </div>
                <audio src={`/outputs/${outputFile}`} controls className="w-full" />
                <a href={`/outputs/${outputFile}`} download={outputFile} className="block w-full py-3 text-center text-sm font-bold uppercase tracking-widest bg-white text-black hover:bg-zinc-200">Download Audio</a>
              </div>
            )}

            {job.status === 'failed' && <p className="border border-red-900 bg-red-950/20 px-4 py-3 text-xs text-red-400">{job.error_message || 'Merge failed.'}</p>}
            {job.status === 'cancelled' && <p className="text-xs text-zinc-500">Merge cancelled.</p>}
            <div className="flex items-center justify-between">
              <button onClick={reset} className="text-xs font-mono text-zinc-500 hover:text-white">Merge another set</button>
              <Link to="/history" className="text-xs font-mono text-zinc-500 hover:text-white underline">History</Link>
            </div>
          </div>
        )}
      </div>
    </Layout>
  )
}
