import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DB_DIR = path.join(__dirname, '../data')
if (!fs.existsSync(DB_DIR)) {
  fs.mkdirSync(DB_DIR, { recursive: true })
}

const SQLITE_PATH = path.join(DB_DIR, 'jobs.db')
const JSON_PATH = path.join(DB_DIR, 'jobs.json')

let dbType = 'json' // 'sqlite' or 'json'
let sqliteDb = null
let jsonDb = { jobs: [] }

// Helper for JSON DB
function loadJsonDb() {
  try {
    if (fs.existsSync(JSON_PATH)) {
      const raw = fs.readFileSync(JSON_PATH, 'utf8')
      jsonDb = JSON.parse(raw)
    } else {
      saveJsonDb()
    }
  } catch (err) {
    console.error('Failed to load JSON database, resetting:', err)
    jsonDb = { jobs: [] }
    saveJsonDb()
  }
}

function saveJsonDb() {
  try {
    fs.writeFileSync(JSON_PATH, JSON.stringify(jsonDb, null, 2), 'utf8')
  } catch (err) {
    console.error('Failed to write JSON database:', err)
  }
}

export async function initDb() {
  try {
    // Dynamically import sqlite3 to prevent crash if native module installation fails
    const sqlite3Module = await import('sqlite3')
    const sqlite3 = sqlite3Module.default.verbose()
    
    return new Promise((resolve) => {
      sqliteDb = new sqlite3.Database(SQLITE_PATH, (err) => {
        if (err) {
          console.warn('Could not open SQLite database, falling back to JSON storage:', err.message)
          dbType = 'json'
          loadJsonDb()
          resolve()
          return
        }
        
        dbType = 'sqlite'
        sqliteDb.serialize(() => {
          sqliteDb.run(`
            CREATE TABLE IF NOT EXISTS jobs (
              id TEXT PRIMARY KEY,
              filename TEXT,
              input_video_path TEXT,
              input_audio_path TEXT,
              target_duration INTEGER,
              crossfade REAL,
              hw_accel TEXT,
              status TEXT,
              progress INTEGER,
              fps INTEGER,
              eta INTEGER,
              output_size INTEGER,
              output_path TEXT,
              resolution TEXT,
              encoder_used TEXT,
              error_message TEXT,
              created_at TEXT,
              logs TEXT,
              reverse_mode TEXT DEFAULT 'disabled',
              loop_style TEXT DEFAULT 'standard',
              audio_fade TEXT DEFAULT 'off'
            )
          `, (err) => {
            if (err) {
              console.error('Failed to create sqlite schema, reverting to JSON fallback:', err)
              dbType = 'json'
              loadJsonDb()
              resolve()
            } else {
              // Migrate existing databases: add new columns if missing
              const migrations = [
                "ALTER TABLE jobs ADD COLUMN reverse_mode TEXT DEFAULT 'disabled'",
                "ALTER TABLE jobs ADD COLUMN loop_style TEXT DEFAULT 'standard'",
                "ALTER TABLE jobs ADD COLUMN audio_fade TEXT DEFAULT 'off'",
              ]
              let pending = migrations.length
              for (const sql of migrations) {
                sqliteDb.run(sql, () => {
                  // Ignore errors (column already exists)
                  if (--pending === 0) {
                    // Auto-recover active jobs on startup
                    sqliteDb.run(
                      "UPDATE jobs SET status = 'interrupted', progress = 0, fps = 0, eta = 0 WHERE status IN ('preparing', 'processing', 'finalizing')",
                      () => {
                        console.log('SQLite database initialized successfully. Leftover jobs marked as interrupted.')
                        resolve()
                      }
                    )
                  }
                })
              }
            }
          })
        })
      })
    })
  } catch (err) {
    console.warn('sqlite3 module is not installed or failed to load. Falling back to JSON database.', err.message)
    dbType = 'json'
    loadJsonDb()
    
    // Auto-recover active jobs for JSON
    let updated = false
    jsonDb.jobs = jsonDb.jobs.map(job => {
      if (['preparing', 'processing', 'finalizing'].includes(job.status)) {
        updated = true
        return { ...job, status: 'interrupted', progress: 0, fps: 0, eta: 0 }
      }
      return job
    })
    if (updated) saveJsonDb()
    console.log('JSON database initialized successfully. Leftover jobs marked as interrupted.')
  }
}

// DB API
export function getJobs() {
  return new Promise((resolve, reject) => {
    if (dbType === 'sqlite') {
      sqliteDb.all('SELECT * FROM jobs ORDER BY created_at DESC', (err, rows) => {
        if (err) reject(err)
        else resolve(rows || [])
      })
    } else {
      resolve([...jsonDb.jobs].sort((a, b) => new Date(b.created_at) - new Date(a.created_at)))
    }
  })
}

export function getJobById(id) {
  return new Promise((resolve, reject) => {
    if (dbType === 'sqlite') {
      sqliteDb.get('SELECT * FROM jobs WHERE id = ?', [id], (err, row) => {
        if (err) reject(err)
        else resolve(row || null)
      })
    } else {
      const job = jsonDb.jobs.find(j => j.id === id)
      resolve(job || null)
    }
  })
}

export function createJob(job) {
  return new Promise((resolve, reject) => {
    const newJob = {
      id: job.id,
      filename: job.filename,
      input_video_path: job.input_video_path,
      input_audio_path: job.input_audio_path || null,
      target_duration: job.target_duration,
      crossfade: job.crossfade || 0,
      hw_accel: job.hw_accel || 'auto',
      status: job.status || 'pending',
      progress: 0,
      fps: 0,
      eta: 0,
      output_size: 0,
      output_path: null,
      resolution: null,
      encoder_used: null,
      error_message: null,
      created_at: job.created_at || new Date().toISOString(),
      logs: '',
      reverse_mode: job.reverse_mode || 'disabled',
      loop_style: job.loop_style || 'standard',
      audio_fade: job.audio_fade || 'off',
    }

    if (dbType === 'sqlite') {
      const stmt = sqliteDb.prepare(`
        INSERT INTO jobs (
          id, filename, input_video_path, input_audio_path, target_duration, crossfade, hw_accel, status,
          progress, fps, eta, output_size, output_path, resolution, encoder_used, error_message, created_at, logs,
          reverse_mode, loop_style, audio_fade
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      stmt.run(
        newJob.id, newJob.filename, newJob.input_video_path, newJob.input_audio_path, newJob.target_duration,
        newJob.crossfade, newJob.hw_accel, newJob.status, newJob.progress, newJob.fps, newJob.eta,
        newJob.output_size, newJob.output_path, newJob.resolution, newJob.encoder_used, newJob.error_message,
        newJob.created_at, newJob.logs, newJob.reverse_mode, newJob.loop_style, newJob.audio_fade,
        (err) => {
          if (err) reject(err)
          else resolve(newJob)
        }
      )
    } else {
      jsonDb.jobs.push(newJob)
      saveJsonDb()
      resolve(newJob)
    }
  })
}

export function updateJob(id, updates) {
  return new Promise((resolve, reject) => {
    if (dbType === 'sqlite') {
      const keys = Object.keys(updates)
      if (keys.length === 0) {
        resolve()
        return
      }
      const setClause = keys.map(k => `${k} = ?`).join(', ')
      const params = keys.map(k => updates[k]).concat([id])
      sqliteDb.run(`UPDATE jobs SET ${setClause} WHERE id = ?`, params, function(err) {
        if (err) reject(err)
        else resolve()
      })
    } else {
      const idx = jsonDb.jobs.findIndex(j => j.id === id)
      if (idx !== -1) {
        jsonDb.jobs[idx] = { ...jsonDb.jobs[idx], ...updates }
        saveJsonDb()
      }
      resolve()
    }
  })
}

export function appendLog(id, message) {
  return new Promise((resolve, reject) => {
    const timestampedMsg = `[${new Date().toLocaleTimeString()}] ${message}\n`
    if (dbType === 'sqlite') {
      sqliteDb.run('UPDATE jobs SET logs = COALESCE(logs, "") || ? WHERE id = ?', [timestampedMsg, id], (err) => {
        if (err) reject(err)
        else resolve()
      })
    } else {
      const idx = jsonDb.jobs.findIndex(j => j.id === id)
      if (idx !== -1) {
        jsonDb.jobs[idx].logs = (jsonDb.jobs[idx].logs || '') + timestampedMsg
        saveJsonDb()
      }
      resolve()
    }
  })
}

export function deleteJob(id) {
  return new Promise((resolve, reject) => {
    if (dbType === 'sqlite') {
      sqliteDb.run('DELETE FROM jobs WHERE id = ?', [id], (err) => {
        if (err) reject(err)
        else resolve()
      })
    } else {
      const idx = jsonDb.jobs.findIndex(j => j.id === id)
      if (idx !== -1) {
        jsonDb.jobs.splice(idx, 1)
        saveJsonDb()
      }
      resolve()
    }
  })
}
