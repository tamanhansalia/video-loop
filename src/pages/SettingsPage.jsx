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
  const gb = bytes / 1024 / 1024 / 1024
  return gb.toFixed(1) + ' GB'
}

function resolveGpuLabel(encoders) {
  if (!encoders) return 'Unknown'
  const active = []
  if (encoders.nvenc) active.push('NVENC')
  if (encoders.amf) active.push('AMF')
  if (encoders.qsv) active.push('QSV')
  return active.length > 0 ? active.join(' | ') : 'None detected'
}

export default function SettingsPage() {
  const [sysInfo, setSysInfo] = useState(null)
  const [ffmpegPath, setFfmpegPath] = useState('')
  const [ffprobePath, setFfprobePath] = useState('')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

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

  const diskFree = sysInfo?.diskSpace?.free ?? null
  const diskTotal = sysInfo?.diskSpace?.total ?? null

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

        {/* Section 3: About */}
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
