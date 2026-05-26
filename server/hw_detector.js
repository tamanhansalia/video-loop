import { spawn } from 'child_process'

// Let user override ffmpeg paths if needed
let ffmpegPath = 'ffmpeg'
let ffprobePath = 'ffprobe'

export function setFfmpegPaths(customFfmpeg, customFfprobe) {
  if (customFfmpeg) ffmpegPath = customFfmpeg
  if (customFfprobe) ffprobePath = customFfprobe
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
  return new Promise((resolve) => {
    const ffmpeg = spawn(ffmpegPath, ['-encoders'])
    let output = ''

    ffmpeg.stdout.on('data', (data) => {
      output += data.toString()
    })

    ffmpeg.stderr.on('data', (data) => {
      output += data.toString()
    })

    ffmpeg.on('error', () => {
      resolve({
        nvenc: false,
        amf: false,
        qsv: false,
        list: []
      })
    })

    ffmpeg.on('close', () => {
      const encoders = {
        nvenc: output.includes('h264_nvenc') || output.includes('hevc_nvenc'),
        amf: output.includes('h264_amf') || output.includes('hevc_amf'),
        qsv: output.includes('h264_qsv') || output.includes('hevc_qsv'),
        list: []
      }

      if (output.includes('h264_nvenc')) encoders.list.push('h264_nvenc (NVIDIA NVENC)')
      if (output.includes('hevc_nvenc')) encoders.list.push('hevc_nvenc (NVIDIA NVENC)')
      if (output.includes('h264_amf')) encoders.list.push('h264_amf (AMD AMF)')
      if (output.includes('hevc_amf')) encoders.list.push('hevc_amf (AMD AMF)')
      if (output.includes('h264_qsv')) encoders.list.push('h264_qsv (Intel QuickSync)')
      if (output.includes('hevc_qsv')) encoders.list.push('hevc_qsv (Intel QuickSync)')

      resolve(encoders)
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
