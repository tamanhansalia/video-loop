import { spawn } from 'child_process'

// Let user override ffmpeg paths if needed
let ffmpegPath = 'ffmpeg'
let ffprobePath = 'ffprobe'
const GPU_ENCODER_CACHE_MS = 60_000
let gpuEncoderCache = null
let gpuEncoderCacheAt = 0
let gpuEncoderPromise = null

export function setFfmpegPaths(customFfmpeg, customFfprobe) {
  if (customFfmpeg) ffmpegPath = customFfmpeg
  if (customFfprobe) ffprobePath = customFfprobe
  gpuEncoderCache = null
  gpuEncoderCacheAt = 0
  gpuEncoderPromise = null
}

export function getFfmpegPath() {
  return ffmpegPath
}

export function getFfprobePath() {
  return ffprobePath
}

export function checkFfmpegInstalled() {
  return new Promise((resolve) => {
    const ff = spawn(ffmpegPath, ['-version'])
    ff.on('error', () => {
      resolve(false)
    })
    ff.on('close', (code) => {
      resolve(code === 0)
    })
  })
}

export function checkFfprobeInstalled() {
  return new Promise((resolve) => {
    const fp = spawn(ffprobePath, ['-version'])
    fp.on('error', () => {
      resolve(false)
    })
    fp.on('close', (code) => {
      resolve(code === 0)
    })
  })
}

export function detectGPUEncoders() {
  const now = Date.now()
  if (gpuEncoderCache && now - gpuEncoderCacheAt < GPU_ENCODER_CACHE_MS) {
    return Promise.resolve(gpuEncoderCache)
  }
  if (gpuEncoderPromise) return gpuEncoderPromise

  gpuEncoderPromise = new Promise((resolve) => {
    const ffmpeg = spawn(ffmpegPath, ['-encoders'])
    let output = ''
    let settled = false

    ffmpeg.stdout.on('data', (data) => {
      output += data.toString()
    })

    ffmpeg.stderr.on('data', (data) => {
      output += data.toString()
    })

    ffmpeg.on('error', () => {
      settled = true
      resolve({
        nvenc: false,
        amf: false,
        qsv: false,
        list: []
      })
    })

    ffmpeg.on('close', async () => {
      if (settled) return

      const candidates = [
        ['nvenc', 'h264_nvenc', 'h264_nvenc (NVIDIA NVENC)'],
        ['amf', 'h264_amf', 'h264_amf (AMD AMF)'],
        ['qsv', 'h264_qsv', 'h264_qsv (Intel QuickSync)'],
      ].filter(([, encoder]) => output.includes(encoder))

      const results = await Promise.all(candidates.map(async ([type, encoder, label]) => ({
        type,
        label,
        available: await canEncodeWith(encoder),
      })))
      const encoders = { nvenc: false, amf: false, qsv: false, list: [] }
      for (const result of results) {
        if (!result.available) continue
        encoders[result.type] = true
        encoders.list.push(result.label)
      }
      gpuEncoderCache = encoders
      gpuEncoderCacheAt = Date.now()
      resolve(encoders)
    })
  }).finally(() => {
    gpuEncoderPromise = null
  })

  return gpuEncoderPromise
}

function canEncodeWith(encoder) {
  return new Promise((resolve) => {
    const ffmpeg = spawn(ffmpegPath, [
      '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'color=size=16x16:rate=1',
      '-frames:v', '1', '-c:v', encoder, '-f', 'null', '-',
    ])
    let settled = false
    ffmpeg.on('error', () => {
      settled = true
      resolve(false)
    })
    ffmpeg.on('close', code => {
      if (!settled) resolve(code === 0)
    })
  })
}

export async function getBestEncoder(hwAccelSetting) {
  const encoders = await detectGPUEncoders()
  
  if (hwAccelSetting === 'cpu') {
    return 'libx264'
  }

  // NVENC is generally fastest and most reliable for Nvidia cards
  if (encoders.nvenc) {
    return 'h264_nvenc'
  }
  
  // AMD AMF
  if (encoders.amf) {
    return 'h264_amf'
  }

  // Intel QuickSync
  if (encoders.qsv) {
    return 'h264_qsv'
  }

  if (hwAccelSetting === 'gpu') {
    throw new Error('GPU Acceleration requested but no NVENC, AMF, or QuickSync encoder was detected on this PC.')
  }

  // Fallback for auto mode
  return 'libx264'
}
