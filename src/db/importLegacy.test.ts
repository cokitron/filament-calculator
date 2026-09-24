import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import schemaSql from './schema.sql?raw'
import { NodeSqlExecutor } from './nodeExecutor'
import { initializeSchema, ensureSettings } from './schema'
import {
  readLegacyLocalStorage, importLegacyData, importAlreadyRan,
  LS_QUEUE_KEY, LS_FILAMENTS_KEY,
} from './importLegacy'
import { listJobs, listFilaments } from './repository'
import { computeCosts } from '../pricing'
import { PrintJob } from '../types'

let db: NodeSqlExecutor

beforeEach(() => {
  db = new NodeSqlExecutor()
  initializeSchema(db, schemaSql)
  ensureSettings(db)
})

afterEach(() => db.close())

/** Minimal stand-in for window.localStorage. */
function fakeStorage(entries: Record<string, string>) {
  return { getItem: (k: string) => entries[k] ?? null }
}

/** A job exactly as the old localStorage version wrote it: no scope, no IVA. */
const legacyJob = {
  id: '1',
  name: 'Phone Stand v3',
  client: 'Walk-in',
  status: 'printing',
  jobFilaments: [{ id: 'f1', material: 'PLA+', color: 'Matte Black', weight: 48, pricePerKg: 22 }],
  printTimeHours: 3.5,
  powerWatts: 200,
  electricityRate: 0.14,
  laborStages: [
    { name: 'Slicing & Setup', hours: 0.25, rate: 25 },
    { name: 'Post-processing', hours: 0.5, rate: 20 },
  ],
  packagingCost: 1.5,
  finishingCost: 0,
  marginPercent: 35,
  quantity: 2,
  notes: '',
  createdAt: '2026-01-01T00:00:00.000Z',
}

describe('readLegacyLocalStorage', () => {
  it('reads both keys', () => {
    const storage = fakeStorage({
      [LS_FILAMENTS_KEY]: JSON.stringify([
        { id: '1', brand: 'Polymaker', type: 'PLA+', color: 'Matte Black', hex: '#1a1a1a', pricePerKg: 22 },
      ]),
      [LS_QUEUE_KEY]: JSON.stringify([legacyJob]),
    })
    const data = readLegacyLocalStorage(storage)
    expect(data.filaments).toHaveLength(1)
    expect(data.jobs).toHaveLength(1)
  })

  it('returns empty arrays when nothing is stored', () => {
    const data = readLegacyLocalStorage(fakeStorage({}))
    expect(data).toEqual({ filaments: [], jobs: [] })
  })

  it('survives corrupt JSON in one key without losing the other', () => {
    const storage = fakeStorage({
      [LS_FILAMENTS_KEY]: '{not json at all',
      [LS_QUEUE_KEY]: JSON.stringify([legacyJob]),
    })
    const data = readLegacyLocalStorage(storage)
    expect(data.filaments).toEqual([])
    expect(data.jobs).toHaveLength(1)
  })

  it('ignores a value that parses but is not an array', () => {
    const storage = fakeStorage({ [LS_QUEUE_KEY]: '{"oops":true}' })
    expect(readLegacyLocalStorage(storage).jobs).toEqual([])
  })
})

describe('importLegacyData', () => {
  it('imports filaments and jobs', () => {
    const result = importLegacyData(db, {
      filaments: [
        { id: '1', brand: 'Polymaker', type: 'PLA+', color: 'Matte Black', hex: '#1a1a1a', pricePerKg: 22 },
        { id: '2', brand: 'Hatchbox', type: 'PETG', color: 'Transparent', hex: '#e5e7eb', pricePerKg: 28 },
      ],
      jobs: [legacyJob as unknown as PrintJob],
    })

    expect(result.alreadyDone).toBe(false)
    expect(result.filamentsImported).toBe(2)
    expect(result.jobsImported).toBe(1)
    expect(result.skipped).toEqual([])
    expect(listFilaments(db)).toHaveLength(2)
    expect(listJobs(db)).toHaveLength(1)
  })

  it('preserves the legacy total exactly', () => {
    // The whole point: a job must be worth the same after import as before, so
    // nothing silently re-prices during the migration.
    const before = computeCosts(legacyJob as unknown as PrintJob)
    importLegacyData(db, { filaments: [], jobs: [legacyJob as unknown as PrintJob] })
    const after = computeCosts(listJobs(db)[0])
    expect(after.total).toBeCloseTo(before.total, 10)
  })

  it('defaults legacy labor stages to per_unit', () => {
    importLegacyData(db, { filaments: [], jobs: [legacyJob as unknown as PrintJob] })
    const stages = listJobs(db)[0].laborStages
    expect(stages.every(s => s.scope === 'per_unit')).toBe(true)
  })

  it('leaves IVA off for legacy records', () => {
    importLegacyData(db, { filaments: [], jobs: [legacyJob as unknown as PrintJob] })
    expect(listJobs(db)[0].ivaEnabled).toBe(false)
  })

  it('creates customers from the old free-text client field', () => {
    importLegacyData(db, {
      filaments: [],
      jobs: [
        { ...legacyJob, id: 'a', client: 'RC Hobbies' } as unknown as PrintJob,
        { ...legacyJob, id: 'b', client: 'rc hobbies' } as unknown as PrintJob,
      ],
    })
    // Two spellings of one customer collapse into a single row.
    const clients = listJobs(db).map(j => j.client)
    expect(new Set(clients).size).toBe(1)
  })

  it('refuses to run twice', () => {
    importLegacyData(db, { filaments: [], jobs: [legacyJob as unknown as PrintJob] })
    const second = importLegacyData(db, { filaments: [], jobs: [legacyJob as unknown as PrintJob] })

    expect(second.alreadyDone).toBe(true)
    expect(second.jobsImported).toBe(0)
    // A refresh must not duplicate the queue.
    expect(listJobs(db)).toHaveLength(1)
  })

  it('reports the import as having run', () => {
    expect(importAlreadyRan(db)).toBe(false)
    importLegacyData(db, { filaments: [], jobs: [] })
    expect(importAlreadyRan(db)).toBe(true)
  })

  it('repairs records the schema would otherwise reject', () => {
    const broken = {
      id: 'x',
      name: '   ',
      quantity: 0,
      printTimeHours: -3,
      marginPercent: 30,
      jobFilaments: undefined,
      laborStages: undefined,
      packagingCost: undefined,
      finishingCost: undefined,
      powerWatts: undefined,
      electricityRate: undefined,
      client: undefined,
      status: undefined,
      notes: undefined,
      createdAt: '',
    }
    const result = importLegacyData(db, { filaments: [], jobs: [broken as unknown as PrintJob] })

    expect(result.jobsImported).toBe(1)
    const job = listJobs(db)[0]
    expect(job.name).toBe('Trabajo sin nombre')
    expect(job.quantity).toBe(1)
    expect(job.printTimeHours).toBe(0)
    expect(job.status).toBe('queued')
    expect(job.jobFilaments).toEqual([])
  })

  it('skips a bad job but still imports the good ones', () => {
    const unfixable = {
      ...legacyJob,
      id: 'bad',
      // A status the CHECK constraint will not accept, and which normalisation
      // deliberately does not invent a replacement for.
      status: 'teleporting',
    }
    const result = importLegacyData(db, {
      filaments: [],
      jobs: [unfixable as unknown as PrintJob, { ...legacyJob, id: 'good' } as unknown as PrintJob],
    })

    expect(result.jobsImported).toBe(1)
    expect(result.skipped).toHaveLength(1)
    expect(listJobs(db)).toHaveLength(1)
    expect(listJobs(db)[0].id).toBe('good')
  })

  it('does not duplicate a filament that already exists', () => {
    importLegacyData(db, {
      filaments: [
        { id: '1', brand: 'Polymaker', type: 'PLA+', color: 'Negro', hex: '#1a1a1a', pricePerKg: 22 },
        { id: '2', brand: 'polymaker', type: 'pla+', color: 'NEGRO', hex: '#1a1a1a', pricePerKg: 99 },
      ],
      jobs: [],
    })
    expect(listFilaments(db)).toHaveLength(1)
  })

  it('replaces an invalid hex rather than failing the row', () => {
    importLegacyData(db, {
      filaments: [{ id: '1', brand: 'B', type: 'PLA', color: 'C', hex: 'rojo', pricePerKg: 400 }],
      jobs: [],
    })
    expect(listFilaments(db)[0].hex).toBe('#ffffff')
  })

  it('handles completely empty legacy data', () => {
    const result = importLegacyData(db, { filaments: [], jobs: [] })
    expect(result).toMatchObject({ alreadyDone: false, filamentsImported: 0, jobsImported: 0 })
  })
})
