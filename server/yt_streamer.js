import { spawn, exec as execCb } from 'child_process'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { getFfmpegPath } from './hw_detector.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = path.join(__dirname, '../data')
const ASSETS_DIR = path.join(DATA_DIR, 'yt-live-assets')
const CONFIG_PATH = path.join(DATA_DIR, 'yt-stream.json')
const CONCAT_PATH = path.join(DATA_DIR, 'yt-playlist.txt')

export { ASSETS_DIR as YT_LIVE_ASSETS_DIR }

for (const dir of [DATA_DIR, ASSETS_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}

function fp(p) { return p.replace(/\\/g, '/') }

let streamKey = ''
let audioFiles = []
let background = null
let status = 'offline'
let currentSongIndex = -1
let currentSongName = ''
let elapsedSeconds = 0
let errorMessage = ''
let ffmpegProc = null
let broadcastFn = null
let restartTimer = null
let stoppedByUser = false
let lastBroadcastAt = 0

export function initYtStreamer(onBroadcast) {
  broadcastFn = onBroadcast
  loadConfig()
}

function loadConfig() {
  try {
    if (!fs.existsSync(CONFIG_PATH)) return
    const d = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
    streamKey = d.streamKey || ''
    if (Array.isArray(d.audioFiles)) audioFiles = d.audioFiles.filter(f => fs.existsSync(f.path))
    if (d.background && fs.existsSync(d.background.path)) background = d.background
  } catch { /* ignore corrupt config */ }
}

function saveConfig() {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({ streamKey, audioFiles, background }, null, 2), 'utf8')
  } catch { /* best effort */ }
}

function broadcast(immediate) {
  if (!broadcastFn) return
  if (!immediate) {
    const now = Date.now()
    if (now - lastBroadcastAt < 2000) return
    lastBroadcastAt = now
  } else {
    lastBroadcastAt = Date.now()
  }
  broadcastFn()
}

export function getYtLiveStatus() {
  return {
    hasStreamKey: !!streamKey,
    streamKeyPreview: streamKey ? '••••' + streamKey.slice(-4) : '',
    audioFiles: audioFiles.map(f => ({ id: f.id, name: f.originalName, durationSec: f.durationSec })),
    background: background ? {
      id: background.id,
      name: background.originalName,
      type: background.type,
      url: `/yt-live-assets/${background.filename}`,
    } : null,
    status,
    currentSongIndex,
    currentSongName,
    elapsedSeconds,
    errorMessage,
    ffmpegRunning: ffmpegProc !== null,
  }
}

export function setYtStreamKey(key) {
  streamKey = key || ''
  saveConfig()
  broadcast(true)
}

export function addYtAudioFiles(files) {
  for (const f of files) {
    audioFiles.push({
      id: Date.now().toString(36) + Math.random().toString(36).substr(2, 5),
      filename: f.filename || path.basename(f.path),
      originalName: f.originalname,
      path: f.path,
      durationSec: f.durationSec || 0,
    })
  }
  saveConfig()
  broadcast(true)
}

export function removeYtAudioFile(id) {
  const idx = audioFiles.findIndex(f => f.id === id)
  if (idx === -1) return false
  const removed = audioFiles.splice(idx, 1)[0]
  try { if (fs.existsSync(removed.path)) fs.unlinkSync(removed.path) } catch { /* */ }
  saveConfig()
  broadcast(true)
  return true
}

export function setYtBackground(file, type) {
  if (background) {
    try { if (fs.existsSync(background.path)) fs.unlinkSync(background.path) } catch { /* */ }
  }
  background = {
    id: Date.now().toString(36) + Math.random().toString(36).substr(2, 5),
    filename: file.filename || path.basename(file.path),
    originalName: file.originalname,
    path: file.path,
    type,
  }
  saveConfig()
  broadcast(true)
}

export function clearYtBackground() {
  if (background) {
    try { if (fs.existsSync(background.path)) fs.unlinkSync(background.path) } catch { /* */ }
  }
  background = null
  saveConfig()
  broadcast(true)
}

function computeCurrentSong(sec) {
  if (audioFiles.length === 0) return { index: -1, name: '' }
  const total = audioFiles.reduce((sum, f) => sum + f.durationSec, 0)
  if (total <= 0) return { index: 0, name: audioFiles[0].originalName }
  const pos = sec % total
  let acc = 0
  for (let i = 0; i < audioFiles.length; i++) {
    acc += audioFiles[i].durationSec
    if (pos < acc) return { index: i, name: audioFiles[i].originalName }
  }
  return { index: 0, name: audioFiles[0].originalName }
}

export function startYtStream() {
  if (ffmpegProc) return { error: 'Stream is already running.' }
  if (!streamKey) return { error: 'Stream key is required.' }
  if (audioFiles.length === 0) return { error: 'At least one audio file is required.' }
  if (!background) return { error: 'A background image or video is required.' }

  stoppedByUser = false
  status = 'starting'
  errorMessage = ''
  elapsedSeconds = 0
  currentSongIndex = 0
  currentSongName = audioFiles[0]?.originalName || ''
  broadcast(true)

  const lines = audioFiles.map(f => `file '${fp(f.path)}'`).join('\n')
  fs.writeFileSync(CONCAT_PATH, lines, 'utf8')

  const ffmpeg = getFfmpegPath()
  const rtmpUrl = `rtmp://a.rtmp.youtube.com/live2/${streamKey}`
  const args = []

  if (background.type === 'image') {
    args.push('-re', '-loop', '1', '-i', fp(background.path))
  } else {
    args.push('-re', '-stream_loop', '-1', '-i', fp(background.path))
  }

  args.push(
    '-stream_loop', '-1',
    '-f', 'concat', '-safe', '0', '-i', fp(CONCAT_PATH),
    '-map', '0:v', '-map', '1:a',
    '-c:v', 'libx264', '-preset', 'veryfast',
    '-b:v', '3000k', '-maxrate', '3000k', '-bufsize', '6000k',
    '-pix_fmt', 'yuv420p', '-g', '60', '-r', '30',
    '-vf', 'scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:black',
    '-c:a', 'aac', '-b:a', '160k', '-ar', '44100',
    '-f', 'flv', rtmpUrl,
  )

  console.log('[yt-streamer] Starting stream to YouTube...')

  try {
    ffmpegProc = spawn(ffmpeg, args)
  } catch (err) {
    status = 'error'
    errorMessage = `Failed to start FFmpeg: ${err.message}`
    ffmpegProc = null
    broadcast(true)
    return { error: errorMessage }
  }

  ffmpegProc.stdout.on('data', () => {})

  ffmpegProc.stderr.on('data', (data) => {
    const chunk = data.toString()
    const timeMatch = chunk.match(/time=(\d+):(\d+):([\d.]+)/)
    if (timeMatch) {
      const sec = parseInt(timeMatch[1]) * 3600 + parseInt(timeMatch[2]) * 60 + parseFloat(timeMatch[3])
      elapsedSeconds = Math.round(sec)
      const song = computeCurrentSong(sec)
      currentSongIndex = song.index
      currentSongName = song.name
      if (status === 'starting') {
        status = 'live'
        broadcast(true)
      } else {
        broadcast(false)
      }
    }
  })

  ffmpegProc.on('error', (err) => {
    console.error('[yt-streamer] FFmpeg error:', err.message)
    status = 'error'
    errorMessage = err.message
    ffmpegProc = null
    broadcast(true)
    scheduleRestart()
  })

  ffmpegProc.on('close', (code) => {
    ffmpegProc = null
    if (stoppedByUser) {
      console.log('[yt-streamer] Stream stopped by user.')
      status = 'offline'
      currentSongIndex = -1
      currentSongName = ''
      elapsedSeconds = 0
    } else {
      console.log(`[yt-streamer] FFmpeg exited with code ${code}. Auto-restarting...`)
      status = 'error'
      errorMessage = `FFmpeg exited unexpectedly (code ${code}). Auto-restarting in 5s...`
      scheduleRestart()
    }
    broadcast(true)
  })

  return { success: true }
}

function scheduleRestart() {
  if (stoppedByUser) return
  if (restartTimer) clearTimeout(restartTimer)
  restartTimer = setTimeout(() => {
    restartTimer = null
    if (stoppedByUser) return
    if (streamKey && audioFiles.length > 0 && background) {
      startYtStream()
    }
  }, 5000)
}

export function stopYtStream() {
  stoppedByUser = true
  if (restartTimer) { clearTimeout(restartTimer); restartTimer = null }
  if (!ffmpegProc) {
    status = 'offline'
    currentSongIndex = -1
    currentSongName = ''
    elapsedSeconds = 0
    broadcast(true)
    return { success: true }
  }
  try {
    if (process.platform === 'win32') {
      execCb(`taskkill /F /T /PID ${ffmpegProc.pid}`)
    } else {
      ffmpegProc.kill('SIGTERM')
    }
  } catch { /* ignore */ }
  return { success: true }
}

export function restartYtStream() {
  stoppedByUser = true
  if (restartTimer) { clearTimeout(restartTimer); restartTimer = null }

  const doStart = () => {
    stoppedByUser = false
    startYtStream()
  }

  if (!ffmpegProc) {
    doStart()
    return { success: true }
  }

  const proc = ffmpegProc
  const onClose = () => {
    proc.removeListener('close', onClose)
    setTimeout(doStart, 1000)
  }
  proc.on('close', onClose)

  try {
    if (process.platform === 'win32') {
      execCb(`taskkill /F /T /PID ${proc.pid}`)
    } else {
      proc.kill('SIGTERM')
    }
  } catch { /* ignore */ }

  return { success: true }
}
