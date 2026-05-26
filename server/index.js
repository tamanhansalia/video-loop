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

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PORT = process.env.PORT || 5000

const UPLOADS_DIR = path.join(__dirname, '../uploads')
const OUTPUTS_DIR = path.join(__dirname, '../outputs')

// Ensure paths exist
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true })
if (!fs.existsSync(OUTPUTS_DIR)) fs.mkdirSync(OUTPUTS_DIR, { recursive: true })

const app = express()
app.use(cors())
app.use(express.json())

// Serve output files and uploads statically
app.use('/outputs', express.static(OUTPUTS_DIR))
app.use('/uploads', express.static(UPLOADS_DIR))

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
  limits: { fileSize: 10 * 1024 * 1024 * 1024 }, // 10 GB max upload
})

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

// WebSocket setup
const server = http.createServer(app)
const wss = new WebSocketServer({ server })
const clients = new Set()

wss.on('connection', (ws) => {
  clients.add(ws)
  ws.on('close', () => clients.delete(ws))
  ws.on('error', () => clients.delete(ws))
})

function broadcastJobUpdate(jobId) {
  getJobById(jobId).then(job => {
    if (!job) return
    const msg = JSON.stringify({ type: 'job_update', job })
    for (const client of clients) {
      try {
        if (client.readyState === 1) client.send(msg) // 1 = OPEN
      } catch { /* ignore disconnected clients */ }
    }
  }).catch(err => console.error('Broadcast error:', err))
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
      try { fs.unlinkSync(job.output_path) } catch {}
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
          try { await cancelJob(job.id) } catch {}
        }

        if (job.output_path && fs.existsSync(job.output_path)) {
          try { fs.unlinkSync(job.output_path) } catch {}
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
      try { fs.unlinkSync(job.output_path) } catch {}
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
    const job = await getJobById(req.params.id)
    if (!job) return res.status(404).json({ error: 'Job not found' })
    res.json({ logs: job.logs || '' })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.get('/api/system-info', async (req, res) => {
  const ffmpegInstalled = await checkFfmpegInstalled()
  const ffprobeInstalled = await checkFfprobeInstalled()
  const gpuEncoders = await detectGPUEncoders()
  const diskSpace = await getDiskSpace()

  res.json({
    ffmpegInstalled,
    ffprobeInstalled,
    gpuEncoders,
    diskSpace,
    ffmpegPath: getFfmpegPath(),
    ffprobePath: getFfprobePath()
  })
})

app.post('/api/settings/ffmpeg', (req, res) => {
  const { customFfmpeg, customFfprobe } = req.body
  setFfmpegPaths(customFfmpeg, customFfprobe)
  res.json({ success: true })
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
    try { fs.unlinkSync(file.path) } catch {}
    res.json({ duration, fps, width, height, codec, hasAudio, fpsStr })
  } catch (err) {
    try { fs.unlinkSync(file.path) } catch {}
    res.status(500).json({ error: err.message })
  }
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
