export async function apiJson(url, options = {}) {
  const response = await fetch(url, options)
  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(data.error || 'Request failed.')
  }
  return data
}

export function getLiveStudioWebSocketUrl() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${window.location.hostname}:5000`
}

export function formatMediaDuration(seconds) {
  if (!seconds || Number.isNaN(Number(seconds))) return '--'
  const value = Number(seconds)
  const h = Math.floor(value / 3600)
  const m = Math.floor((value % 3600) / 60)
  const s = Math.floor(value % 60)
  return h ? `${h}h ${m}m ${s}s` : m ? `${m}m ${s}s` : `${s}s`
}

export function formatMediaBytes(bytes) {
  if (!bytes && bytes !== 0) return '--'
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  const value = bytes / Math.pow(1024, exponent)
  return `${value.toFixed(exponent >= 2 ? 1 : 0)} ${units[exponent]}`
}
