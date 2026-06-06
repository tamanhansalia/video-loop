import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import ErrorBoundary from './components/common/ErrorBoundary'
import HomePage from './pages/HomePage'
import LoopPage from './pages/LoopPage'
import ReversePage from './pages/ReversePage'
import SettingsPage from './pages/SettingsPage'
import AudioVisualPage from './pages/AudioVisualPage'
import Mp4ToMp3Page from './pages/Mp4ToMp3Page'
import AudioMergePage from './pages/AudioMergePage'
import AudioLoopPage from './pages/AudioLoopPage'
import HistoryPage from './pages/HistoryPage'

export default function App() {
  return (
    <ErrorBoundary>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/loop" element={<LoopPage />} />
          <Route path="/reverse" element={<ReversePage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/audio-visual" element={<AudioVisualPage />} />
          <Route path="/mp4-to-mp3" element={<Mp4ToMp3Page />} />
          <Route path="/audio-merge" element={<AudioMergePage />} />
          <Route path="/audio-loop" element={<AudioLoopPage />} />
          <Route path="/history" element={<HistoryPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </ErrorBoundary>
  )
}
