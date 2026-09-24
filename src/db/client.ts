import { PrintJob, Filament } from '../types'
import type { Settings, Customer, FrozenTotals, JobHistoryEntry } from './repository'

export type { JobHistoryEntry } from './repository'

/**
 * Main-thread API for the database.
 *
 * The Worker owns the only SQLite connection; this is a typed promise wrapper
 * over the message channel to it. Components never talk to the Worker directly.
 */

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void }

let worker: Worker | null = null
let nextId = 1
const pending = new Map<number, Pending>()
let openPromise: Promise<OpenResult> | null = null

export interface OpenResult {
  persistent: boolean
  schema: { from: number; to: number }
}

function ensureWorker(): Worker {
  if (worker) return worker

  worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })

  worker.onmessage = (event: MessageEvent<{ id: number; ok: boolean; result?: unknown; error?: string }>) => {
    const { id, ok, result, error } = event.data
    const entry = pending.get(id)
    if (!entry) return
    pending.delete(id)
    if (ok) entry.resolve(result)
    else entry.reject(new Error(error ?? 'unknown database error'))
  }

  worker.onerror = event => {
    // A worker-level failure (module load, WASM fetch) never resolves individual
    // requests, so fail everything in flight rather than hanging the UI forever.
    const err = new Error(`Database worker failed: ${event.message}`)
    for (const [, entry] of pending) entry.reject(err)
    pending.clear()
  }

  return worker
}

function call<T>(payload: Record<string, unknown>): Promise<T> {
  const w = ensureWorker()
  const id = nextId++
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
    w.postMessage({ id, ...payload })
  })
}

/**
 * Open the database and run migrations. Safe to call repeatedly: the work
 * happens once and every caller awaits the same promise.
 */
export function openDatabase(): Promise<OpenResult> {
  if (!openPromise) {
    openPromise = call<OpenResult>({ op: 'open' }).catch(err => {
      // Clear the cache so a later retry can genuinely re-attempt rather than
      // replaying the failure forever.
      openPromise = null
      throw err
    })
  }
  return openPromise
}

// --- Jobs -------------------------------------------------------------------

export const listJobs = () => call<PrintJob[]>({ op: 'listJobs' })
/** Work in progress only: queued and printing. */
export const listActiveJobs = () => call<PrintJob[]>({ op: 'listActiveJobs' })
/** Finished work, most recently completed first. */
export const listJobHistory = () => call<JobHistoryEntry[]>({ op: 'listJobHistory' })
export const saveJob = (job: PrintJob) => call<string>({ op: 'saveJob', job })
export const updateJobStatus = (jobId: string, status: PrintJob['status']) =>
  call<void>({ op: 'updateJobStatus', jobId, status })
/**
 * Delete a job. Rejects a finished job unless `force` is set, so the work
 * history cannot be thrown away by a stray click.
 */
export const deleteJob = (jobId: string, force = false) =>
  call<void>({ op: 'deleteJob', jobId, force })
/** Re-quote a past job: copies it into a new queued job and returns its id. */
export const duplicateJob = (jobId: string, name?: string) =>
  call<string>({ op: 'duplicateJob', jobId, name })
export const issueQuote = (jobId: string, status?: 'sent' | 'accepted' | 'rejected') =>
  call<void>({ op: 'issueQuote', jobId, status })
export const getQuoteTotals = (jobId: string) =>
  call<FrozenTotals | undefined>({ op: 'getQuoteTotals', jobId })

// --- Filaments and customers ------------------------------------------------

export const listFilaments = () => call<Filament[]>({ op: 'listFilaments' })
export const createFilament = (filament: Omit<Filament, 'id'>) =>
  call<string>({ op: 'createFilament', filament })
export const deactivateFilament = (filamentId: string) =>
  call<void>({ op: 'deactivateFilament', filamentId })
export const listCustomers = () => call<Customer[]>({ op: 'listCustomers' })

// --- Settings ---------------------------------------------------------------

export const getSettings = () => call<Settings>({ op: 'getSettings' })
export const updateSettings = (patch: Partial<Settings>) =>
  call<void>({ op: 'updateSettings', patch })

// --- Legacy localStorage migration -----------------------------------------

/**
 * Move any data the old localStorage version saved into SQLite.
 *
 * localStorage is not available inside a Worker, so the main thread reads it and
 * ships the parsed contents across. The Worker records that the import ran, so
 * this is safe to call on every startup and cannot duplicate the queue.
 *
 * The localStorage keys are intentionally left in place: if the import produced
 * something unexpected, the original data is still recoverable.
 */
export async function importLegacyIfNeeded(): Promise<ImportSummary> {
  const { readLegacyLocalStorage } = await import('./importLegacy')
  const legacy = readLegacyLocalStorage(window.localStorage)

  if (legacy.filaments.length === 0 && legacy.jobs.length === 0) {
    return { alreadyDone: true, filamentsImported: 0, jobsImported: 0, skipped: [] }
  }

  return call<ImportSummary>({ op: 'importLegacy', legacy })
}

export interface ImportSummary {
  alreadyDone: boolean
  filamentsImported: number
  jobsImported: number
  skipped: { job: string; reason: string }[]
}

// --- Backup -----------------------------------------------------------------

/**
 * Download the database as a .sqlite3 file.
 *
 * This matters more here than it would with a server database: OPFS is wiped
 * when the browser clears site data, and this file is the only way back.
 */
export async function downloadBackup(): Promise<string> {
  const bytes = await call<Uint8Array>({ op: 'export' })
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
  const filename = `printdesk-${stamp}.sqlite3`

  // Copy into a plain ArrayBuffer. The bytes arrive from the Worker typed as
  // Uint8Array<ArrayBufferLike>, which Blob will not accept because it could in
  // principle be a SharedArrayBuffer.
  const buffer = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(buffer).set(bytes)

  const blob = new Blob([buffer], { type: 'application/vnd.sqlite3' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)

  return filename
}

/**
 * Replace the current database with the contents of a backup file.
 * Destructive and irreversible — the caller must confirm with the user first.
 */
export async function restoreBackup(file: File): Promise<void> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  await call<void>({ op: 'import', bytes })
}
