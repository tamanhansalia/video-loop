import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export const LIVE_STUDIO_DIR = path.join(__dirname, '../data/live-studio')
export const LIVE_ASSETS_DIR = path.join(LIVE_STUDIO_DIR, 'assets')
const LIVE_STATE_PATH = path.join(LIVE_STUDIO_DIR, 'state.json')

for (const dir of [LIVE_STUDIO_DIR, LIVE_ASSETS_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}

function makeId(prefix) {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function defaultState() {
  return {
    revision: 0,
    updatedAt: null,
    backgroundVideo: null,
    queue: [],
    playback: {
      currentTrackId: null,
      currentTrackStartedAt: null,
    },
  }
}

function deleteFileSafe(filePath) {
  if (!filePath) return
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath)
  } catch {
    // Ignore best-effort cleanup failures.
  }
}

function loadStateFromDisk() {
  try {
    if (!fs.existsSync(LIVE_STATE_PATH)) {
      const initial = defaultState()
      fs.writeFileSync(LIVE_STATE_PATH, JSON.stringify(initial, null, 2), 'utf8')
      return initial
    }

    const raw = fs.readFileSync(LIVE_STATE_PATH, 'utf8')
    const parsed = JSON.parse(raw)
    return {
      ...defaultState(),
      ...parsed,
      playback: {
        ...defaultState().playback,
        ...(parsed.playback || {}),
      },
      queue: Array.isArray(parsed.queue) ? parsed.queue : [],
    }
  } catch {
    return defaultState()
  }
}

let stateCache = loadStateFromDisk()

function saveState(nextState) {
  const state = {
    ...defaultState(),
    ...nextState,
    updatedAt: new Date().toISOString(),
    playback: {
      ...defaultState().playback,
      ...(nextState.playback || {}),
    },
    queue: Array.isArray(nextState.queue) ? nextState.queue : [],
  }

  stateCache = state
  fs.writeFileSync(LIVE_STATE_PATH, JSON.stringify(state, null, 2), 'utf8')
  return state
}

function sanitizeMissingAssets(state) {
  const next = clone(state)

  if (next.backgroundVideo?.storedPath && !fs.existsSync(next.backgroundVideo.storedPath)) {
    next.backgroundVideo = null
  }

  next.queue = next.queue.filter(track => track?.storedPath && fs.existsSync(track.storedPath))

  return next
}

function normalizeState(inputState) {
  const state = sanitizeMissingAssets(inputState)
  const now = Date.now()

  if (!state.queue.length) {
    state.playback.currentTrackId = null
    state.playback.currentTrackStartedAt = null
    return state
  }

  let currentIndex = state.queue.findIndex(track => track.id === state.playback.currentTrackId)
  let currentStartedAtMs = Date.parse(state.playback.currentTrackStartedAt || '')

  if (currentIndex === -1) currentIndex = 0
  if (!Number.isFinite(currentStartedAtMs)) currentStartedAtMs = now

  let elapsedSeconds = Math.max(0, (now - currentStartedAtMs) / 1000)
  let guard = 0

  while (state.queue.length && guard < 10000) {
    const currentTrack = state.queue[currentIndex]
    const duration = Number(currentTrack?.durationSec || 0)
    if (!duration || elapsedSeconds < duration) break
    elapsedSeconds -= duration
    currentIndex = (currentIndex + 1) % state.queue.length
    guard += 1
  }

  state.playback.currentTrackId = state.queue[currentIndex]?.id || null
  state.playback.currentTrackStartedAt = new Date(now - (elapsedSeconds * 1000)).toISOString()
  return state
}

function persistNormalizedState() {
  const normalized = normalizeState(stateCache)
  const before = JSON.stringify(stateCache)
  const after = JSON.stringify(normalized)
  if (before !== after) {
    return saveState(normalized)
  }
  stateCache = normalized
  return normalized
}

function buildPublicVideo(video) {
  if (!video) return null
  return {
    id: video.id,
    filename: video.filename,
    publicPath: video.publicPath,
    durationSec: video.durationSec,
    sizeBytes: video.sizeBytes,
    uploadedAt: video.uploadedAt,
  }
}

function buildPublicTrack(track) {
  return {
    id: track.id,
    filename: track.filename,
    publicPath: track.publicPath,
    durationSec: track.durationSec,
    sizeBytes: track.sizeBytes,
    uploadedAt: track.uploadedAt,
  }
}

export function getLiveStudioState() {
  return persistNormalizedState()
}

export function getLiveStudioPublicState() {
  const state = getLiveStudioState()
  const currentTrackIndex = state.queue.findIndex(track => track.id === state.playback.currentTrackId)
  const currentTrack = currentTrackIndex >= 0 ? state.queue[currentTrackIndex] : null
  const elapsedInTrack = currentTrack && state.playback.currentTrackStartedAt
    ? Math.max(0, (Date.now() - Date.parse(state.playback.currentTrackStartedAt)) / 1000)
    : 0

  return {
    revision: state.revision,
    updatedAt: state.updatedAt,
    backgroundVideo: buildPublicVideo(state.backgroundVideo),
    queue: state.queue.map(buildPublicTrack),
    currentTrack: currentTrack ? buildPublicTrack(currentTrack) : null,
    currentTrackIndex,
    currentTrackStartedAt: state.playback.currentTrackStartedAt,
    elapsedInTrack: currentTrack ? Math.min(elapsedInTrack, currentTrack.durationSec) : 0,
    queueTotalDuration: state.queue.reduce((sum, track) => sum + Number(track.durationSec || 0), 0),
  }
}

function commit(mutator) {
  const state = getLiveStudioState()
  mutator(state)
  state.revision = Number(state.revision || 0) + 1
  return saveState(normalizeState(state))
}

export function setLiveStudioVideo(file, durationSec) {
  return commit(state => {
    state.backgroundVideo = {
      id: makeId('video'),
      filename: file.originalname,
      storedPath: file.path,
      publicPath: `/live-assets/${path.basename(file.path)}`,
      durationSec,
      sizeBytes: file.size,
      uploadedAt: new Date().toISOString(),
    }
  })
}

export function clearLiveStudioVideo() {
  const state = getLiveStudioState()
  const currentPath = state.backgroundVideo?.storedPath || null
  const next = commit(draft => {
    draft.backgroundVideo = null
  })
  deleteFileSafe(currentPath)
  return next
}

export function addLiveStudioTracks(files) {
  return commit(state => {
    const wasEmpty = state.queue.length === 0
    const tracks = files.map(file => ({
      id: makeId('track'),
      filename: file.originalname,
      storedPath: file.path,
      publicPath: `/live-assets/${path.basename(file.path)}`,
      durationSec: file.durationSec,
      sizeBytes: file.size,
      uploadedAt: new Date().toISOString(),
    }))

    state.queue.push(...tracks)

    if (wasEmpty && state.queue.length > 0) {
      state.playback.currentTrackId = state.queue[0].id
      state.playback.currentTrackStartedAt = new Date().toISOString()
    }
  })
}

export function moveLiveStudioTrack(trackId, direction) {
  return commit(state => {
    const index = state.queue.findIndex(track => track.id === trackId)
    if (index === -1) return

    const targetIndex = direction === 'up'
      ? Math.max(0, index - 1)
      : Math.min(state.queue.length - 1, index + 1)

    if (targetIndex === index) return

    const [track] = state.queue.splice(index, 1)
    state.queue.splice(targetIndex, 0, track)
  })
}

export function removeLiveStudioTrack(trackId) {
  const state = getLiveStudioState()
  const index = state.queue.findIndex(track => track.id === trackId)
  if (index === -1) return state

  const removed = state.queue[index]
  const isCurrent = removed.id === state.playback.currentTrackId

  const next = commit(draft => {
    const draftIndex = draft.queue.findIndex(track => track.id === trackId)
    if (draftIndex === -1) return

    draft.queue.splice(draftIndex, 1)

    if (!draft.queue.length) {
      draft.playback.currentTrackId = null
      draft.playback.currentTrackStartedAt = null
      return
    }

    if (isCurrent) {
      const nextIndex = Math.min(draftIndex, draft.queue.length - 1)
      draft.playback.currentTrackId = draft.queue[nextIndex].id
      draft.playback.currentTrackStartedAt = new Date().toISOString()
    }
  })

  deleteFileSafe(removed.storedPath)
  return next
}

export function skipLiveStudioTrack() {
  return commit(state => {
    if (!state.queue.length) return

    const currentIndex = state.queue.findIndex(track => track.id === state.playback.currentTrackId)
    const nextIndex = currentIndex === -1
      ? 0
      : (currentIndex + 1) % state.queue.length

    state.playback.currentTrackId = state.queue[nextIndex].id
    state.playback.currentTrackStartedAt = new Date().toISOString()
  })
}

export function clearLiveStudioQueue() {
  const state = getLiveStudioState()
  const paths = state.queue.map(track => track.storedPath)

  const next = commit(draft => {
    draft.queue = []
    draft.playback.currentTrackId = null
    draft.playback.currentTrackStartedAt = null
  })

  for (const filePath of paths) deleteFileSafe(filePath)
  return next
}
