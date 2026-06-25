import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import Layout from '../components/Layout'

export default function HomePage() {
  const navigate = useNavigate()
  const [sysInfo, setSysInfo] = useState(null)

  useEffect(() => {
    fetch('/api/system-info')
      .then((r) => r.json())
      .then((data) => setSysInfo(data))
      .catch(() => setSysInfo(null))
  }, [])

  const ffmpegOk = sysInfo?.ffmpegInstalled === true

  return (
    <Layout>
      <div
        className="flex flex-col items-center justify-center px-6"
        style={{ minHeight: 'calc(100vh - 44px - 41px)' }}
      >
        {/* Hero */}
        <div className="text-center mb-10">
          <p className="text-2xl font-bold tracking-widest text-white">LOOPSTUDIO</p>
          <p className="text-xs text-zinc-600 font-mono mt-1">Local video loop generator</p>
        </div>

        {/* Tool cards */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 w-full max-w-4xl">
          <button
            onClick={() => navigate('/live-control')}
            className="border border-zinc-900 p-8 cursor-pointer hover:border-zinc-700 hover:bg-zinc-950 transition-colors w-full text-left"
          >
            <p className="text-2xl font-mono text-zinc-700 mb-4">LIVE 24x7</p>
            <p className="text-sm font-bold uppercase tracking-wider text-white">Live Studio</p>
            <p className="text-xs text-zinc-600 mt-2 leading-relaxed">
              Run one clean OBS-ready live page while controlling video and song queue separately
            </p>
          </button>

          {/* Loop Generator */}
          <button
            onClick={() => navigate('/loop')}
            className="border border-zinc-900 p-8 cursor-pointer hover:border-zinc-700 hover:bg-zinc-950 transition-colors w-full text-left"
          >
            <p className="text-2xl font-mono text-zinc-700 mb-4">▶ ▶ ▶ ▶</p>
            <p className="text-sm font-bold uppercase tracking-wider text-white">Loop Generator</p>
            <p className="text-xs text-zinc-600 mt-2 leading-relaxed">
              Generate long YouTube loops from any source clip
            </p>
          </button>

          {/* MP4 to MP3 */}
          <button
            onClick={() => navigate('/mp4-to-mp3')}
            className="border border-zinc-900 p-8 cursor-pointer hover:border-zinc-700 hover:bg-zinc-950 transition-colors w-full text-left"
          >
            <p className="text-2xl font-mono text-zinc-700 mb-4">MP4 → MP3</p>
            <p className="text-sm font-bold uppercase tracking-wider text-white">MP4 to MP3</p>
            <p className="text-xs text-zinc-600 mt-2 leading-relaxed">
              Extract full-length audio as a high-quality 320kbps MP3
            </p>
          </button>

          {/* Audio Merger */}
          <button
            onClick={() => navigate('/audio-merge')}
            className="border border-zinc-900 p-8 cursor-pointer hover:border-zinc-700 hover:bg-zinc-950 transition-colors w-full text-left"
          >
            <p className="text-2xl font-mono text-zinc-700 mb-4">A + B + C</p>
            <p className="text-sm font-bold uppercase tracking-wider text-white">Audio Merger</p>
            <p className="text-xs text-zinc-600 mt-2 leading-relaxed">
              Combine five or more audio files into one continuous track
            </p>
          </button>

          {/* Audio Looper */}
          <button
            onClick={() => navigate('/audio-loop')}
            className="border border-zinc-900 p-8 cursor-pointer hover:border-zinc-700 hover:bg-zinc-950 transition-colors w-full text-left"
          >
            <p className="text-2xl font-mono text-zinc-700 mb-4">A x N</p>
            <p className="text-sm font-bold uppercase tracking-wider text-white">Audio Looper</p>
            <p className="text-xs text-zinc-600 mt-2 leading-relaxed">
              Extend any audio file to an exact smooth-loop duration
            </p>
          </button>

          {/* Audio Visual */}
          <button
            onClick={() => navigate('/audio-visual')}
            className="border border-zinc-900 p-8 cursor-pointer hover:border-zinc-700 hover:bg-zinc-950 transition-colors w-full text-left"
          >
            <p className="text-2xl font-mono text-zinc-700 mb-4">♫ ▶ ▶ ▶</p>
            <p className="text-sm font-bold uppercase tracking-wider text-white">Audio Visual</p>
            <p className="text-xs text-zinc-600 mt-2 leading-relaxed">
              Match an animated image or looping video to a full audio track
            </p>
          </button>

          <button
            onClick={() => navigate('/waveform-visual')}
            className="border border-zinc-900 p-8 cursor-pointer hover:border-zinc-700 hover:bg-zinc-950 transition-colors w-full text-left"
          >
            <p className="text-2xl font-mono text-zinc-700 mb-4">~ ~ ~ ~</p>
            <p className="text-sm font-bold uppercase tracking-wider text-white">Waveform Visual</p>
            <p className="text-xs text-zinc-600 mt-2 leading-relaxed">
              Create glowing draggable waveform overlays and render them into a finished MP4
            </p>
          </button>

          {/* Reverse Video */}
          <button
            onClick={() => navigate('/reverse')}
            className="border border-zinc-900 p-8 cursor-pointer hover:border-zinc-700 hover:bg-zinc-950 transition-colors w-full text-left"
          >
            <p className="text-2xl font-mono text-zinc-700 mb-4">▶ ◀ ▶ ◀</p>
            <p className="text-sm font-bold uppercase tracking-wider text-white">Reverse Video</p>
            <p className="text-xs text-zinc-600 mt-2 leading-relaxed">
              Reverse or ping-pong clips — seamless looping with no duplicate frames
            </p>
          </button>
        </div>

        {/* Settings link */}
        <button
          onClick={() => navigate('/settings')}
          className="text-xs text-zinc-700 hover:text-zinc-500 font-mono mt-6 transition-colors"
        >
          Settings →
        </button>
        <button
          onClick={() => navigate('/history')}
          className="text-xs text-zinc-700 hover:text-zinc-500 font-mono mt-2 transition-colors"
        >
          View complete history →
        </button>

        {/* System status strip */}
        {sysInfo !== null && (
          <div className="flex items-center gap-2 mt-4 text-xs font-mono text-zinc-700">
            <span
              className={`inline-block w-1.5 h-1.5 rounded-full animate-pulse ${
                ffmpegOk ? 'bg-emerald-500' : 'bg-red-600'
              }`}
            />
            <span>FFmpeg: {ffmpegOk ? 'OK' : 'NOT FOUND'}</span>
          </div>
        )}
      </div>
    </Layout>
  )
}
