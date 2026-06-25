export const FRAME_PRESETS = {
  landscape: { label: 'Landscape', width: 1920, height: 1080 },
  square: { label: 'Square', width: 1080, height: 1080 },
  portrait: { label: 'Portrait', width: 1080, height: 1920 },
}

export const WAVEFORM_COLOR_PRESETS = [
  '#f6d365',
  '#fda085',
  '#60a5fa',
  '#34d399',
  '#f472b6',
  '#ffffff',
]

export const DEFAULT_WAVEFORM_VISUAL_CONFIG = {
  framePreset: 'landscape',
  backgroundMode: 'solid',
  backgroundColor: '#050505',
  waveformColor: '#f6d365',
  glowColor: '#fef3c7',
  positionX: 0.08,
  positionY: 0.38,
  sizeWidth: 0.84,
  sizeHeight: 0.24,
  lineCount: 6,
  lineGap: 0.038,
  thickness: 2.4,
  amplitude: 0.72,
  opacity: 0.92,
  glowStrength: 0.82,
  glowBlur: 18,
  trailDelayMs: 7,
  smoothing: 0.78,
  fps: 30,
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function roundTo(value, decimals) {
  const factor = 10 ** decimals
  return Math.round(value * factor) / factor
}

function sanitizeHexColor(value, fallback) {
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim()
  if (/^#[0-9a-fA-F]{6}$/.test(trimmed)) return trimmed.toLowerCase()
  if (/^#[0-9a-fA-F]{3}$/.test(trimmed)) {
    return `#${trimmed[1]}${trimmed[1]}${trimmed[2]}${trimmed[2]}${trimmed[3]}${trimmed[3]}`.toLowerCase()
  }
  return fallback
}

export function getFrameDimensions(framePreset) {
  return FRAME_PRESETS[framePreset] || FRAME_PRESETS[DEFAULT_WAVEFORM_VISUAL_CONFIG.framePreset]
}

export function sanitizeWaveformVisualConfig(raw = {}) {
  const safe = { ...DEFAULT_WAVEFORM_VISUAL_CONFIG, ...(raw || {}) }
  const framePreset = FRAME_PRESETS[safe.framePreset] ? safe.framePreset : DEFAULT_WAVEFORM_VISUAL_CONFIG.framePreset

  return {
    framePreset,
    backgroundMode: ['solid', 'still', 'loop', 'pingpong'].includes(safe.backgroundMode) ? safe.backgroundMode : DEFAULT_WAVEFORM_VISUAL_CONFIG.backgroundMode,
    backgroundColor: sanitizeHexColor(safe.backgroundColor, DEFAULT_WAVEFORM_VISUAL_CONFIG.backgroundColor),
    waveformColor: sanitizeHexColor(safe.waveformColor, DEFAULT_WAVEFORM_VISUAL_CONFIG.waveformColor),
    glowColor: sanitizeHexColor(safe.glowColor, DEFAULT_WAVEFORM_VISUAL_CONFIG.glowColor),
    positionX: roundTo(clamp(Number(safe.positionX), 0, 0.88), 4),
    positionY: roundTo(clamp(Number(safe.positionY), 0, 0.88), 4),
    sizeWidth: roundTo(clamp(Number(safe.sizeWidth), 0.12, 1), 4),
    sizeHeight: roundTo(clamp(Number(safe.sizeHeight), 0.1, 0.85), 4),
    lineCount: Math.round(clamp(Number(safe.lineCount), 1, 8)),
    lineGap: roundTo(clamp(Number(safe.lineGap), 0, 0.12), 4),
    thickness: roundTo(clamp(Number(safe.thickness), 1, 6), 3),
    amplitude: roundTo(clamp(Number(safe.amplitude), 0.2, 1), 4),
    opacity: roundTo(clamp(Number(safe.opacity), 0.1, 1), 4),
    glowStrength: roundTo(clamp(Number(safe.glowStrength), 0, 1.5), 4),
    glowBlur: roundTo(clamp(Number(safe.glowBlur), 0, 48), 3),
    trailDelayMs: Math.round(clamp(Number(safe.trailDelayMs), 0, 24)),
    smoothing: roundTo(clamp(Number(safe.smoothing), 0, 0.98), 4),
    fps: Math.round(clamp(Number(safe.fps), 24, 60)),
  }
}

export function clampWaveBox(config) {
  const safe = sanitizeWaveformVisualConfig(config)
  return sanitizeWaveformVisualConfig({
    ...safe,
    positionX: clamp(safe.positionX, 0, Math.max(0, 1 - safe.sizeWidth)),
    positionY: clamp(safe.positionY, 0, Math.max(0, 1 - safe.sizeHeight)),
  })
}

export function toFfmpegHexColor(value) {
  return sanitizeHexColor(value, '#ffffff')
}
