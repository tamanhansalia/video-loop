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

// Audio fade duration lookup
const AUDIO_FADE_SECONDS = { off: 0.01, short: 0.1, medium: 0.3, long: 0.5 }

async function runRenderJob(job) {
  const id = job.id
  console.log(`[worker] Starting job: ${id}`)

  const notify = async (updates) => {
    await updateJob(id, updates)
    if (onUpdateCallback) onUpdateCallback(id)
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
      const updates = {}
      if (prog.timeSec !== undefined) {
        updates.progress = Math.min(95, Math.round(10 + (prog.timeSec / targetSec) * 85))
      }
      if (prog.fps !== undefined) updates.fps = prog.fps
      if (prog.speed !== undefined && prog.timeSec !== undefined) {
        const remaining = targetSec - prog.timeSec
        if (prog.speed > 0) updates.eta = Math.max(0, Math.round(remaining / prog.speed))
      }
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
