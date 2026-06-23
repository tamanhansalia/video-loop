import { useEffect, useMemo, useState } from 'react'
import Layout from '../components/Layout'
import PreviewModal from '../components/PreviewModal'
import LogViewer from '../components/LogViewer'

const STATUS = {
  pending: ['PENDING', 'text-zinc-500'],
  preparing: ['PREPARING', 'text-amber-400'],
  processing: ['PROCESSING', 'text-white'],
  finalizing: ['FINALIZING', 'text-white'],
  completed: ['COMPLETE', 'text-emerald-400'],
  failed: ['FAILED', 'text-red-400'],
  cancelled: ['CANCELLED', 'text-zinc-600'],
  interrupted: ['INTERRUPTED', 'text-amber-400'],
}

const basename = value => value?.replace(/\\/g, '/').split('/').pop() || ''

const formatBytes = bytes => {
  if (!bytes || bytes <= 0) return null
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), 4)
  return `${(bytes / Math.pow(1024, i)).toFixed(i >= 2 ? 1 : 0)} ${units[i]}`
}

const formatDuration = seconds => {
  if (!seconds || Number.isNaN(Number(seconds))) return null
  const value = Number(seconds)
  const h = Math.floor(value / 3600)
  const m = Math.floor((value % 3600) / 60)
  const s = Math.floor(value % 60)
  return h ? `${h}h ${m}m ${s}s` : m ? `${m}m ${s}s` : `${s}s`
}

const formatDate = value => {
  if (!value) return 'Unknown time'
  return new Date(value).toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
}

const getTool = job => {
  if (job.job_type === 'mp4_to_mp3') return { category: 'mp3', label: 'MP4 to MP3 Converter', detail: 'Audio extraction · CBR 320kbps' }
  if (job.job_type === 'audio_merge') return { category: 'audio_merge', label: 'Audio Merger', detail: 'Sequential audio merge · CBR 320kbps' }
  if (job.job_type === 'audio_loop') return { category: 'audio_loop', label: 'Audio Looper', detail: 'Smooth cyclic audio loop · CBR 320kbps' }
  if (job.job_type === 'audio_loop') {
    const modeDetail = job.audio_loop_mode === 'repeat_count' && job.repeat_count ? `${job.repeat_count}x repeats` : 'Exact duration'
    return { category: 'audio_loop', label: 'Audio Looper', detail: `Smooth cyclic audio loop · ${modeDetail} · CBR 320kbps` }
  }
  if (job.job_type === 'audio_visual') {
    const visual = job.visual_type === 'image' ? 'Image' : 'Video'
    const mode = job.animation_mode === 'pingpong' ? 'Ping-Pong Animation'
      : job.animation_mode === 'still' ? 'Still Visual'
      : 'Loop Animation'
    return { category: 'audio_visual', label: 'Audio Visual Generator', detail: `${visual} · ${mode}` }
  }
  if (job.loop_style === 'pingpong') return { category: 'reverse', label: 'Ping-Pong Video', detail: 'Forward and reverse loop animation' }
  if (job.loop_style === 'reverse') return { category: 'reverse', label: 'Reverse Video', detail: 'Reverse playback loop' }
  if (job.reverse_mode && job.reverse_mode !== 'disabled') {
    const mode = job.reverse_mode === 'both' ? 'Video and audio' : job.reverse_mode
    return { category: 'reverse', label: 'Reverse Video', detail: `${mode} reversal` }
  }
  return { category: 'loop', label: 'Loop Generator', detail: 'Seamless video loop' }
}

export default function HistoryPage() {
  const [jobs, setJobs] = useState([])
  const [filter, setFilter] = useState('all')
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [preview, setPreview] = useState(null)
  const [logJob, setLogJob] = useState(null)
  const [actionError, setActionError] = useState(null)

  const loadJobs = async () => {
    try {
      const response = await fetch('/api/jobs')
      if (response.ok) setJobs(await response.json())
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadJobs()
    const interval = setInterval(loadJobs, 4000)
    return () => clearInterval(interval)
  }, [])

  const openFolder = async id => {
    setActionError(null)
    try {
      const response = await fetch(`/api/jobs/${id}/reveal`, { method: 'POST' })
      if (response.ok) return
      const data = await response.json().catch(() => ({}))
      setActionError(data.error || 'Could not open the output folder.')
    } catch {
      setActionError('Could not open the output folder.')
    }
  }

  const entries = useMemo(() => jobs
    .map(job => ({ job, tool: getTool(job) }))
    .filter(({ job, tool }) => {
      if (filter !== 'all' && tool.category !== filter) return false
      return !search || `${job.filename} ${tool.label} ${tool.detail}`.toLowerCase().includes(search.toLowerCase())
    }), [jobs, filter, search])

  return (
    <Layout>
      <main className="max-w-screen-xl mx-auto px-6 py-8">
        <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4 border-b border-zinc-900 pb-4">
          <div>
            <h2 className="text-xs font-bold uppercase tracking-widest text-zinc-400">Activity History</h2>
            <p className="text-xs text-zinc-700 mt-2">Complete cross-feature job activity from every tool.</p>
          </div>
          <span className="text-xs font-mono text-zinc-700">{jobs.length} total actions</span>
        </div>

        <div className="flex flex-col lg:flex-row gap-3 mt-5">
          <input
            value={search}
            onChange={event => setSearch(event.target.value)}
            placeholder="Search filename or tool..."
            className="flex-1 bg-black border border-zinc-900 px-3 py-2 text-sm text-white font-mono placeholder-zinc-800 focus:border-zinc-700 outline-none"
          />
          <div className="flex flex-wrap gap-2">
            {[
              ['all', 'All'],
              ['loop', 'Loop'],
              ['reverse', 'Reverse'],
              ['audio_visual', 'Audio Visual'],
              ['mp3', 'MP4 to MP3'],
              ['audio_merge', 'Audio Merger'],
              ['audio_loop', 'Audio Looper'],
            ].map(([value, label]) => (
              <button
                key={value}
                onClick={() => setFilter(value)}
                className={`px-3 py-2 text-xs uppercase tracking-wider border transition-colors ${filter === value ? 'border-zinc-600 bg-zinc-900 text-white' : 'border-zinc-900 text-zinc-600 hover:border-zinc-700 hover:text-zinc-400'}`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <div className="space-y-2 mt-5">
          {actionError && <p className="border border-red-900 bg-red-950/20 px-4 py-3 text-xs text-red-400">{actionError}</p>}
          {loading ? (
            <div className="border border-zinc-900 p-10 text-center text-sm text-zinc-700">Loading activity...</div>
          ) : entries.length === 0 ? (
            <div className="border border-zinc-900 p-10 text-center text-sm text-zinc-700">No history entries match the current view.</div>
          ) : entries.map(({ job, tool }) => {
            const [statusLabel, statusClass] = STATUS[job.status] || STATUS.pending
            const outputFile = basename(job.output_path)
            const outputUrl = outputFile ? `/outputs/${outputFile}` : null
            const isAudioOnly = ['mp4_to_mp3', 'audio_merge', 'audio_loop'].includes(job.job_type)
            return (
              <article key={job.id} className="border border-zinc-900 px-4 py-4 hover:border-zinc-800 transition-colors">
                <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <span className={`text-xs font-bold font-mono tracking-wider ${statusClass}`}>{statusLabel}</span>
                      <span className="text-xs font-mono text-zinc-700">{formatDate(job.created_at)}</span>
                    </div>
                    <p className="text-sm text-white mt-2 truncate" title={job.filename}>{job.filename}</p>
                    <p className="text-xs text-zinc-500 mt-1">{tool.label}</p>
                    <p className="text-xs text-zinc-700 mt-0.5">{tool.detail}</p>
                    <div className="flex flex-wrap gap-x-3 gap-y-1 mt-2 text-xs font-mono text-zinc-700">
                      {formatDuration(job.target_duration) && <span>{formatDuration(job.target_duration)}</span>}
                      {job.job_type === 'audio_loop' && job.audio_loop_mode === 'repeat_count' && job.repeat_count ? <span>{job.repeat_count}x repeats</span> : null}
                      {job.resolution && <span>{job.resolution}</span>}
                      {job.encoder_used && <span>{job.encoder_used}</span>}
                      {formatBytes(job.output_size) && <span>{formatBytes(job.output_size)}</span>}
                    </div>
                    {job.error_message && <p className="text-xs text-red-400 font-mono mt-2">{job.error_message}</p>}
                  </div>

                  <div className="flex flex-wrap items-center gap-3 shrink-0 text-xs font-mono">
                    {outputUrl && <button onClick={() => setPreview({ url: outputUrl, name: job.filename })} className="text-white hover:text-zinc-300 underline underline-offset-2 decoration-zinc-800">{isAudioOnly ? 'Play' : 'Preview'}</button>}
                    {outputUrl && <a href={outputUrl} download={outputFile} className="text-white hover:text-zinc-300 underline underline-offset-2 decoration-zinc-800">Download</a>}
                    {outputUrl && <button onClick={() => openFolder(job.id)} className="text-zinc-500 hover:text-zinc-300 underline underline-offset-2 decoration-zinc-800">Open Folder</button>}
                    <button onClick={() => setLogJob(job)} className="text-zinc-500 hover:text-zinc-300 underline underline-offset-2 decoration-zinc-800">Logs</button>
                  </div>
                </div>
              </article>
            )
          })}
        </div>
      </main>

      {preview && <PreviewModal videoUrl={preview.url} filename={preview.name} onClose={() => setPreview(null)} />}
      {logJob && <LogViewer jobId={logJob.id} filename={logJob.filename} onClose={() => setLogJob(null)} />}
    </Layout>
  )
}
