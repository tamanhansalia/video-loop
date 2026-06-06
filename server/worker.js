import { spawn, exec } from 'child_process'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { getFfmpegPath, getFfprobePath, getBestEncoder } from './hw_detector.js'
import { updateJob, appendLog, getJobById, getJobs } from './db.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const TEMP_DIR = path.join(__dirname, '../data/temp')
const OUTPUTS_DIR = path.join(__dirname, '../outputs')

for (const dir of [TEMP_DIR, OUTPUTS_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}

let isWorkerRunning = false
let currentJobId = null
let currentProcess = null
let onUpdateCallback = null
let cancelledByUser = false

// Normalize path to forward slashes for FFmpeg (required on Windows)
function fp(filePath) {
  return filePath.replace(/\\/g, '/')
}

// Build concat file content: N repetitions of a single file
function buildConcatList(filePath, loops) {
  return Array(loops).fill(`file '${fp(filePath)}'`).join('\n')
}

// Build encoder quality args for a given encoder
function encoderQualityArgs(encoder) {
  if (encoder === 'libx264') return ['-preset', 'fast', '-crf', '18']
  if (encoder.includes('nvenc')) return ['-preset', 'p2', '-rc', 'vbr', '-cq', '19']
  if (encoder.includes('amf')) return ['-quality', 'speed', '-qp_i', '19', '-qp_p', '19']
  if (encoder.includes('qsv')) return ['-preset', 'faster', '-global_quality', '20']
  return []
}

export function startWorker(onJobUpdate) {
  onUpdateCallback = onJobUpdate
  if (isWorkerRunning) return
  isWorkerRunning = true
  processQueue()
}

async function processQueue() {
  try {
    const jobs = await getJobs()
    const pending = jobs.find(j => j.status === 'pending')

    if (!pending) {
      isWorkerRunning = false
      return
    }

    currentJobId = pending.id
    await runRenderJob(pending)
  } catch (err) {
    console.error('Queue processor error:', err)
  }

  setTimeout(processQueue, 1000)
}

export async function cancelJob(id) {
  if (currentJobId === id && currentProcess) {
    cancelledByUser = true
    await appendLog(id, 'Cancellation requested by user.')
    try {
      if (process.platform === 'win32') {
        exec(`taskkill /F /T /PID ${currentProcess.pid}`)
      } else {
        currentProcess.kill('SIGKILL')
      }
    } catch { /* ignore */ }
    return true
  }

  const job = await getJobById(id)
  if (job && ['pending', 'preparing', 'processing', 'finalizing'].includes(job.status)) {
    await updateJob(id, { status: 'cancelled', progress: 0, fps: 0, eta: 0 })
    if (onUpdateCallback) onUpdateCallback(id)
    return true
  }
  return false
}

function probeFile(filePath) {
  return new Promise((resolve, reject) => {
    const args = [
      '-v', 'error',
      '-show_entries', 'format=duration:stream=codec_name,width,height,avg_frame_rate,r_frame_rate,channels,sample_rate,nb_read_packets',
      '-count_packets',
      '-of', 'json',
      filePath
    ]

    const proc = spawn(getFfprobePath(), args)
    let out = ''
    proc.stdout.on('data', d => { out += d.toString() })
    proc.stderr.on('data', d => { out += d.toString() })
    proc.on('error', reject)
    proc.on('close', code => {
      if (code !== 0) {
        reject(new Error(`ffprobe exited with code ${code}. Output: ${out.slice(-500)}`))
        return
      }
      try {
        resolve(JSON.parse(out))
      } catch {
        reject(new Error('Failed to parse ffprobe JSON output'))
      }
    })
  })
}

// Parse fps from avg_frame_rate string like "30/1" or "24000/1001"
function parseFps(fpsStr) {
  if (!fpsStr) return 30
  const parts = fpsStr.split('/')
  if (parts.length === 2) {
    const num = parseFloat(parts[0])
    const den = parseFloat(parts[1])
    if (den > 0) return num / den
  }
  return parseFloat(fpsStr) || 30
}

function progressUpdates(prog, targetSec) {
  const updates = {}
  if (prog.timeSec !== undefined) {
    updates.progress = Math.min(95, Math.round(10 + (prog.timeSec / targetSec) * 85))
  }
  if (prog.fps !== undefined) updates.fps = prog.fps
  if (prog.speed !== undefined && prog.timeSec !== undefined && prog.speed > 0) {
    updates.eta = Math.max(0, Math.round((targetSec - prog.timeSec) / prog.speed))
  }
  return updates
}

function parseAudioPathList(value) {
  if (!value) return []
  try {
    const parsed = JSON.parse(value)
    if (Array.isArray(parsed)) return parsed
  } catch { /* not a JSON path list */ }
  return [value]
}

function getAudioDurationFromMeta(metadata) {
  const audioStream = metadata.streams?.find(s => s.channels > 0)
  const duration = parseFloat(metadata.format?.duration || audioStream?.duration || 0)
  return { audioStream, duration }
}

async function runAudioMergeJob(job, notify, ffmpeg) {
  const inputPaths = parseAudioPathList(job.input_audio_path)
  if (inputPaths.length < 5) throw new Error('Audio merger requires at least 5 input files.')

  for (const audioPath of inputPaths) {
    if (!fs.existsSync(audioPath)) throw new Error(`Audio file not found: ${audioPath}`)
  }

  await appendLog(job.id, `Audio merge: ${inputPaths.length} tracks`)
  const durations = []
  for (let i = 0; i < inputPaths.length; i++) {
    const metadata = await probeFile(inputPaths[i])
    const { audioStream, duration } = getAudioDurationFromMeta(metadata)
    if (!audioStream || !duration || isNaN(duration) || duration <= 0) {
      throw new Error(`Could not detect a valid audio stream in track ${i + 1}.`)
    }
    durations.push(duration)
    await appendLog(job.id, `Track ${i + 1}: ${path.basename(inputPaths[i])} (${duration.toFixed(3)}s)`)
  }

  const totalDuration = durations.reduce((sum, value) => sum + value, 0)
  const safeBase = path.basename(job.filename || 'merged_audio', path.extname(job.filename || ''))
    .replace(/[<>:"/\\|?*]/g, '_')
  const outputPath = path.join(OUTPUTS_DIR, `${safeBase}_merged_${Date.now()}.mp3`)
  const inputArgs = inputPaths.flatMap(audioPath => ['-i', fp(audioPath)])
  const filterInputs = inputPaths.map((_, index) => `[${index}:a]`).join('')
  const filter = `${filterInputs}concat=n=${inputPaths.length}:v=0:a=1[outa]`

  await notify({ target_duration: totalDuration, encoder_used: 'libmp3lame 320kbps', progress: 5 })
  await appendLog(job.id, `Output duration: ${totalDuration.toFixed(3)}s. Merging sequentially with no inserted gaps.`)
  await notify({ status: 'processing', progress: 10 })

  try {
    await runCommand(ffmpeg, [
      ...inputArgs,
      '-filter_complex', filter,
      '-map', '[outa]',
      '-vn',
      '-c:a', 'libmp3lame',
      '-b:a', '320k',
      '-ar', '48000',
      '-id3v2_version', '3',
      '-write_xing', '1',
      '-y', fp(outputPath),
    ], job.id, prog => {
      const updates = progressUpdates(prog, totalDuration)
      if (Object.keys(updates).length) notify(updates)
    })
  } catch (err) {
    try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath) } catch { /* best-effort cleanup */ }
    throw err
  }

  if (!fs.existsSync(outputPath)) throw new Error('Merged audio output file was not created.')
  const outputSize = fs.statSync(outputPath).size
  await notify({
    status: 'completed', progress: 100, fps: 0, eta: 0,
    output_size: outputSize, output_path: outputPath,
  })
  await appendLog(job.id, `=== COMPLETE: ${path.basename(outputPath)} (${(outputSize / 1024 / 1024).toFixed(1)} MB) ===`)
}

async function runAudioLoopJob(job, notify, tempFiles, ffmpeg) {
  const inputPath = job.input_audio_path
  if (!inputPath || !fs.existsSync(inputPath)) throw new Error(`Audio file not found: ${inputPath}`)

  const targetDuration = Number(job.target_duration)
  if (!targetDuration || isNaN(targetDuration) || targetDuration <= 0) {
    throw new Error('Target duration must be greater than zero.')
  }

  await appendLog(job.id, `Audio loop: ${path.basename(inputPath)} → ${targetDuration}s`)
  const metadata = await probeFile(inputPath)
  const { audioStream, duration } = getAudioDurationFromMeta(metadata)
  if (!audioStream || !duration || isNaN(duration) || duration <= 0) {
    throw new Error('Could not detect a valid audio stream duration.')
  }

  const safeBase = path.basename(job.filename || 'looped_audio', path.extname(job.filename || ''))
    .replace(/[<>:"/\\|?*]/g, '_')
  const outputPath = path.join(OUTPUTS_DIR, `${safeBase}_audio_loop_${Date.now()}.mp3`)

  await notify({ target_duration: Math.ceil(targetDuration), encoder_used: 'libmp3lame 320kbps', progress: 5 })
  await appendLog(job.id, `Source duration: ${duration.toFixed(3)}s. Output duration: ${targetDuration.toFixed(3)}s.`)
  await notify({ status: 'processing', progress: 10 })

  try {
    if (targetDuration <= duration) {
      await appendLog(job.id, 'Target is shorter than source. Trimming to the exact target duration.')
      await runCommand(ffmpeg, [
        '-i', fp(inputPath),
        '-map', '0:a:0',
        '-vn',
        '-t', String(targetDuration),
        '-c:a', 'libmp3lame',
        '-b:a', '320k',
        '-ar', '48000',
        '-id3v2_version', '3',
        '-write_xing', '1',
        '-y', fp(outputPath),
      ], job.id, prog => {
        const updates = progressUpdates(prog, targetDuration)
        if (Object.keys(updates).length) notify(updates)
      })
    } else {
      const fadeDuration = Math.min(0.25, Math.max(0.001, duration / 4))
      const cyclePath = path.join(TEMP_DIR, `${job.id}_audio_cycle.wav`)
      tempFiles.push(cyclePath)
      const middleStart = fadeDuration
      const middleEnd = duration - fadeDuration
      const filter = [
        `[0:a]atrim=0:${fadeDuration.toFixed(6)},asetpts=PTS-STARTPTS[start]`,
        `[0:a]atrim=${middleStart.toFixed(6)}:${middleEnd.toFixed(6)},asetpts=PTS-STARTPTS[mid]`,
        `[0:a]atrim=${middleEnd.toFixed(6)}:${duration.toFixed(6)},asetpts=PTS-STARTPTS[end]`,
        `[end][start]acrossfade=d=${fadeDuration.toFixed(6)}:c1=tri:c2=tri[wrap]`,
        '[wrap][mid]concat=n=2:v=0:a=1[cycle]',
      ].join(';')

      await appendLog(job.id, `Building smooth cyclic audio bed with ${fadeDuration.toFixed(3)}s wrap crossfade.`)
      await runCommand(ffmpeg, [
        '-i', fp(inputPath),
        '-filter_complex', filter,
        '-map', '[cycle]',
        '-vn',
        '-c:a', 'pcm_s16le',
        '-ar', '48000',
        '-y', fp(cyclePath),
      ], job.id)

      if (!fs.existsSync(cyclePath)) throw new Error('Loop cycle audio file was not created.')
      await appendLog(job.id, 'Rendering exact duration from smooth cyclic bed.')
      await runCommand(ffmpeg, [
        '-stream_loop', '-1',
        '-i', fp(cyclePath),
        '-map', '0:a:0',
        '-vn',
        '-t', String(targetDuration),
        '-c:a', 'libmp3lame',
        '-b:a', '320k',
        '-ar', '48000',
        '-id3v2_version', '3',
        '-write_xing', '1',
        '-y', fp(outputPath),
      ], job.id, prog => {
        const updates = progressUpdates(prog, targetDuration)
        if (Object.keys(updates).length) notify(updates)
      })
    }
  } catch (err) {
    try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath) } catch { /* best-effort cleanup */ }
    throw err
  }

  if (!fs.existsSync(outputPath)) throw new Error('Looped audio output file was not created.')
  const outputSize = fs.statSync(outputPath).size
  await notify({
    status: 'completed', progress: 100, fps: 0, eta: 0,
    output_size: outputSize, output_path: outputPath,
  })
  await appendLog(job.id, `=== COMPLETE: ${path.basename(outputPath)} (${(outputSize / 1024 / 1024).toFixed(1)} MB) ===`)
}

async function runAudioVisualJob(job, notify, tempFiles, ffmpeg) {
  const visualPath = job.input_video_path
  const audioPath = job.input_audio_path
  if (!fs.existsSync(visualPath)) throw new Error(`Visual asset not found: ${visualPath}`)
  if (!audioPath || !fs.existsSync(audioPath)) throw new Error(`Audio track not found: ${audioPath}`)

  await appendLog(job.id, `Audio-visual render: ${job.visual_type} visual, ${job.animation_mode} mode`)
  const audioMeta = await probeFile(audioPath)
  const audioStream = audioMeta.streams?.find(s => s.channels > 0)
  const audioDuration = parseFloat(audioMeta.format?.duration || audioStream?.duration || 0)
  if (!audioStream || !audioDuration || isNaN(audioDuration) || audioDuration <= 0) {
    throw new Error('Could not detect a valid audio stream duration.')
  }

  let encoder
  try {
    encoder = await getBestEncoder(job.hw_accel)
  } catch (err) {
    await appendLog(job.id, `GPU encoder unavailable: ${err.message}. Falling back to libx264.`)
    encoder = 'libx264'
  }
  await notify({ target_duration: Math.ceil(audioDuration), encoder_used: encoder, progress: 5 })
  await appendLog(job.id, `Audio duration: ${audioDuration.toFixed(3)}s. Output will match it exactly.`)

  const safeBase = path.basename(job.filename, path.extname(job.filename))
    .replace(/[<>:"/\\|?*]/g, '_')
  const outputPath = path.join(OUTPUTS_DIR, `${safeBase}_audio_visual_${Date.now()}.mp4`)
  const finalArgs = []

  if (job.visual_type === 'image') {
    const imageFilters = {
      still: 'scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:black,format=yuv420p',
      loop: "scale=7680:-1,zoompan=z='1.08':x='iw/2-(iw/zoom/2)+(iw-iw/zoom)/2*sin(2*PI*on/(30*8))':y='ih/2-(ih/zoom/2)+(ih-ih/zoom)/2*cos(2*PI*on/(30*8))':d=1:s=1920x1080:fps=30,format=yuv420p",
      pingpong: "scale=7680:-1,zoompan=z='1.04+0.04*(1-cos(2*PI*on/(30*8)))/2':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=1920x1080:fps=30,format=yuv420p",
    }
    finalArgs.push(
      '-loop', '1', '-framerate', '30', '-i', fp(visualPath),
      '-i', fp(audioPath),
      '-vf', imageFilters[job.animation_mode] || imageFilters.loop,
      '-map', '0:v', '-map', '1:a',
    )
  } else {
    let sourcePath = visualPath
    if (job.animation_mode === 'pingpong') {
      const visualMeta = await probeFile(visualPath)
      const vStream = visualMeta.streams?.find(s => s.width > 0 && s.codec_name)
      const videoDuration = parseFloat(visualMeta.format?.duration)
      if (!vStream || !videoDuration || videoDuration <= 0) throw new Error('Could not detect a valid visual video stream.')
      const fps = parseFps(vStream.avg_frame_rate)
      const frameDuration = 1 / fps
      if (videoDuration <= frameDuration * 2) throw new Error('Visual video is too short for ping-pong mode.')
      const pingPongPath = path.join(TEMP_DIR, `${job.id}_av_pp.mp4`)
      tempFiles.push(pingPongPath)
      const trimEnd = videoDuration - frameDuration
      const filter = [
        `[0:v]fps=${fps.toFixed(6)},split=2[fw][bwsrc]`,
        `[bwsrc]trim=start=${frameDuration.toFixed(6)}:end=${trimEnd.toFixed(6)},setpts=PTS-STARTPTS,reverse[bw]`,
        '[fw][bw]concat=n=2:v=1:a=0[out]',
      ].join(';')
      await appendLog(job.id, 'Building seamless ping-pong visual cycle.')
      await runCommand(ffmpeg, [
        '-i', fp(visualPath), '-filter_complex', filter, '-map', '[out]', '-an',
        '-c:v', 'libx264', ...encoderQualityArgs('libx264'), '-pix_fmt', 'yuv420p', '-y', fp(pingPongPath),
      ], job.id)
      sourcePath = pingPongPath
    }
    finalArgs.push(
      '-stream_loop', '-1', '-i', fp(sourcePath),
      '-i', fp(audioPath),
      '-map', '0:v', '-map', '1:a',
    )
  }

  await notify({ status: 'processing', progress: 10 })
  await appendLog(job.id, 'Rendering visual track to the full audio duration.')
  const render = selectedEncoder => runCommand(ffmpeg, [
    ...finalArgs,
    '-c:v', selectedEncoder, ...encoderQualityArgs(selectedEncoder),
    '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000',
    '-t', String(audioDuration), '-movflags', '+faststart', '-y', fp(outputPath),
  ], job.id, prog => {
    const updates = progressUpdates(prog, audioDuration)
    if (Object.keys(updates).length) notify(updates)
  })
  try {
    await render(encoder)
  } catch (err) {
    if (encoder === 'libx264') throw err
    try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath) } catch { /* best-effort cleanup */ }
    encoder = 'libx264'
    await notify({ encoder_used: encoder, progress: 10 })
    await appendLog(job.id, `Hardware render failed: ${err.message}. Retrying with libx264.`)
    await render(encoder)
  }
  if (!fs.existsSync(outputPath)) throw new Error('Audio-visual output file was not created.')

  const outputSize = fs.statSync(outputPath).size
  await notify({
    status: 'completed', progress: 100, fps: 0, eta: 0,
    output_size: outputSize, output_path: outputPath,
  })
  await appendLog(job.id, `=== COMPLETE: ${path.basename(outputPath)} (${(outputSize / 1024 / 1024).toFixed(1)} MB) ===`)
}

async function runMp4ToMp3Job(job, notify, ffmpeg) {
  const inputPath = job.input_video_path
  if (!fs.existsSync(inputPath)) throw new Error(`Input MP4 file not found: ${inputPath}`)

  await appendLog(job.id, `MP4 to MP3 extraction: ${path.basename(inputPath)}`)
  const metadata = await probeFile(inputPath)
  const audioStream = metadata.streams?.find(s => s.channels > 0)
  const duration = parseFloat(metadata.format?.duration || audioStream?.duration || 0)
  if (!audioStream) throw new Error('The uploaded MP4 does not contain an audio stream.')
  if (!duration || isNaN(duration) || duration <= 0) throw new Error('Could not detect a valid audio duration.')

  const safeBase = path.basename(job.filename, path.extname(job.filename))
    .replace(/[<>:"/\\|?*]/g, '_')
  const outputPath = path.join(OUTPUTS_DIR, `${safeBase}_320kbps_${Date.now()}.mp3`)

  await notify({ target_duration: Math.ceil(duration), encoder_used: 'libmp3lame 320kbps', progress: 5 })
  await appendLog(job.id, `Audio duration: ${duration.toFixed(3)}s. Encoding constant bitrate MP3 at 320kbps.`)
  await notify({ status: 'processing', progress: 10 })

  try {
    await runCommand(ffmpeg, [
      '-i', fp(inputPath),
      '-map', '0:a:0',
      '-vn',
      '-c:a', 'libmp3lame',
      '-b:a', '320k',
      '-id3v2_version', '3',
      '-write_xing', '1',
      '-y', fp(outputPath),
    ], job.id, prog => {
      const updates = progressUpdates(prog, duration)
      if (Object.keys(updates).length) notify(updates)
    })
  } catch (err) {
    try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath) } catch { /* best-effort cleanup */ }
    throw err
  }

  if (!fs.existsSync(outputPath)) throw new Error('MP3 output file was not created.')
  const outputSize = fs.statSync(outputPath).size
  await notify({
    status: 'completed', progress: 100, fps: 0, eta: 0,
    output_size: outputSize, output_path: outputPath,
  })
  await appendLog(job.id, `=== COMPLETE: ${path.basename(outputPath)} (${(outputSize / 1024 / 1024).toFixed(1)} MB) ===`)
}

// Audio fade duration lookup
const AUDIO_FADE_SECONDS = { off: 0.01, short: 0.1, medium: 0.3, long: 0.5 }

async function runRenderJob(job) {
  const id = job.id
  console.log(`[worker] Starting job: ${id}`)

  let notifyQueue = Promise.resolve()
  let lastProgressNotifyAt = 0
  let lastProgressValue = null
  const notify = (updates) => {
    const keys = Object.keys(updates)
    const progressOnly = keys.length > 0 && keys.every(key => ['progress', 'fps', 'eta'].includes(key))
    if (progressOnly) {
      const now = Date.now()
      const nextProgress = updates.progress ?? lastProgressValue
      const progressDelta = nextProgress === null || lastProgressValue === null
        ? Infinity
        : Math.abs(nextProgress - lastProgressValue)
      if (now - lastProgressNotifyAt < 750 && progressDelta < 2) {
        return notifyQueue
      }
      lastProgressNotifyAt = now
      lastProgressValue = nextProgress
    }

    notifyQueue = notifyQueue.then(async () => {
      await updateJob(id, updates)
      if (onUpdateCallback) onUpdateCallback(id)
    })
    return notifyQueue
  }

  await notify({ status: 'preparing', progress: 2 })
  await appendLog(id, `=== Starting render job: ${job.filename} ===`)

  const tempFiles = []
  const ffmpeg = getFfmpegPath()

  // ── Parse reverse/loop settings ─────────────────────────────────────────────
  const reverseMode = job.reverse_mode || 'disabled'
  const loopStyle   = job.loop_style   || 'standard'
  const audioFade   = job.audio_fade   || 'off'
  const audioFadeSec = AUDIO_FADE_SECONDS[audioFade] ?? 0.01

  const isPingPong   = loopStyle === 'pingpong'
  const isReverseLoop = loopStyle === 'reverse'

  // For simple reverse loops: both streams are reversed (it's the definition of "play backwards")
  // For ping-pong: video always bounces; audio bounces unless reverseMode='video'
  const reverseVideoFlag = !isPingPong && (isReverseLoop || reverseMode === 'video' || reverseMode === 'both')
  const reverseAudioFlag = !isPingPong && (isReverseLoop || reverseMode === 'audio' || reverseMode === 'both')
  const audioPingPong    = isPingPong && reverseMode !== 'video'

  await appendLog(id, `Settings: reverseMode=${reverseMode} loopStyle=${loopStyle} audioFade=${audioFade}`)

  try {
    if (job.job_type === 'audio_visual') {
      await runAudioVisualJob(job, notify, tempFiles, ffmpeg)
      return
    }
    if (job.job_type === 'mp4_to_mp3') {
      await runMp4ToMp3Job(job, notify, ffmpeg)
      return
    }
    if (job.job_type === 'audio_merge') {
      await runAudioMergeJob(job, notify, ffmpeg)
      return
    }
    if (job.job_type === 'audio_loop') {
      await runAudioLoopJob(job, notify, tempFiles, ffmpeg)
      return
    }

    // ── 1. Validate & probe input video ────────────────────────────────────────
    if (!fs.existsSync(job.input_video_path)) {
      throw new Error(`Input video not found: ${job.input_video_path}`)
    }

    await appendLog(id, `Probing video: ${path.basename(job.input_video_path)}`)
    const vMeta = await probeFile(job.input_video_path)

    const vStream = vMeta.streams?.find(s => s.width > 0 && s.codec_name)
    if (!vStream) throw new Error('No valid video stream found in uploaded file.')

    const videoDuration = parseFloat(vMeta.format?.duration)
    if (!videoDuration || isNaN(videoDuration) || videoDuration <= 0) {
      throw new Error('Could not detect video duration. File may be corrupted or unsupported.')
    }

    const fps = parseFps(vStream.avg_frame_rate)
    if (fps <= 0 || isNaN(fps)) throw new Error('Could not determine video frame rate.')

    const frameDuration = 1.0 / fps
    const resolution = `${vStream.width}x${vStream.height}`
    const hasEmbeddedAudio = vMeta.streams?.some(s => s.channels > 0)

    await appendLog(id, `Video: ${resolution}, ${videoDuration.toFixed(3)}s @ ${fps.toFixed(3)} fps`)
    await appendLog(id, `Mode: reverseVideo=${reverseVideoFlag} reverseAudio=${reverseAudioFlag} pingPong=${isPingPong} audioPP=${audioPingPong}`)
    await notify({ resolution })

    // ── 2. Audio source selection ───────────────────────────────────────────────
    let audioPath = null
    let audioDuration = 0
    let hasAudio = false
    let isExternalAudio = false

    if (job.input_audio_path && fs.existsSync(job.input_audio_path)) {
      audioPath = job.input_audio_path
      hasAudio = true
      isExternalAudio = true
      await appendLog(id, `Using separate audio: ${path.basename(audioPath)}`)
      const aMeta = await probeFile(audioPath)
      const aStream = aMeta.streams?.find(s => s.channels > 0)
      audioDuration = parseFloat(aMeta.format?.duration || aStream?.duration || 0)
      if (!audioDuration || isNaN(audioDuration) || audioDuration <= 0) {
        throw new Error('Could not detect audio duration from separate audio file.')
      }
    } else if (hasEmbeddedAudio) {
      audioPath = job.input_video_path
      audioDuration = videoDuration
      hasAudio = true
      isExternalAudio = false
      await appendLog(id, 'Using embedded audio from video.')
    } else {
      await appendLog(id, 'No audio source. Rendering video only.')
    }

    const targetSec = job.target_duration

    // ── 3. Encoder selection ────────────────────────────────────────────────────
    let encoder
    try {
      encoder = await getBestEncoder(job.hw_accel)
    } catch (err) {
      await appendLog(id, `GPU encoder unavailable: ${err.message}. Falling back to libx264.`)
      encoder = 'libx264'
    }
    await notify({ encoder_used: encoder, progress: 5 })
    await appendLog(id, `Encoder: ${encoder} (mode: ${job.hw_accel})`)

    // For intermediate files (reverse/ping-pong cycles), use libx264 in 'auto' mode.
    // GPU encoders require CUDA/NVENC drivers at runtime which may be absent even when
    // FFmpeg reports them as compiled-in. libx264 is always reliable for temp files.
    // In 'gpu' mode the user explicitly wants GPU — respect that and fail loudly if broken.
    const intermediateEncoder = (job.hw_accel === 'gpu') ? encoder : 'libx264'
    await appendLog(id, `Intermediate encoder: ${intermediateEncoder}`)

    // ── 4. Video track preparation ──────────────────────────────────────────────
    let videoSrcPath = job.input_video_path
    let videoCycleDuration = videoDuration
    let videoPreEncoded = false  // true when video is already encoded in an intermediate

    if (isPingPong) {
      // Validate clip is long enough
      if (videoDuration <= frameDuration * 2) {
        throw new Error('Video is too short for ping-pong mode. Clip must be at least 2 frames long.')
      }

      await appendLog(id, 'Ping-pong: building forward+backward video cycle…')

      // Backward segment trims one frame from each end to avoid duplicating boundary frames
      const bwTrimStart = frameDuration
      const bwTrimEnd   = videoDuration - frameDuration
      await appendLog(id, `Backward trim: ${bwTrimStart.toFixed(6)}s – ${bwTrimEnd.toFixed(6)}s`)

      const cycleVideoPath = path.join(TEMP_DIR, `${id}_pp_vid.mp4`)
      tempFiles.push(cycleVideoPath)

      // fps normalizes VFR→CFR; split avoids double-referencing the same stream
      // [0:v] → fps → split → [fwv] (forward) + [bwv_src] → trim+reverse → [bwv]
      const vComplex = [
        `[0:v]fps=${fps.toFixed(6)},split=2[fwv][bwv_src]`,
        `[bwv_src]trim=start=${bwTrimStart.toFixed(6)}:end=${bwTrimEnd.toFixed(6)},setpts=PTS-STARTPTS,reverse[bwv]`,
        `[fwv][bwv]concat=n=2:v=1:a=0[ov]`,
      ].join(';')

      const cycleArgs = [
        '-i', fp(job.input_video_path),
        '-filter_complex', vComplex,
        '-map', '[ov]',
        '-an',
        '-c:v', intermediateEncoder,
        ...encoderQualityArgs(intermediateEncoder),
        '-y', fp(cycleVideoPath),
      ]

      await appendLog(id, 'Encoding ping-pong video cycle…')
      await runCommand(ffmpeg, cycleArgs, id)

      if (!fs.existsSync(cycleVideoPath)) {
        throw new Error('Ping-pong video cycle was not created. FFmpeg may have failed.')
      }

      // Probe cycle for exact duration
      const cycleMeta = await probeFile(cycleVideoPath)
      videoCycleDuration = parseFloat(cycleMeta.format?.duration)
      if (!videoCycleDuration || isNaN(videoCycleDuration) || videoCycleDuration <= 0) {
        // Estimate: forward + backward durations
        videoCycleDuration = videoDuration + (bwTrimEnd - bwTrimStart)
      }

      videoSrcPath = cycleVideoPath
      videoPreEncoded = true
      await appendLog(id, `Ping-pong video cycle ready: ${videoCycleDuration.toFixed(3)}s`)

    } else if (reverseVideoFlag) {
      await appendLog(id, 'Reverse: creating reversed video…')

      const revVideoPath = path.join(TEMP_DIR, `${id}_rev_vid.mp4`)
      tempFiles.push(revVideoPath)

      const revArgs = [
        '-i', fp(job.input_video_path),
        '-vf', `fps=${fps.toFixed(6)},reverse`,
        '-an',
        '-c:v', intermediateEncoder,
        ...encoderQualityArgs(intermediateEncoder),
        '-y', fp(revVideoPath),
      ]

      await runCommand(ffmpeg, revArgs, id)

      if (!fs.existsSync(revVideoPath)) {
        throw new Error('Reversed video was not created. FFmpeg may have failed.')
      }

      videoSrcPath = revVideoPath
      videoPreEncoded = true
      await appendLog(id, 'Reversed video ready.')
    }

    // ── 5. Video concat list ────────────────────────────────────────────────────
    const videoLoops = Math.ceil(targetSec / videoCycleDuration)
    await appendLog(id, `Video: ${videoCycleDuration.toFixed(3)}s/cycle × ${videoLoops} loops → ≥${targetSec}s`)

    const videoConcatPath = path.join(TEMP_DIR, `${id}_video.txt`)
    fs.writeFileSync(videoConcatPath, buildConcatList(videoSrcPath, videoLoops), 'utf8')
    tempFiles.push(videoConcatPath)

    // ── 6. Audio track preparation ──────────────────────────────────────────────
    const crossfade = job.crossfade || 0
    let audioInputArgs = []
    let audioMapArgs   = []
    let audioPreEncoded = false

    if (hasAudio) {
      // Audio source to use as the loop base
      let audioSrcPath = audioPath
      let audioCycleDuration = audioDuration

      const audioSourceFile = isExternalAudio ? audioPath : job.input_video_path

      if (isPingPong && audioPingPong) {
        // Audio ping-pong: build forward+backward audio cycle
        await appendLog(id, 'Audio ping-pong: building audio cycle…')

        // For audio boundaries, use a tiny epsilon to prevent clicking
        const audioEpsilon = Math.min(audioFadeSec, audioDuration * 0.01, 0.05)
        const aTrimStart = audioEpsilon
        const aTrimEnd   = audioDuration - audioEpsilon
        const aBwDuration = aTrimEnd - aTrimStart

        if (aBwDuration <= 0) {
          await appendLog(id, 'Audio too short for ping-pong, falling back to forward audio loop.')
        } else {
          const cycleAudioPath = path.join(TEMP_DIR, `${id}_pp_aud.aac`)
          tempFiles.push(cycleAudioPath)

          // Forward audio: apply subtle fade to smooth loop boundary
          const fwFadeOut = Math.max(0, audioDuration - audioFadeSec)
          const fwAFilter = `afade=t=in:st=0:d=${audioFadeSec},afade=t=out:st=${fwFadeOut.toFixed(6)}:d=${audioFadeSec}`
          // Backward audio: trim, reverse, fade
          const bwAFilter = [
            `atrim=start=${aTrimStart.toFixed(6)}:end=${aTrimEnd.toFixed(6)}`,
            'asetpts=PTS-STARTPTS',
            'areverse',
            `afade=t=in:st=0:d=${audioFadeSec}`,
            `afade=t=out:st=${Math.max(0, aBwDuration - audioFadeSec).toFixed(6)}:d=${audioFadeSec}`,
          ].join(',')

          // asplit avoids double-referencing [0:a]
          const aComplex = [
            `[0:a]asplit=2[fwa_src][bwa_src]`,
            `[fwa_src]${fwAFilter}[fwa]`,
            `[bwa_src]${bwAFilter}[bwa]`,
            `[fwa][bwa]concat=n=2:v=0:a=1[oa]`,
          ].join(';')

          const cycleAudioArgs = [
            '-i', fp(audioSourceFile),
            '-filter_complex', aComplex,
            '-map', '[oa]',
            '-vn', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000',
            '-y', fp(cycleAudioPath),
          ]

          await runCommand(ffmpeg, cycleAudioArgs, id)

          if (fs.existsSync(cycleAudioPath)) {
            const meta = await probeFile(cycleAudioPath)
            audioCycleDuration = parseFloat(meta.format?.duration) || (audioDuration + aBwDuration)
            audioSrcPath = cycleAudioPath
            audioPreEncoded = true
            await appendLog(id, `Audio ping-pong cycle ready: ${audioCycleDuration.toFixed(3)}s`)
          }
        }

      } else if (!isPingPong && reverseAudioFlag) {
        // Simple audio reversal (no ping-pong)
        await appendLog(id, 'Reverse: creating reversed audio…')

        const revAudioPath = path.join(TEMP_DIR, `${id}_rev_aud.aac`)
        tempFiles.push(revAudioPath)

        const revAudioArgs = [
          '-i', fp(audioSourceFile),
          '-af', 'areverse',
          '-vn', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000',
          '-y', fp(revAudioPath),
        ]

        await runCommand(ffmpeg, revAudioArgs, id)

        if (!fs.existsSync(revAudioPath)) {
          throw new Error('Reversed audio was not created. FFmpeg may have failed.')
        }
        audioSrcPath = revAudioPath
        audioPreEncoded = true
        await appendLog(id, 'Reversed audio ready.')
      }

      // Build audio concat or crossfade
      const audioLoops = Math.ceil(targetSec / audioCycleDuration)
      await appendLog(id, `Audio: ${audioCycleDuration.toFixed(3)}s/cycle × ${audioLoops} loops`)

      if (crossfade === 0 || audioPreEncoded) {
        // Fast path: simple concat (no crossfade, or audio already pre-encoded)
        const audioConcatPath = path.join(TEMP_DIR, `${id}_audio.txt`)
        fs.writeFileSync(audioConcatPath, buildConcatList(audioSrcPath, audioLoops), 'utf8')
        tempFiles.push(audioConcatPath)
        audioInputArgs = ['-f', 'concat', '-safe', '0', '-i', fp(audioConcatPath)]
        audioMapArgs   = ['-map', '1:a']
        await appendLog(id, 'Audio concat list written.')
      } else {
        // Crossfade path (only for non-reversed forward audio)
        await appendLog(id, `Crossfade enabled (${crossfade}s). Building crossfaded audio…`)

        const netPerLoop = Math.max(0.1, audioCycleDuration - crossfade)
        const preloopTarget = Math.min(targetSec, 600)
        const numLoops = Math.max(2, Math.ceil(preloopTarget / netPerLoop))

        const iArgs = []
        for (let i = 0; i < numLoops; i++) iArgs.push('-i', fp(audioSrcPath))

        let filterStr = `[0:a][1:a]acrossfade=d=${crossfade}:c1=tri:c2=tri[af1]`
        for (let i = 2; i < numLoops; i++) {
          filterStr += `;[af${i - 1}][${i}:a]acrossfade=d=${crossfade}:c1=tri:c2=tri[af${i}]`
        }
        const lastLabel = `[af${numLoops - 1}]`

        const intermediateAudioPath = path.join(TEMP_DIR, `${id}_xfade.wav`)
        tempFiles.push(intermediateAudioPath)

        await runCommand(ffmpeg, [...iArgs, '-filter_complex', filterStr, '-map', lastLabel, '-y', fp(intermediateAudioPath)], id)

        const intMeta = await probeFile(intermediateAudioPath)
        const intDur = parseFloat(intMeta.format?.duration || preloopTarget)
        const finalLoops = Math.ceil(targetSec / intDur)

        const finalAudioConcat = path.join(TEMP_DIR, `${id}_audio_final.txt`)
        fs.writeFileSync(finalAudioConcat, buildConcatList(intermediateAudioPath, finalLoops), 'utf8')
        tempFiles.push(finalAudioConcat)

        audioInputArgs = ['-f', 'concat', '-safe', '0', '-i', fp(finalAudioConcat)]
        audioMapArgs   = ['-map', '1:a']
        await appendLog(id, `Crossfaded audio ready (${finalLoops} tile loops)`)
      }
    }

    // ── 7. Build final FFmpeg command ───────────────────────────────────────────
    const ext = path.extname(job.input_video_path).toLowerCase() || '.mp4'
    const safeBase = path.basename(job.filename, path.extname(job.filename))
      .replace(/[<>:"/\\|?*]/g, '_')
    const outFilename = `${safeBase}_looped_${Date.now()}${ext}`
    const outputPath  = path.join(OUTPUTS_DIR, outFilename)

    const finalArgs = [
      '-f', 'concat', '-safe', '0', '-i', fp(videoConcatPath),
      ...audioInputArgs,
      '-map', '0:v',
      ...audioMapArgs,
    ]

    // Video codec selection
    if (videoPreEncoded) {
      // Video already encoded in a reverse/ping-pong intermediate step → stream copy
      finalArgs.push('-c:v', 'copy')
      await appendLog(id, 'Using -c:v copy (video pre-encoded in intermediate step)')
    } else if (job.hw_accel === 'auto') {
      finalArgs.push('-c:v', 'copy')
      await appendLog(id, 'Using -c:v copy (lossless bitstream, fastest)')
    } else {
      finalArgs.push('-c:v', encoder, ...encoderQualityArgs(encoder))
      await appendLog(id, `Re-encoding with ${encoder}`)
    }

    // Audio codec selection
    if (hasAudio) {
      if (audioPreEncoded) {
        finalArgs.push('-c:a', 'copy')
      } else {
        finalArgs.push('-c:a', 'aac', '-b:a', '192k', '-ar', '48000')
      }
    }

    finalArgs.push('-t', String(targetSec), '-movflags', '+faststart', '-y', fp(outputPath))

    await notify({ status: 'processing', progress: 10 })
    await appendLog(id, 'Starting final render…')

    await runCommand(ffmpeg, finalArgs, id, (prog) => {
      const updates = progressUpdates(prog, targetSec)
      if (Object.keys(updates).length) notify(updates)
    })

    // ── 8. Finalize ─────────────────────────────────────────────────────────────
    await notify({ status: 'finalizing', progress: 97 })
    await appendLog(id, 'Render complete. Collecting output metadata…')

    if (!fs.existsSync(outputPath)) {
      throw new Error('Output file was not created. FFmpeg may have failed silently.')
    }

    const outputSize = fs.statSync(outputPath).size

    await notify({
      status: 'completed',
      progress: 100,
      fps: 0,
      eta: 0,
      output_size: outputSize,
      output_path: outputPath,
    })
    await appendLog(id, `=== COMPLETE: ${outFilename} (${(outputSize / 1024 / 1024).toFixed(1)} MB) ===`)

  } catch (err) {
    console.error(`[worker] Job ${id} failed:`, err.message)
    if (cancelledByUser) {
      await notify({ status: 'cancelled', progress: 0, fps: 0, eta: 0 })
      await appendLog(id, 'Job cancelled by user.')
    } else {
      await notify({ status: 'failed', progress: 0, fps: 0, eta: 0, error_message: err.message })
      await appendLog(id, `FAILED: ${err.message}`)
    }
  } finally {
    for (const f of tempFiles) {
      try { if (fs.existsSync(f)) fs.unlinkSync(f) } catch { /* ignore */ }
    }
    currentJobId = null
    currentProcess = null
    cancelledByUser = false
  }
}

function runCommand(cmd, args, jobId, onProgress) {
  return new Promise((resolve, reject) => {
    appendLog(jobId, `$ ${cmd} ${args.map(a => (a.includes(' ') || a.includes(',')) ? `"${a}"` : a).join(' ')}`)

    const proc = spawn(cmd, args)
    currentProcess = proc

    let stdoutBuf = ''
    let stderrBuf = ''

    proc.stdout.on('data', d => {
      stdoutBuf += d.toString()
      const lines = stdoutBuf.split('\n')
      stdoutBuf = lines.pop()
      for (const l of lines) if (l.trim()) appendLog(jobId, `[out] ${l.trim()}`)
    })

    proc.stderr.on('data', d => {
      const chunk = d.toString()
      stderrBuf += chunk

      if (onProgress) {
        const timeMatch  = stderrBuf.match(/time=(\d+):(\d+):([\d.]+)/)
        const fpsMatch   = stderrBuf.match(/fps=\s*([\d.]+)/)
        const speedMatch = stderrBuf.match(/speed=\s*([\d.]+)x/)

        if (timeMatch || fpsMatch || speedMatch) {
          const prog = {}
          if (timeMatch) {
            prog.timeSec = parseInt(timeMatch[1]) * 3600 + parseInt(timeMatch[2]) * 60 + parseFloat(timeMatch[3])
          }
          if (fpsMatch)   prog.fps   = Math.round(parseFloat(fpsMatch[1]))
          if (speedMatch) prog.speed = parseFloat(speedMatch[1])
          onProgress(prog)
        }
      }

      const lines = stderrBuf.split(/[\n\r]/)
      stderrBuf = lines.pop()
      for (const l of lines) if (l.trim()) appendLog(jobId, `[ff] ${l.trim()}`)
    })

    proc.on('error', err => reject(new Error(`Failed to start FFmpeg: ${err.message}`)))

    proc.on('close', code => {
      if (stdoutBuf.trim()) appendLog(jobId, `[out] ${stdoutBuf.trim()}`)
      if (stderrBuf.trim()) appendLog(jobId, `[ff] ${stderrBuf.trim()}`)
      if (code === 0) resolve()
      else reject(new Error(`FFmpeg exited with code ${code}`))
    })
  })
}
