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
  if (!seconds || Number.isNaN(Number(seconds))) return '--'
  const value = Number(seconds)
  const h = Math.floor(value / 3600)
  const m = Math.floor((value % 3600) / 60)
  const s = Math.floor(value % 60)
  return h ? `${h}h ${m}m ${s}s` : m ? `${m}m ${s}s` : `${s}s`
}

const clampPad = (value, max) =>
  String(Math.min(max, Math.max(0, parseInt(value, 10) || 0))).padStart(2, '0')

const clampRepeatCount = value => Math.min(9999, Math.max(1, parseInt(value, 10) || 1))

export default function AudioLoopPage() {
  const [audio, setAudio] = useState(null)
  const [drag, setDrag] = useState(false)
  const [loopInputMode, setLoopInputMode] = useState('duration')
  const [hours, setHours] = useState('00')
  const [mins, setMins] = useState('10')
  const [secs, setSecs] = useState('00')
  const [repeatCount, setRepeatCount] = useState(10)
  const [sourceDuration, setSourceDuration] = useState(null)
  const [outName, setOutName] = useState('')
  const [sysInfo, setSysInfo] = useState(null)
  const [job, setJob] = useState(null)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(null)
  const inputRef = useRef(null)

  const targetDuration =
    (parseInt(hours || '0', 10) * 3600) +
    (parseInt(mins || '0', 10) * 60) +
    (parseInt(secs || '0', 10))
  const repeatTargetDuration = sourceDuration ? sourceDuration * repeatCount : 0
  const effectiveTargetDuration = loopInputMode === 'repeat_count' ? repeatTargetDuration : targetDuration

  useEffect(() => {
    fetch('/api/system-info').then(r => r.json()).then(setSysInfo).catch(() => setSysInfo(null))
  }, [])

  useEffect(() => {
    if (!audio) return

    const objectUrl = URL.createObjectURL(audio)
    const previewAudio = new Audio()

    previewAudio.preload = 'metadata'
    previewAudio.src = objectUrl
    previewAudio.onloadedmetadata = () => {
      setSourceDuration(Number.isFinite(previewAudio.duration) && previewAudio.duration > 0 ? previewAudio.duration : null)
      URL.revokeObjectURL(objectUrl)
    }
    previewAudio.onerror = () => {
      setSourceDuration(null)
      URL.revokeObjectURL(objectUrl)
    }

    return () => {
      previewAudio.onloadedmetadata = null
      previewAudio.onerror = null
      previewAudio.src = ''
      URL.revokeObjectURL(objectUrl)
    }
  }, [audio])

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

  const chooseAudio = file => {
    setError(null)
    setSourceDuration(null)
    if (!file) return setAudio(null)
    if (!file.type.startsWith('audio/') && !/\.(mp3|wav|m4a|aac|flac|ogg|opus|wma)$/i.test(file.name)) {
      setAudio(null)
      setError('Unsupported format. Select a valid audio file.')
      return
    }
    setAudio(file)
    if (!outName) setOutName(file.name)
  }

  const submit = async event => {
    event.preventDefault()
    setError(null)
    if (!audio) return setError('Select an audio file.')
    if (loopInputMode === 'duration' && targetDuration < 1) return setError('Target duration must be at least 1 second.')
    if (loopInputMode === 'repeat_count') {
      if (!sourceDuration || sourceDuration <= 0) return setError('Could not read the source audio duration.')
      if (!repeatCount || repeatCount < 1) return setError('Repeat count must be at least 1.')
    }
    setSubmitting(true)
    try {
      const body = new FormData()
      body.append('audio', audio)
      body.append('target_duration', String(effectiveTargetDuration))
      body.append('audio_loop_mode', loopInputMode)
      if (loopInputMode === 'repeat_count') body.append('repeat_count', String(repeatCount))
      body.append('filename', outName || audio.name)
      const response = await fetch('/api/audio-loop-jobs', { method: 'POST', body })
      if (!response.ok) {
        const data = await response.json().catch(() => ({}))
        throw new Error(data.error || 'Loop request failed.')
      }
      setJob(await response.json())
    } catch (err) {
      setError(err.message)
    } finally {
      setSubmitting(false)
    }
  }

  const reset = () => {
    setAudio(null)
    setJob(null)
    setError(null)
    setOutName('')
    setSourceDuration(null)
    if (inputRef.current) inputRef.current.value = ''
  }

  const outputFile = basename(job?.output_path)
  const active = job && !['completed', 'failed', 'cancelled'].includes(job.status)
  const canSubmit =
    Boolean(audio) &&
    !submitting &&
    sysInfo?.ffmpegInstalled &&
    sysInfo?.ffprobeInstalled &&
    (
      loopInputMode === 'duration'
        ? effectiveTargetDuration >= 1
        : Boolean(sourceDuration && repeatCount >= 1)
    )

  return (
    <Layout>
      <div className="max-w-2xl mx-auto px-6 py-8">
        <h2 className="text-xs font-bold uppercase tracking-widest text-zinc-400 mb-2">Audio Looper</h2>
        <p className="text-xs text-zinc-600 mb-6">Extend one audio file to an exact duration using a smooth cyclic loop bed.</p>

        {!job ? (
          <form className="space-y-6" onSubmit={submit}>
            <div>
              <label className="block text-xs font-bold uppercase tracking-wider text-zinc-500 mb-2">Audio Source *</label>
              <div
                onClick={() => inputRef.current?.click()}
                onDragOver={event => { event.preventDefault(); setDrag(true) }}
                onDragLeave={() => setDrag(false)}
                onDrop={event => { event.preventDefault(); setDrag(false); chooseAudio(event.dataTransfer.files[0]) }}
                className={`border p-4 cursor-pointer transition-colors ${drag ? 'border-white bg-zinc-900' : audio ? 'border-zinc-700 bg-zinc-950' : 'border-zinc-900 bg-zinc-950 hover:border-zinc-700'}`}
              >
                <input ref={inputRef} className="hidden" type="file" accept="audio/*,.mp3,.wav,.m4a,.aac,.flac,.ogg,.opus,.wma" onChange={event => chooseAudio(event.target.files?.[0])} />
                {audio ? (
                  <div className="flex justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-sm text-white truncate">{audio.name}</p>
                      <p className="text-xs text-zinc-700 font-mono mt-1">{formatBytes(audio.size)}</p>
                    </div>
                    <button type="button" className="text-zinc-700 hover:text-white text-xl" onClick={event => { event.stopPropagation(); reset() }}>x</button>
                  </div>
                ) : <p className="text-xs text-zinc-600 text-center py-3">Drop an audio file or click to browse</p>}
              </div>
            </div>

            <div>
              <label className="block text-xs font-bold uppercase tracking-wider text-zinc-500 mb-2">Loop Input</label>
              <div className="grid grid-cols-2 gap-2">
                {[
                  ['duration', 'By Duration', 'Set hours, minutes, and seconds.'],
                  ['repeat_count', 'By Repeat Count', 'Repeat the full song N times.'],
                ].map(([mode, label, detail]) => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => setLoopInputMode(mode)}
                    className={`border px-4 py-3 text-left transition-colors ${
                      loopInputMode === mode
                        ? 'border-white bg-white text-black'
                        : 'border-zinc-800 bg-zinc-950 text-zinc-300 hover:border-zinc-600'
                    }`}
                  >
                    <span className="block text-xs font-bold uppercase tracking-wider">{label}</span>
                    <span className={`mt-1 block text-xs font-mono ${loopInputMode === mode ? 'text-zinc-700' : 'text-zinc-600'}`}>{detail}</span>
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="block text-xs font-bold uppercase tracking-wider text-zinc-500 mb-2">Target Duration</label>
              {loopInputMode === 'duration' ? (
                <>
                  <div className="grid grid-cols-3 gap-2">
                    {[
                      ['Hours', hours, setHours, 99],
                      ['Minutes', mins, setMins, 59],
                      ['Seconds', secs, setSecs, 59],
                    ].map(([label, value, setValue, max]) => (
                      <div key={label}>
                        <span className="block text-xs text-zinc-700 font-mono mb-1">{label}</span>
                        <input
                          type="number"
                          min="0"
                          max={max}
                          value={value}
                          onFocus={event => event.target.select()}
                          onChange={event => setValue(clampPad(event.target.value, max))}
                          className="w-full bg-zinc-950 border border-zinc-800 text-center font-mono text-2xl text-white py-2 focus:border-zinc-600 outline-none"
                        />
                      </div>
                    ))}
                  </div>
                  <p className={`mt-2 text-xs font-mono ${targetDuration > 0 ? 'text-zinc-500' : 'text-red-400'}`}>{targetDuration > 0 ? formatDuration(targetDuration) : 'Minimum 1 second'}</p>
                </>
              ) : (
                <>
                  <div className="grid grid-cols-5 gap-2">
                    {[1, 2, 3, 4, 10].map(count => (
                      <button
                        key={count}
                        type="button"
                        onClick={() => setRepeatCount(count)}
                        className={`px-3 py-3 text-sm font-mono transition-colors ${
                          repeatCount === count
                            ? 'bg-white text-black'
                            : 'bg-zinc-950 border border-zinc-800 text-zinc-300 hover:border-zinc-600'
                        }`}
                      >
                        {count}x
                      </button>
                    ))}
                  </div>
                  <div className="mt-3">
                    <span className="block text-xs text-zinc-700 font-mono mb-1">Repeat Count</span>
                    <input
                      type="number"
                      min="1"
                      max="9999"
                      value={repeatCount}
                      onFocus={event => event.target.select()}
                      onChange={event => setRepeatCount(clampRepeatCount(event.target.value))}
                      className="w-full bg-zinc-950 border border-zinc-800 px-3 py-2 text-center font-mono text-2xl text-white outline-none focus:border-zinc-600"
                    />
                  </div>
                  <div className="mt-2 text-xs font-mono">
                    {sourceDuration ? (
                      <p className="text-zinc-500">
                        {formatDuration(sourceDuration)} per play • {repeatCount}x = {formatDuration(repeatTargetDuration)}
                      </p>
                    ) : (
                      <p className="text-zinc-600">Loading source duration...</p>
                    )}
                  </div>
                </>
              )}
            </div>

            {audio && (
              <div>
                <label className="block text-xs font-bold uppercase tracking-wider text-zinc-500 mb-2">Output Filename</label>
                <input value={outName} onChange={event => setOutName(event.target.value)} className="w-full bg-zinc-950 border border-zinc-800 px-3 py-2 text-sm text-white font-mono outline-none focus:border-zinc-600" />
              </div>
            )}

            <div className="border border-zinc-900 px-4 py-3 text-xs text-zinc-600">
              Loop mode: <span className="text-white font-mono">{loopInputMode === 'duration' ? 'Cyclic wrap crossfade - exact output duration' : 'Cyclic wrap crossfade - repeat source track N times'}</span>
            </div>
            {sysInfo && (!sysInfo.ffmpegInstalled || !sysInfo.ffprobeInstalled) && <p className="border border-red-900 bg-red-950/20 px-4 py-3 text-xs text-red-400">FFmpeg and FFprobe are required. Configure them in <Link className="text-white underline" to="/settings">Settings</Link>.</p>}
            {error && <p className="border border-red-900 bg-red-950/20 px-4 py-3 text-xs text-red-400">{error}</p>}
            <button disabled={!canSubmit} className="w-full py-3 text-sm font-bold uppercase tracking-widest bg-white text-black hover:bg-zinc-200 disabled:bg-zinc-900 disabled:text-zinc-700 disabled:cursor-not-allowed">{submitting ? 'Uploading...' : 'Generate Audio Loop'}</button>
          </form>
        ) : (
          <div className="border border-zinc-800 p-6 space-y-5">
            <div>
              <p className="text-xs uppercase tracking-widest text-zinc-600">Loop Job</p>
              <p className="text-sm text-white mt-1 truncate">{job.filename}</p>
            </div>

            {active && (
              <div>
                <div className="flex justify-between text-xs font-mono text-zinc-600 mb-2">
                  <span>{job.status === 'pending' ? 'Waiting in queue' : 'Looping audio'}</span>
                  <span className="text-white">{job.progress || 0}%</span>
                </div>
                <div className="h-px bg-zinc-800 overflow-hidden">
                  <div className="h-full bg-white transition-all duration-700" style={{ width: `${job.progress || 0}%` }} />
                </div>
              </div>
            )}

            {job.status === 'completed' && (
              <div className="space-y-4">
                <p className="text-sm text-emerald-400">Looped audio ready.</p>
                <div className="flex flex-wrap gap-4 text-xs font-mono text-zinc-600">
                  <span>{formatDuration(job.target_duration)}</span>
                  {job.audio_loop_mode === 'repeat_count' && job.repeat_count ? <span>{job.repeat_count}x repeats</span> : null}
                  <span>{formatBytes(job.output_size)}</span>
                  <span>320kbps MP3</span>
                </div>
                <audio src={`/outputs/${outputFile}`} controls className="w-full" />
                <a href={`/outputs/${outputFile}`} download={outputFile} className="block w-full py-3 text-center text-sm font-bold uppercase tracking-widest bg-white text-black hover:bg-zinc-200">Download Audio</a>
              </div>
            )}

            {job.status === 'failed' && <p className="border border-red-900 bg-red-950/20 px-4 py-3 text-xs text-red-400">{job.error_message || 'Looping failed.'}</p>}
            {job.status === 'cancelled' && <p className="text-xs text-zinc-500">Looping cancelled.</p>}
            <div className="flex items-center justify-between">
              <button onClick={reset} className="text-xs font-mono text-zinc-500 hover:text-white">Loop another audio file</button>
              <Link to="/history" className="text-xs font-mono text-zinc-500 hover:text-white underline">History</Link>
            </div>
          </div>
        )}
      </div>
    </Layout>
  )
}
