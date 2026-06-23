import { useEffect, useState, useCallback } from 'react'
import Layout from '../components/Layout'

function SectionHeader({ children }) {
  return (
    <p className="text-xs font-bold uppercase tracking-widest text-zinc-400 mb-4">{children}</p>
  )
}

function StatusDot({ ok }) {
  return (
    <span
      className={`inline-block w-1.5 h-1.5 rounded-full mr-1.5 ${
        ok ? 'bg-emerald-500' : 'bg-red-600 animate-pulse'
      }`}
    />
  )
}

function formatBytes(bytes) {
  if (bytes === null || bytes === undefined) return 'Unknown'
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  const value = bytes / Math.pow(1024, exponent)
  return `${value.toFixed(exponent >= 2 ? 1 : 0)} ${units[exponent]}`
}

function resolveGpuLabel(encoders) {
  if (!encoders) return 'Unknown'
  const active = []
  if (encoders.nvenc) active.push('NVENC')
  if (encoders.amf) active.push('AMF')
  if (encoders.qsv) active.push('QSV')
  return active.length > 0 ? active.join(' | ') : 'None detected'
}

async function readErrorMessage(response, fallback) {
  try {
    const data = await response.clone().json()
    if (data?.error) return data.error
  } catch {
    try {
      const text = await response.text()
      if (text && !text.trim().startsWith('<')) return text
    } catch {
      // Ignore secondary parse failures.
    }
  }

  if (response.status === 404) {
    return 'Uploads cleanup API is unavailable. Restart the backend server and try again.'
  }

  return fallback
}

export default function SettingsPage() {
  const [sysInfo, setSysInfo] = useState(null)
  const [ffmpegPath, setFfmpegPath] = useState('')
  const [ffprobePath, setFfprobePath] = useState('')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [cleaningUploads, setCleaningUploads] = useState(false)
  const [cleanupMessage, setCleanupMessage] = useState(null)

  const fetchSysInfo = useCallback(() => {
    fetch('/api/system-info')
      .then((r) => r.json())
      .then((data) => {
        setSysInfo(data)
        setFfmpegPath(data.ffmpegPath ?? '')
        setFfprobePath(data.ffprobePath ?? '')
      })
      .catch(() => setSysInfo(null))
  }, [])

  useEffect(() => {
    fetchSysInfo()
  }, [fetchSysInfo])

  const handleSave = async () => {
    setSaving(true)
    try {
      await fetch('/api/settings/ffmpeg', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customFfmpeg: ffmpegPath, customFfprobe: ffprobePath }),
      })
      setSaved(true)
      fetchSysInfo()
      setTimeout(() => setSaved(false), 3000)
    } catch {
      // ignore
    } finally {
      setSaving(false)
    }
  }

  const handleDeleteUploads = async () => {
    const confirmed = window.confirm(
      'Delete all uploaded source files? This will free upload storage, but old Retry and Duplicate actions may fail afterward.'
    )
    if (!confirmed) return

    setCleanupMessage(null)
    setCleaningUploads(true)
    try {
      const response = await fetch('/api/settings/uploads', { method: 'DELETE' })
      if (!response.ok) {
        throw new Error(await readErrorMessage(response, 'Failed to delete uploaded files.'))
      }
      const data = await response.json().catch(() => ({}))

      const summary = data.errors?.length
        ? `Deleted ${data.deletedCount} upload file${data.deletedCount !== 1 ? 's' : ''} and freed ${formatBytes(data.freedBytes)}. ${data.errors.length} file${data.errors.length !== 1 ? 's' : ''} could not be removed.`
        : `Deleted ${data.deletedCount} upload file${data.deletedCount !== 1 ? 's' : ''} and freed ${formatBytes(data.freedBytes)}.`

      setCleanupMessage({
        type: data.errors?.length ? 'error' : 'success',
        text: summary,
      })
      fetchSysInfo()
    } catch (err) {
      setCleanupMessage({ type: 'error', text: err.message })
    } finally {
      setCleaningUploads(false)
    }
  }

  const diskFree = sysInfo?.diskSpace?.free ?? null
  const diskTotal = sysInfo?.diskSpace?.total ?? null
  const uploadFileCount = sysInfo?.uploadStats?.fileCount ?? null
  const uploadBytes = sysInfo?.uploadStats?.totalBytes ?? null

  return (
    <Layout>
      <div className="max-w-2xl mx-auto px-6 py-8">

        {/* Section 1: FFmpeg Configuration */}
        <SectionHeader>FFmpeg Configuration</SectionHeader>

        <div className="space-y-4">
          <div>
            <p className="text-xs text-zinc-600 mb-1">FFmpeg executable</p>
            <input
              value={ffmpegPath}
              onChange={(e) => setFfmpegPath(e.target.value)}
              className="w-full bg-zinc-950 border border-zinc-800 px-3 py-1.5 text-xs text-white font-mono focus:border-zinc-600 outline-none transition-colors"
              placeholder="/usr/bin/ffmpeg"
            />
          </div>

          <div>
            <p className="text-xs text-zinc-600 mb-1">FFprobe executable</p>
            <input
              value={ffprobePath}
              onChange={(e) => setFfprobePath(e.target.value)}
              className="w-full bg-zinc-950 border border-zinc-800 px-3 py-1.5 text-xs text-white font-mono focus:border-zinc-600 outline-none transition-colors"
              placeholder="/usr/bin/ffprobe"
            />
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={handleSave}
              disabled={saving}
              className="px-3 py-1 text-xs border border-zinc-700 bg-zinc-800 text-white hover:bg-zinc-700 transition-colors disabled:opacity-50"
            >
              Apply
            </button>
            {saved && (
              <span className="text-xs text-emerald-400 font-mono">Saved.</span>
            )}
          </div>
        </div>

        {/* Section 2: System Status */}
        <div className="mt-8">
          <div className="flex items-center gap-4 mb-4">
            <SectionHeader>System Status</SectionHeader>
            <button
              onClick={fetchSysInfo}
              className="text-xs text-zinc-600 hover:text-zinc-400 font-mono -mt-4 transition-colors"
            >
              ↻ Refresh
            </button>
          </div>

          <div className="space-y-3">
            {/* FFmpeg */}
            <div className="flex justify-between text-xs font-mono">
              <span className="text-zinc-600">FFmpeg</span>
              <span className={sysInfo?.ffmpegInstalled ? 'text-zinc-400' : 'text-red-400'}>
                <StatusDot ok={!!sysInfo?.ffmpegInstalled} />
                {sysInfo?.ffmpegInstalled ? 'Installed' : 'Not detected'}
              </span>
            </div>

            {/* FFprobe */}
            <div className="flex justify-between text-xs font-mono">
              <span className="text-zinc-600">FFprobe</span>
              <span className={sysInfo?.ffprobeInstalled ? 'text-zinc-400' : 'text-red-400'}>
                <StatusDot ok={!!sysInfo?.ffprobeInstalled} />
                {sysInfo?.ffprobeInstalled ? 'Installed' : 'Not detected'}
              </span>
            </div>

            {/* GPU Encoder */}
            <div className="flex justify-between text-xs font-mono">
              <span className="text-zinc-600">GPU Encoder</span>
              <span className="text-zinc-400">
                {sysInfo ? resolveGpuLabel(sysInfo.gpuEncoders) : '—'}
              </span>
            </div>

            {/* Disk Space */}
            <div className="flex justify-between text-xs font-mono">
              <span className="text-zinc-600">Disk Space</span>
              <span className="text-zinc-400">
                {sysInfo
                  ? diskFree !== null && diskTotal !== null
                    ? `${formatBytes(diskFree)} free / ${formatBytes(diskTotal)} total`
                    : 'Unknown'
                  : '—'}
              </span>
            </div>
          </div>
        </div>

        {/* Section 3: Upload Storage */}
        <div className="mt-8 border-t border-zinc-900 pt-8">
          <SectionHeader>Upload Storage</SectionHeader>
          <div className="space-y-4">
            <div className="space-y-3">
              <div className="flex justify-between text-xs font-mono">
                <span className="text-zinc-600">Upload Files</span>
                <span className="text-zinc-400">
                  {sysInfo ? `${uploadFileCount ?? 0} file${uploadFileCount === 1 ? '' : 's'}` : 'â€”'}
                </span>
              </div>
              <div className="flex justify-between text-xs font-mono">
                <span className="text-zinc-600">Upload Size</span>
                <span className="text-zinc-400">
                  {sysInfo ? formatBytes(uploadBytes ?? 0) : 'â€”'}
                </span>
              </div>
            </div>

            <div className="border border-red-950 bg-red-950/10 px-4 py-3 text-xs text-red-300">
              Deletes every file in the local uploads folder. Job history stays, but older retry or duplicate actions may fail because their source files are removed.
            </div>

            {cleanupMessage && (
              <p
                className={`border px-4 py-3 text-xs ${
                  cleanupMessage.type === 'success'
                    ? 'border-emerald-900 bg-emerald-950/20 text-emerald-400'
                    : 'border-red-900 bg-red-950/20 text-red-400'
                }`}
              >
                {cleanupMessage.text}
              </p>
            )}

            <button
              onClick={handleDeleteUploads}
              disabled={cleaningUploads}
              className="px-3 py-2 text-xs border border-red-800 bg-red-950/20 text-red-300 hover:bg-red-950/40 transition-colors disabled:opacity-50"
            >
              {cleaningUploads ? 'Deleting Uploads...' : 'Delete All Uploads'}
            </button>
          </div>
        </div>

        {/* Section 4: About */}
        <div className="mt-8 border-t border-zinc-900 pt-8">
          <SectionHeader>About</SectionHeader>
          <div className="space-y-1 text-xs font-mono text-zinc-700">
            <p>LOOPSTUDIO — Local video loop generator</p>
            <p>Processing on-device · No data sent to servers</p>
            <p>Powered by FFmpeg · React · Node.js</p>
          </div>
        </div>

      </div>
    </Layout>
  )
}
