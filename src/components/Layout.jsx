import { NavLink } from 'react-router-dom'

export default function Layout({ children }) {
  return (
    <div
      className="min-h-screen bg-black text-white flex flex-col"
      style={{ fontFamily: 'system-ui, -apple-system, sans-serif' }}
    >
      <header className="sticky top-0 z-30 bg-black border-b border-zinc-900">
        <div className="max-w-screen-xl mx-auto px-6 h-11 flex items-center gap-8">
          <NavLink
            to="/"
            className="text-xs font-bold tracking-widest text-white hover:text-zinc-300 transition-colors"
          >
            LOOPSTUDIO
          </NavLink>
          <nav className="flex items-center gap-5 overflow-x-auto whitespace-nowrap">
            {[
              ['/', 'Home', true],
              ['/loop', 'Loop', false],
              ['/reverse', 'Reverse Video', false],
              ['/audio-visual', 'Audio Visual', false],
              ['/mp4-to-mp3', 'MP4 to MP3', false],
              ['/audio-merge', 'Audio Merger', false],
              ['/audio-loop', 'Audio Looper', false],
              ['/live-control', 'Live Studio', false],
              ['/history', 'History', false],
              ['/settings', 'Settings', false],
            ].map(([to, label, exact]) => (
              <NavLink
                key={to}
                to={to}
                end={exact}
                className={({ isActive }) =>
                  `text-xs uppercase tracking-wider transition-colors ${
                    isActive
                      ? 'text-white border-b border-white pb-px'
                      : 'text-zinc-600 hover:text-zinc-400'
                  }`
                }
              >
                {label}
              </NavLink>
            ))}
          </nav>
        </div>
      </header>
      <div className="flex-1">{children}</div>
      <footer className="border-t border-zinc-900 py-4 text-center text-xs text-zinc-800 font-mono">
        LOOPSTUDIO · Local render server · Processing on-device
      </footer>
    </div>
  )
}
