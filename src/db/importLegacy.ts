import { SqlExecutor } from './types'
import { PrintJob, Filament, LaborStage } from '../types'
import { createFilament, saveJob, listFilaments } from './repository'

/**
 * One-time migration of the old localStorage data into SQLite.
 *
 * Runs against SqlExecutor rather than the client so it is testable under
 * node:sqlite. The localStorage reading is separated from the importing for the
 * same reason.
 *
 * The localStorage keys are left in place after a successful import: if
 * something is wrong with the result, the original data is still there. A
 * marker row records that the import already happened so it cannot run twice.
 */

export const LS_QUEUE_KEY = 'printdesk_queue'
export const LS_FILAMENTS_KEY = 'printdesk_filaments'
const IMPORT_MARKER = 'localstorage_import_completed_at'

export interface LegacyData {
  filaments: Filament[]
  jobs: PrintJob[]
}

export interface ImportResult {
  alreadyDone: boolean
  filamentsImported: number
  jobsImported: number
  skipped: { job: string; reason: string }[]
}

/** Read and parse the legacy keys. Returns empty arrays when absent or corrupt. */
export function readLegacyLocalStorage(storage: Pick<Storage, 'getItem'>): LegacyData {
  const parse = <T>(key: string): T[] => {
    const raw = storage.getItem(key)
    if (!raw) return []
    try {
      const parsed = JSON.parse(raw)
      return Array.isArray(parsed) ? (parsed as T[]) : []
    } catch {
      // Corrupt JSON must not abort the import of the other key.
      return []
    }
  }
  return {
    filaments: parse<Filament>(LS_FILAMENTS_KEY),
    jobs: parse<PrintJob>(LS_QUEUE_KEY),
  }
}

function markerTable(db: SqlExecutor): void {
  db.exec(`create table if not exists app_meta (
    key   text not null primary key,
    value text not null
  )`)
}

export function importAlreadyRan(db: SqlExecutor): boolean {
  markerTable(db)
  const row = db.get<{ value: string }>('select value from app_meta where key = ?', [IMPORT_MARKER])
  return !!row
}

/**
 * Normalise a legacy job into something the schema will accept.
 *
 * Legacy records predate several fields and were written by a UI with no
 * validation, so quantities of 0, missing arrays, and absent labor scope all
 * occur and would otherwise trip CHECK constraints.
 */
function normalizeJob(job: PrintJob): PrintJob {
  const stages: LaborStage[] = (job.laborStages ?? []).map(s => ({
    name: s.name ?? '',
    hours: Math.max(0, s.hours ?? 0),
    rate: Math.max(0, s.rate ?? 0),
    // Legacy stages had no scope and were all priced per unit. Preserving that
    // keeps imported totals identical to what the old app displayed.
    scope: s.scope ?? 'per_unit',
  }))

  return {
    ...job,
    id: job.id || crypto.randomUUID(),
    name: job.name?.trim() || 'Trabajo sin nombre',
    client: job.client ?? '',
    status: job.status ?? 'queued',
    jobFilaments: (job.jobFilaments ?? []).map(f => ({
      id: f.id || crypto.randomUUID(),
      // A legacy filamentId points at a localStorage id that may not survive
      // as a catalog row, so it is dropped rather than risking a broken link.
      filamentId: undefined,
      material: f.material ?? '',
      color: f.color ?? '',
      weight: Math.max(0, f.weight ?? 0),
      pricePerKg: Math.max(0, f.pricePerKg ?? 0),
    })),
    printTimeHours: Math.max(0, job.printTimeHours ?? 0),
    powerWatts: Math.max(0, job.powerWatts ?? 0),
    electricityRate: Math.max(0, job.electricityRate ?? 0),
    laborStages: stages,
    packagingCost: Math.max(0, job.packagingCost ?? 0),
    finishingCost: Math.max(0, job.finishingCost ?? 0),
    marginPercent: job.marginPercent ?? 0,
    quantity: Math.max(1, Math.floor(job.quantity ?? 1)),
    // Legacy data predates IVA support and was never taxed.
    ivaEnabled: job.ivaEnabled ?? false,
    notes: job.notes ?? '',
    createdAt: job.createdAt || new Date().toISOString(),
  }
}

/**
 * Import legacy data. Idempotent: a marker row prevents a second run, so a
 * refresh cannot duplicate the whole queue.
 */
export function importLegacyData(db: SqlExecutor, data: LegacyData): ImportResult {
  markerTable(db)
  if (importAlreadyRan(db)) {
    return { alreadyDone: true, filamentsImported: 0, jobsImported: 0, skipped: [] }
  }

  const skipped: ImportResult['skipped'] = []
  let filamentsImported = 0
  let jobsImported = 0

  const existingNames = new Set(
    listFilaments(db, true).map(f => `${f.brand}|${f.type}|${f.color}`.toLowerCase()),
  )

  for (const f of data.filaments) {
    const key = `${f.brand}|${f.type}|${f.color}`.toLowerCase()
    if (existingNames.has(key)) continue
    try {
      createFilament(db, {
        brand: f.brand ?? '',
        type: f.type ?? '',
        color: f.color ?? '',
        hex: /^#[0-9a-fA-F]{6}$/.test(f.hex ?? '') ? f.hex : '#ffffff',
        pricePerKg: Math.max(0, f.pricePerKg ?? 0),
      })
      existingNames.add(key)
      filamentsImported++
    } catch (err) {
      skipped.push({ job: `filament ${f.brand} ${f.type}`, reason: (err as Error).message })
    }
  }

  for (const raw of data.jobs) {
    // Each job is saved independently so one bad record cannot block the rest.
    try {
      saveJob(db, normalizeJob(raw))
      jobsImported++
    } catch (err) {
      skipped.push({ job: raw.name || raw.id || '(unnamed)', reason: (err as Error).message })
    }
  }

  db.run('insert into app_meta (key, value) values (?, ?)', [
    IMPORT_MARKER,
    new Date().toISOString(),
  ])

  return { alreadyDone: false, filamentsImported, jobsImported, skipped }
}
