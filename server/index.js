import express from 'express'
import cors from 'cors'
import multer from 'multer'
import http from 'http'
import { WebSocketServer } from 'ws'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'
import { exec } from 'child_process'
import { initDb, getJobs, getJobById, createJob, updateJob, deleteJob } from './db.js'
import {
  checkFfmpegInstalled,
  checkFfprobeInstalled,
  detectGPUEncoders,
  setFfmpegPaths,
  getFfmpegPath,
  getFfprobePath
} from './hw_detector.js'
import { startWorker, cancelJob } from './worker.js'
import {
  LIVE_ASSETS_DIR,
  addLiveStudioTracks,
  clearLiveStudioQueue,
  clearLiveStudioVideo,
  getLiveStudioPublicState,
  moveLiveStudioTrack,
  removeLiveStudioTrack,
  setLiveStudioVideo,
  skipLiveStudioTrack,
} from './live_studio.js'
import { sanitizeWaveformVisualConfig } from '../src/lib/waveformVisual.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PORT = process.env.PORT || 5000
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024 * 1024

const UPLOADS_DIR = path.join(__dirname, '../uploads')
const OUTPUTS_DIR = path.join(__dirname, '../outputs')

// Ensure paths exist
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true })
if (!fs.existsSync(OUTPUTS_DIR)) fs.mkdirSync(OUTPUTS_DIR, { recursive: true })

const app = express()
app.use(cors())
app.use(express.json())

const SYSTEM_INFO_TTL_MS = 30_000
let systemInfoCache = null
let systemInfoCacheAt = 0
let systemInfoPromise = null

// Serve output files and uploads statically
app.use('/outputs', express.static(OUTPUTS_DIR))
app.use('/uploads', express.static(UPLOADS_DIR))
app.use('/live-assets', express.static(LIVE_ASSETS_DIR))

// Set up storage
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, UPLOADS_DIR)
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + '_' + file.originalname.replace(/[^a-zA-Z0-9.]/g, '_'))
  }
})
const upload = multer({
  storage,
  limits: { fileSize: MAX_UPLOAD_BYTES },
})

const liveAssetStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, LIVE_ASSETS_DIR)
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + '_' + file.originalname.replace(/[^a-zA-Z0-9.]/g, '_'))
  }
})
const liveAssetUpload = multer({
  storage: liveAssetStorage,
  limits: { fileSize: MAX_UPLOAD_BYTES },
})

function removeUploadedFiles(files) {
  for (const file of files.filter(Boolean)) {
    try { if (fs.existsSync(file.path)) fs.unlinkSync(file.path) } catch { /* best-effort cleanup */ }
  }
}

function isAudioFile(file) {
  if (!file) return false
  const ext = path.extname(file.originalname).toLowerCase()
  return file.mimetype.startsWith('audio/') || ['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg', '.opus', '.wma'].includes(ext)
}

function isVideoFile(file) {
  if (!file) return false
  const ext = path.extname(file.originalname).toLowerCase()
  return file.mimetype.startsWith('video/') || ['.mp4', '.mov', '.webm', '.mkv', '.avi', '.m4v'].includes(ext)
}

function isImageFile(file) {
  if (!file) return false
  const ext = path.extname(file.originalname).toLowerCase()
  return file.mimetype.startsWith('image/') || ['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.gif'].includes(ext)
}

function invalidateSystemInfoCache() {
  systemInfoCache = null
  systemInfoCacheAt = 0
  systemInfoPromise = null
}

// System stats helper
function getDiskSpace() {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') {
      resolve({ free: null, total: null })
      return
    }
    exec('wmic logicaldisk where "DeviceID=\'C:\'" get FreeSpace,Size /format:list', (err, stdout) => {
      if (err) {
        resolve({ free: null, total: null })
        return
      }
      const lines = stdout.split('\n')
      let free = null
      let total = null
      lines.forEach(line => {
        if (line.startsWith('FreeSpace=')) {
          free = parseInt(line.split('=')[1].trim(), 10)
        }
        if (line.startsWith('Size=')) {
          total = parseInt(line.split('=')[1].trim(), 10)
        }
      })
      resolve({ free, total })
    })
  })
}

async function getUploadStorageStats() {
  if (!fs.existsSync(UPLOADS_DIR)) {
    return { fileCount: 0, totalBytes: 0 }
  }

  const entries = await fs.promises.readdir(UPLOADS_DIR, { withFileTypes: true })
  let fileCount = 0
  let totalBytes = 0

  for (const entry of entries) {
    if (!entry.isFile()) continue
    const filePath = path.join(UPLOADS_DIR, entry.name)
    try {
      const stats = await fs.promises.stat(filePath)
      if (!stats.isFile()) continue
      fileCount += 1
      totalBytes += stats.size
    } catch {
      // Ignore files that disappear during scan.
    }
  }

  return { fileCount, totalBytes }
}

function probeMedia(filePath) {
  const ffprobe = getFfprobePath()
  return new Promise((resolve, reject) => {
    exec(
      `"${ffprobe}" -v quiet -print_format json -show_streams -show_format "${filePath}"`,
      { maxBuffer: 10 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return reject(err)
        try {
          resolve(JSON.parse(stdout))
        } catch (parseErr) {
          reject(parseErr)
        }
      }
    )
  })
}

function getDurationFromProbe(probeData, streamType) {
  const stream = probeData.streams?.find(entry => entry.codec_type === streamType)
  const duration = parseFloat(probeData.format?.duration || stream?.duration || 0)
  return { stream, duration }
}

// WebSocket setup
const server = http.createServer(app)
const wss = new WebSocketServer({ server })
const clients = new Set()

wss.on('connection', (ws) => {
  clients.add(ws)
  try {
    ws.send(JSON.stringify({ type: 'live_state', state: getLiveStudioPublicState() }))
  } catch {
    // Ignore initial push failures.
  }
  ws.on('close', () => clients.delete(ws))
  ws.on('error', () => clients.delete(ws))
})

function broadcastMessage(payload) {
  const msg = JSON.stringify(payload)
  for (const client of clients) {
    try {
      if (client.readyState === 1) client.send(msg)
    } catch {
      // Ignore disconnected clients.
    }
  }
}

function broadcastJobUpdate(jobId) {
  getJobById(jobId).then(job => {
    if (!job) return
    broadcastMessage({ type: 'job_update', job })
  }).catch(err => console.error('Broadcast error:', err))
}

function broadcastLiveState() {
  try {
    broadcastMessage({ type: 'live_state', state: getLiveStudioPublicState() })
  } catch (err) {
    console.error('Live state broadcast error:', err)
  }
}

async function loadSystemInfo() {
  const now = Date.now()
  if (systemInfoCache && now - systemInfoCacheAt < SYSTEM_INFO_TTL_MS) {
    return systemInfoCache
  }
  if (systemInfoPromise) return systemInfoPromise

  systemInfoPromise = Promise.all([
    checkFfmpegInstalled(),
    checkFfprobeInstalled(),
    detectGPUEncoders(),
    getDiskSpace(),
    getUploadStorageStats(),
  ]).then(([ffmpegInstalled, ffprobeInstalled, gpuEncoders, diskSpace, uploadStats]) => {
    systemInfoCache = {
      ffmpegInstalled,
      ffprobeInstalled,
      gpuEncoders,
      diskSpace,
      uploadStats,
      ffmpegPath: getFfmpegPath(),
      ffprobePath: getFfprobePath()
    }
    systemInfoCacheAt = Date.now()
    return systemInfoCache
  }).finally(() => {
    systemInfoPromise = null
  })

  return systemInfoPromise
}

// API Routes
app.get('/api/jobs', async (req, res) => {
  try {
    const list = await getJobs()
    res.json(list)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.get('/api/jobs/:id', async (req, res) => {
  try {
    const job = await getJobById(req.params.id)
    if (!job) return res.status(404).json({ error: 'Job not found' })
    res.json(job)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.post('/api/jobs', upload.fields([
  { name: 'video', maxCount: 1 },
  { name: 'audio', maxCount: 1 }
]), async (req, res) => {
  try {
    const videoFile = req.files['video'] ? req.files['video'][0] : null
    const audioFile = req.files['audio'] ? req.files['audio'][0] : null

    if (!videoFile) {
      return res.status(400).json({ error: 'Video file is required.' })
    }

    const { target_duration, crossfade, hw_accel, filename, reverse_mode, loop_style, audio_fade } = req.body

    if (!target_duration || isNaN(target_duration) || parseInt(target_duration, 10) < 60) {
      return res.status(400).json({ error: 'Target duration must be at least 60 seconds (1 minute).' })
    }

    const id = Date.now().toString(36) + Math.random().toString(36).substr(2, 5)

    const job = await createJob({
      id,
      filename: filename || videoFile.originalname,
      input_video_path: videoFile.path,
      input_audio_path: audioFile ? audioFile.path : null,
      target_duration: parseInt(target_duration, 10),
      crossfade: parseFloat(crossfade || 0),
      hw_accel: hw_accel || 'auto',
      status: 'pending',
      reverse_mode: reverse_mode || 'disabled',
      loop_style: loop_style || 'standard',
      audio_fade: audio_fade || 'off',
    })

    res.status(201).json(job)
    
    // Start background processing loop
    startWorker(broadcastJobUpdate)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.post('/api/audio-visual-jobs', upload.fields([
  { name: 'visual', maxCount: 1 },
  { name: 'audio', maxCount: 1 }
]), async (req, res) => {
  try {
    const visualFile = req.files['visual'] ? req.files['visual'][0] : null
    const audioFile = req.files['audio'] ? req.files['audio'][0] : null

    if (!visualFile || !audioFile) {
      return res.status(400).json({ error: 'A visual asset and an audio file are required.' })
    }

    const visualExt = path.extname(visualFile.originalname).toLowerCase()
    const audioExt = path.extname(audioFile.originalname).toLowerCase()
    const visualType = visualFile.mimetype.startsWith('image/') || ['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.gif'].includes(visualExt) ? 'image'
      : visualFile.mimetype.startsWith('video/') || ['.mp4', '.mov', '.webm', '.mkv', '.avi', '.m4v'].includes(visualExt) ? 'video'
      : null

    if (!visualType) {
      return res.status(400).json({ error: 'Visual asset must be an image or video file.' })
    }
    if (!audioFile.mimetype.startsWith('audio/') && !['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg'].includes(audioExt)) {
      return res.status(400).json({ error: 'Audio track must be an audio file.' })
    }

    const { filename, animation_mode, hw_accel } = req.body
    const mode = ['still', 'loop', 'pingpong'].includes(animation_mode) ? animation_mode : 'loop'
    const id = Date.now().toString(36) + Math.random().toString(36).substr(2, 5)
    const job = await createJob({
      id,
      filename: filename || visualFile.originalname,
      input_video_path: visualFile.path,
      input_audio_path: audioFile.path,
      target_duration: 0,
      hw_accel: hw_accel || 'auto',
      status: 'pending',
      job_type: 'audio_visual',
      visual_type: visualType,
      animation_mode: mode,
    })

    res.status(201).json(job)
    startWorker(broadcastJobUpdate)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.post('/api/mp4-to-mp3-jobs', upload.single('video'), async (req, res) => {
  const videoFile = req.file
  try {
    if (!videoFile) {
      return res.status(400).json({ error: 'An MP4 video file is required.' })
    }

    const ext = path.extname(videoFile.originalname).toLowerCase()
    if (ext !== '.mp4' && videoFile.mimetype !== 'video/mp4') {
      removeUploadedFiles([videoFile])
      return res.status(400).json({ error: 'Unsupported format. Upload an MP4 video file.' })
    }

    const id = Date.now().toString(36) + Math.random().toString(36).substr(2, 5)
    const job = await createJob({
      id,
      filename: req.body.filename || videoFile.originalname,
      input_video_path: videoFile.path,
      target_duration: 0,
      status: 'pending',
      job_type: 'mp4_to_mp3',
    })

    res.status(201).json(job)
    startWorker(broadcastJobUpdate)
  } catch (err) {
    removeUploadedFiles([videoFile])
    res.status(500).json({ error: err.message })
  }
})

app.post('/api/audio-merge-jobs', upload.array('audio'), async (req, res) => {
  const audioFiles = req.files || []
  try {
    if (audioFiles.length < 5) {
      removeUploadedFiles(audioFiles)
      return res.status(400).json({ error: 'Upload at least 5 audio files to merge.' })
    }

    const invalid = audioFiles.find(file => !isAudioFile(file))
    if (invalid) {
      removeUploadedFiles(audioFiles)
      return res.status(400).json({ error: `Unsupported audio file: ${invalid.originalname}` })
    }

    const id = Date.now().toString(36) + Math.random().toString(36).substr(2, 5)
    const job = await createJob({
      id,
      filename: req.body.filename || 'Merged audio',
      input_video_path: null,
      input_audio_path: JSON.stringify(audioFiles.map(file => file.path)),
      target_duration: 0,
      status: 'pending',
      job_type: 'audio_merge',
    })

    res.status(201).json(job)
    startWorker(broadcastJobUpdate)
  } catch (err) {
    removeUploadedFiles(audioFiles)
    res.status(500).json({ error: err.message })
  }
})

app.post('/api/audio-loop-jobs', upload.single('audio'), async (req, res) => {
  const audioFile = req.file
  try {
    if (!audioFile) {
      return res.status(400).json({ error: 'An audio file is required.' })
    }
    if (!isAudioFile(audioFile)) {
      removeUploadedFiles([audioFile])
      return res.status(400).json({ error: 'Unsupported format. Upload a valid audio file.' })
    }

    const audioLoopMode = req.body.audio_loop_mode === 'repeat_count' ? 'repeat_count' : 'duration'
    const repeatCount = audioLoopMode === 'repeat_count' ? parseInt(req.body.repeat_count, 10) : null
    const targetDuration = Number(req.body.target_duration)

    if (audioLoopMode === 'repeat_count') {
      if (!repeatCount || isNaN(repeatCount) || repeatCount < 1) {
        removeUploadedFiles([audioFile])
        return res.status(400).json({ error: 'Repeat count must be at least 1.' })
      }
    } else if (!targetDuration || isNaN(targetDuration) || targetDuration < 1) {
      removeUploadedFiles([audioFile])
      return res.status(400).json({ error: 'Target duration must be at least 1 second.' })
    }

    const id = Date.now().toString(36) + Math.random().toString(36).substr(2, 5)
    const job = await createJob({
      id,
      filename: req.body.filename || audioFile.originalname,
      input_video_path: null,
      input_audio_path: audioFile.path,
      target_duration: audioLoopMode === 'repeat_count' && (!targetDuration || isNaN(targetDuration)) ? 0 : targetDuration,
      status: 'pending',
      job_type: 'audio_loop',
      audio_loop_mode: audioLoopMode,
      repeat_count: repeatCount,
    })

    res.status(201).json(job)
    startWorker(broadcastJobUpdate)
  } catch (err) {
    removeUploadedFiles([audioFile])
    res.status(500).json({ error: err.message })
  }
})

app.post('/api/waveform-visual-jobs', upload.fields([
  { name: 'background', maxCount: 1 },
  { name: 'audio', maxCount: 1 }
]), async (req, res) => {
  const backgroundFile = req.files?.['background'] ? req.files['background'][0] : null
  const audioFile = req.files?.['audio'] ? req.files['audio'][0] : null

  try {
    if (!audioFile) {
      removeUploadedFiles([backgroundFile, audioFile])
      return res.status(400).json({ error: 'An audio track is required.' })
    }
    if (!isAudioFile(audioFile)) {
      removeUploadedFiles([backgroundFile, audioFile])
      return res.status(400).json({ error: 'Unsupported audio file.' })
    }
    if (backgroundFile && !isImageFile(backgroundFile) && !isVideoFile(backgroundFile)) {
      removeUploadedFiles([backgroundFile, audioFile])
      return res.status(400).json({ error: 'Background asset must be an image or video file.' })
    }

    let waveformConfig
    try {
      waveformConfig = sanitizeWaveformVisualConfig(JSON.parse(req.body.waveform_config || '{}'))
    } catch {
      removeUploadedFiles([backgroundFile, audioFile])
      return res.status(400).json({ error: 'Waveform settings payload is invalid.' })
    }

    const visualType = backgroundFile ? (isImageFile(backgroundFile) ? 'image' : 'video') : 'none'
    const id = Date.now().toString(36) + Math.random().toString(36).substr(2, 5)
    const job = await createJob({
      id,
      filename: req.body.filename || 'waveform-visual.mp4',
      input_video_path: backgroundFile?.path || null,
      input_audio_path: audioFile.path,
      target_duration: 0,
      hw_accel: req.body.hw_accel || 'auto',
      status: 'pending',
      job_type: 'waveform_visual',
      visual_type: visualType,
      animation_mode: waveformConfig.backgroundMode,
      waveform_config: JSON.stringify(waveformConfig),
    })

    res.status(201).json(job)
    startWorker(broadcastJobUpdate)
  } catch (err) {
    removeUploadedFiles([backgroundFile, audioFile])
    res.status(500).json({ error: err.message })
  }
})

app.post('/api/jobs/:id/cancel', async (req, res) => {
  try {
    const cancelled = await cancelJob(req.params.id)
    if (cancelled) {
      res.json({ success: true })
    } else {
      res.status(404).json({ error: 'Job not found or not in active state.' })
    }
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.post('/api/jobs/:id/retry', async (req, res) => {
  try {
    const job = await getJobById(req.params.id)
    if (!job) return res.status(404).json({ error: 'Job not found' })

    // Clean up prior output file
    if (job.output_path && fs.existsSync(job.output_path)) {
      try { fs.unlinkSync(job.output_path) } catch { /* best-effort cleanup */ }
    }

    await updateJob(job.id, {
      status: 'pending',
      progress: 0,
      fps: 0,
      eta: 0,
      output_path: null,
      output_size: 0,
      error_message: null,
      logs: `[${new Date().toLocaleTimeString()}] Retried by user.\n`
    })

    res.json({ success: true })
    broadcastJobUpdate(job.id)
    startWorker(broadcastJobUpdate)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.post('/api/jobs/:id/duplicate', async (req, res) => {
  try {
    const job = await getJobById(req.params.id)
    if (!job) return res.status(404).json({ error: 'Job not found' })

    const id = Date.now().toString(36) + Math.random().toString(36).substr(2, 5)

    const duplicated = await createJob({
      id,
      filename: `Copy of ${job.filename}`,
      input_video_path: job.input_video_path,
      input_audio_path: job.input_audio_path,
      target_duration: job.target_duration,
      crossfade: job.crossfade,
      hw_accel: job.hw_accel,
      status: 'pending',
      reverse_mode: job.reverse_mode || 'disabled',
      loop_style: job.loop_style || 'standard',
      audio_fade: job.audio_fade || 'off',
      job_type: job.job_type || 'loop',
      visual_type: job.visual_type || 'video',
      animation_mode: job.animation_mode || 'loop',
      audio_loop_mode: job.audio_loop_mode || 'duration',
      repeat_count: job.repeat_count || null,
      waveform_config: job.waveform_config || null,
    })

    res.json(duplicated)
    startWorker(broadcastJobUpdate)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.post('/api/jobs/:id/reveal', async (req, res) => {
  try {
    const job = await getJobById(req.params.id)
    if (!job || !job.output_path) {
      return res.status(404).json({ error: 'Job output file not found.' })
    }

    if (!fs.existsSync(job.output_path)) {
      return res.status(404).json({ error: 'Output file does not exist on disk.' })
    }

    if (process.platform === 'win32') {
      exec(`explorer.exe /select,"${job.output_path}"`)
      res.json({ success: true })
    } else {
      res.status(400).json({ error: 'Reveal file only supported on Windows.' })
    }
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.delete('/api/jobs', async (req, res) => {
  try {
    const { ids } = req.body
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'ids array is required.' })
    }

    let deleted = 0
    const errors = []

    for (const id of ids) {
      try {
        const job = await getJobById(id)
        if (!job) continue

        if (['preparing', 'processing', 'finalizing'].includes(job.status)) {
          try { await cancelJob(job.id) } catch { /* best-effort cancellation */ }
        }

        if (job.output_path && fs.existsSync(job.output_path)) {
          try { fs.unlinkSync(job.output_path) } catch { /* best-effort cleanup */ }
        }

        await deleteJob(job.id)
        deleted++
      } catch (err) {
        errors.push({ id, error: err.message })
      }
    }

    res.json({ deleted, errors })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.delete('/api/jobs/:id', async (req, res) => {
  try {
    const job = await getJobById(req.params.id)
    if (!job) return res.status(404).json({ error: 'Job not found' })

    // Stop active renders
    if (['preparing', 'processing', 'finalizing'].includes(job.status)) {
      await cancelJob(job.id)
    }

    // Clean up files
    if (job.output_path && fs.existsSync(job.output_path)) {
      try { fs.unlinkSync(job.output_path) } catch { /* best-effort cleanup */ }
    }
    
    // We can also optionally delete uploads if no other jobs reference them
    // For safety, we'll keep uploads to enable "duplicate" or "retry" but clean up outputs.

    await deleteJob(job.id)
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.get('/api/jobs/:id/logs', async (req, res) => {
  try {
    const job = await getJobById(req.params.id, { includeLogs: true })
    if (!job) return res.status(404).json({ error: 'Job not found' })
    res.json({ logs: job.logs || '' })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.get('/api/system-info', async (req, res) => {
  try {
    res.json(await loadSystemInfo())
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.get('/api/live-studio/state', (req, res) => {
  try {
    res.json(getLiveStudioPublicState())
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.post('/api/live-studio/video', liveAssetUpload.single('video'), async (req, res) => {
  const videoFile = req.file
  try {
    if (!videoFile) {
      return res.status(400).json({ error: 'A looping video file is required.' })
    }
    if (!isVideoFile(videoFile)) {
      removeUploadedFiles([videoFile])
      return res.status(400).json({ error: 'Unsupported format. Upload a valid video file.' })
    }

    const probeData = await probeMedia(videoFile.path)
    const { stream, duration } = getDurationFromProbe(probeData, 'video')
    if (!stream || !duration || Number.isNaN(duration) || duration <= 0) {
      removeUploadedFiles([videoFile])
      return res.status(400).json({ error: 'Could not detect a valid looping video.' })
    }

    setLiveStudioVideo(videoFile, duration)
    const state = getLiveStudioPublicState()
    broadcastLiveState()
    res.status(201).json(state)
  } catch (err) {
    removeUploadedFiles([videoFile])
    res.status(500).json({ error: err.message })
  }
})

app.delete('/api/live-studio/video', (req, res) => {
  try {
    clearLiveStudioVideo()
    const state = getLiveStudioPublicState()
    broadcastLiveState()
    res.json(state)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.post('/api/live-studio/tracks', liveAssetUpload.array('audio'), async (req, res) => {
  const audioFiles = Array.isArray(req.files) ? req.files : []
  try {
    if (audioFiles.length === 0) {
      return res.status(400).json({ error: 'At least one audio track is required.' })
    }
    if (audioFiles.some(file => !isAudioFile(file))) {
      removeUploadedFiles(audioFiles)
      return res.status(400).json({ error: 'Unsupported format. Upload valid audio files.' })
    }

    const filesWithDuration = []
    for (const file of audioFiles) {
      const probeData = await probeMedia(file.path)
      const { stream, duration } = getDurationFromProbe(probeData, 'audio')
      if (!stream || !duration || Number.isNaN(duration) || duration <= 0) {
        removeUploadedFiles(audioFiles)
        return res.status(400).json({ error: `Could not detect a valid audio duration for ${file.originalname}.` })
      }
      filesWithDuration.push({ ...file, durationSec: duration })
    }

    addLiveStudioTracks(filesWithDuration)
    const state = getLiveStudioPublicState()
    broadcastLiveState()
    res.status(201).json(state)
  } catch (err) {
    removeUploadedFiles(audioFiles)
    res.status(500).json({ error: err.message })
  }
})

app.post('/api/live-studio/tracks/:id/move', (req, res) => {
  try {
    const direction = req.body?.direction === 'up' ? 'up' : req.body?.direction === 'down' ? 'down' : null
    if (!direction) {
      return res.status(400).json({ error: 'direction must be "up" or "down".' })
    }

    moveLiveStudioTrack(req.params.id, direction)
    const state = getLiveStudioPublicState()
    broadcastLiveState()
    res.json(state)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.delete('/api/live-studio/tracks/:id', (req, res) => {
  try {
    removeLiveStudioTrack(req.params.id)
    const state = getLiveStudioPublicState()
    broadcastLiveState()
    res.json(state)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.post('/api/live-studio/skip', (req, res) => {
  try {
    skipLiveStudioTrack()
    const state = getLiveStudioPublicState()
    broadcastLiveState()
    res.json(state)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.post('/api/live-studio/clear-queue', (req, res) => {
  try {
    clearLiveStudioQueue()
    const state = getLiveStudioPublicState()
    broadcastLiveState()
    res.json(state)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.post('/api/settings/ffmpeg', (req, res) => {
  const { customFfmpeg, customFfprobe } = req.body
  setFfmpegPaths(customFfmpeg, customFfprobe)
  invalidateSystemInfoCache()
  res.json({ success: true })
})

app.delete('/api/settings/uploads', async (req, res) => {
  try {
    const jobs = await getJobs()
    const activeJob = jobs.find(job => ['pending', 'preparing', 'processing', 'finalizing'].includes(job.status))
    if (activeJob) {
      return res.status(409).json({ error: 'Cannot delete uploads while jobs are queued or processing.' })
    }

    if (!fs.existsSync(UPLOADS_DIR)) {
      invalidateSystemInfoCache()
      return res.json({ success: true, deletedCount: 0, freedBytes: 0, errors: [] })
    }

    const entries = await fs.promises.readdir(UPLOADS_DIR, { withFileTypes: true })
    let deletedCount = 0
    let freedBytes = 0
    const errors = []

    for (const entry of entries) {
      if (!entry.isFile()) continue
      const filePath = path.join(UPLOADS_DIR, entry.name)
      try {
        const stats = await fs.promises.stat(filePath)
        if (!stats.isFile()) continue
        await fs.promises.unlink(filePath)
        deletedCount += 1
        freedBytes += stats.size
      } catch (err) {
        errors.push({ file: entry.name, error: err.message })
      }
    }

    invalidateSystemInfoCache()
    res.json({ success: true, deletedCount, freedBytes, errors })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.post('/api/probe', upload.single('video'), async (req, res) => {
  const file = req.file
  if (!file) return res.status(400).json({ error: 'Video file is required.' })
  try {
    const ffprobe = getFfprobePath()
    const probeData = await new Promise((resolve, reject) => {
      exec(
        `"${ffprobe}" -v quiet -print_format json -show_streams -show_format "${file.path}"`,
        { maxBuffer: 10 * 1024 * 1024 },
        (err, stdout) => {
          if (err) return reject(err)
          try { resolve(JSON.parse(stdout)) } catch (e) { reject(e) }
        }
      )
    })
    const videoStream = probeData.streams?.find(s => s.codec_type === 'video')
    const audioStream = probeData.streams?.find(s => s.codec_type === 'audio')
    const duration = parseFloat(probeData.format?.duration || videoStream?.duration || 0)
    const fpsStr = videoStream?.r_frame_rate || videoStream?.avg_frame_rate || '30/1'
    const [n, d] = fpsStr.split('/').map(Number)
    const fps = d ? n / d : 30
    const width = videoStream?.width || 0
    const height = videoStream?.height || 0
    const codec = videoStream?.codec_name || 'unknown'
    const hasAudio = !!audioStream
    // Clean up the probe temp file
    try { fs.unlinkSync(file.path) } catch { /* best-effort cleanup */ }
    res.json({ duration, fps, width, height, codec, hasAudio, fpsStr })
  } catch (err) {
    try { fs.unlinkSync(file.path) } catch { /* best-effort cleanup */ }
    res.status(500).json({ error: err.message })
  }
})

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: 'Uploaded file exceeds the configured size limit.' })
    }
    return res.status(400).json({ error: `Upload failed: ${err.message}` })
  }
  next(err)
})

// Initialize DB and launch server
initDb().then(() => {
  server.listen(PORT, () => {
    console.log(`Backend server listening on port ${PORT}`)
    // Start worker in case there are pending jobs on restart
    startWorker(broadcastJobUpdate)
  })
}).catch(err => {
  console.error('Fatal database initialization error:', err)
})
