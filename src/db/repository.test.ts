import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { NodeSqlExecutor } from './testExecutor'
import { initializeSchema, ensureSettings } from './schema'
import {
  getSettings, updateSettings,
  listFilaments, createFilament, updateFilamentPrice, deactivateFilament,
  listCustomers, findOrCreateCustomer,
  saveJob, listJobs, listActiveJobs, listJobHistory, getJob, updateJobStatus, deleteJob,
  duplicateJob, issueQuote, getQuoteTotals,
} from './repository'
import { PrintJob } from '../types'
import { computeCosts } from '../pricing'

let db: NodeSqlExecutor

beforeEach(() => {
  db = new NodeSqlExecutor()
  initializeSchema(db)
  ensureSettings(db)
})

afterEach(() => db.close())

function aJob(overrides: Partial<PrintJob> = {}): PrintJob {
  return {
    id: crypto.randomUUID(),
    name: 'Soporte de teléfono',
    client: 'Studio Verde',
    status: 'queued',
    jobFilaments: [
      { id: crypto.randomUUID(), material: 'PLA+', color: 'Negro', weight: 48, pricePerKg: 440 },
    ],
    printTimeHours: 3.5,
    powerWatts: 200,
    electricityRate: 2.8,
    laborStages: [
      { name: 'Slicing & Setup', hours: 0.25, rate: 120, scope: 'per_job' },
      { name: 'Post-proceso', hours: 0.5, rate: 100, scope: 'per_unit' },
    ],
    packagingCost: 30,
    finishingCost: 0,
    marginPercent: 35,
    quantity: 2,
    ivaEnabled: true,
    notes: 'Entrega el jueves',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('settings', () => {
  it('reads defaults as typed values with IVA off', () => {
    const s = getSettings(db)
    expect(s.currency).toBe('MXN')
    expect(s.ivaRate).toBe(0.16)
    expect(s.defaultIvaEnabled).toBe(false)
    expect(s.electricityRate).toBe(2.8)
  })

  it('patches only the fields provided', () => {
    updateSettings(db, { businessName: 'Mi Taller', electricityRate: 3.15 })
    const s = getSettings(db)
    expect(s.businessName).toBe('Mi Taller')
    expect(s.electricityRate).toBe(3.15)
    expect(s.defaultMarkupPercent).toBe(30)
  })

  it('round-trips booleans through integer storage', () => {
    updateSettings(db, { defaultIvaEnabled: true })
    expect(getSettings(db).defaultIvaEnabled).toBe(true)
    updateSettings(db, { defaultIvaEnabled: false })
    expect(getSettings(db).defaultIvaEnabled).toBe(false)
  })

  it('ignores an empty patch', () => {
    updateSettings(db, {})
    expect(getSettings(db).currency).toBe('MXN')
  })
})

describe('filaments', () => {
  it('creates and lists', () => {
    createFilament(db, { brand: 'Polymaker', type: 'PLA+', color: 'Negro', hex: '#1a1a1a', pricePerKg: 440 })
    const all = listFilaments(db)
    expect(all).toHaveLength(1)
    expect(all[0]).toMatchObject({ brand: 'Polymaker', pricePerKg: 440, hex: '#1a1a1a' })
  })

  it('hides deactivated filaments but can still return them', () => {
    const id = createFilament(db, { brand: 'X', type: 'PLA', color: 'Rojo', hex: '#ff0000', pricePerKg: 400 })
    deactivateFilament(db, id)
    expect(listFilaments(db)).toHaveLength(0)
    expect(listFilaments(db, true)).toHaveLength(1)
  })

  it('a catalog price change does not alter an already-saved job', () => {
    const fid = createFilament(db, { brand: 'P', type: 'PLA+', color: 'Negro', hex: '#000000', pricePerKg: 440 })
    const job = aJob({
      jobFilaments: [{ id: crypto.randomUUID(), filamentId: fid, material: 'P PLA+', color: 'Negro', weight: 100, pricePerKg: 440 }],
    })
    saveJob(db, job)

    updateFilamentPrice(db, fid, 999)

    const reloaded = listJobs(db)[0]
    // This is the whole point of snapshotting price_per_kg on job_materials.
    expect(reloaded.jobFilaments[0].pricePerKg).toBe(440)
    expect(listFilaments(db)[0].pricePerKg).toBe(999)
  })
})

describe('customers', () => {
  it('creates once and reuses regardless of case or padding', () => {
    const a = findOrCreateCustomer(db, 'Studio Verde')
    const b = findOrCreateCustomer(db, '  studio verde  ')
    expect(a).toBe(b)
    expect(listCustomers(db)).toHaveLength(1)
  })

  it('returns null for a blank name rather than creating a junk row', () => {
    expect(findOrCreateCustomer(db, '   ')).toBeNull()
    expect(listCustomers(db)).toHaveLength(0)
  })
})

describe('saveJob / listJobs', () => {
  it('round-trips every field of a job', () => {
    const job = aJob()
    saveJob(db, job)

    const [loaded] = listJobs(db)
    expect(loaded.id).toBe(job.id)
    expect(loaded.name).toBe(job.name)
    expect(loaded.client).toBe('Studio Verde')
    expect(loaded.status).toBe('queued')
    expect(loaded.quantity).toBe(2)
    expect(loaded.printTimeHours).toBe(3.5)
    expect(loaded.powerWatts).toBe(200)
    expect(loaded.electricityRate).toBe(2.8)
    expect(loaded.packagingCost).toBe(30)
    expect(loaded.finishingCost).toBe(0)
    expect(loaded.marginPercent).toBe(35)
    expect(loaded.ivaEnabled).toBe(true)
    expect(loaded.notes).toBe('Entrega el jueves')
    expect(loaded.createdAt).toBe('2026-01-01T00:00:00.000Z')
  })

  it('preserves labor stage scope, which the pricing depends on', () => {
    saveJob(db, aJob())
    const [loaded] = listJobs(db)
    expect(loaded.laborStages).toEqual([
      { name: 'Slicing & Setup', hours: 0.25, rate: 120, scope: 'per_job' },
      { name: 'Post-proceso', hours: 0.5, rate: 100, scope: 'per_unit' },
    ])
  })

  it('defaults a scopeless stage to per_unit on the way in', () => {
    saveJob(db, aJob({ laborStages: [{ name: 'Legacy', hours: 1, rate: 100 }] }))
    expect(listJobs(db)[0].laborStages[0].scope).toBe('per_unit')
  })

  it('preserves material order', () => {
    saveJob(db, aJob({
      jobFilaments: [
        { id: crypto.randomUUID(), material: 'PETG', color: 'Transparente', weight: 320, pricePerKg: 560 },
        { id: crypto.randomUUID(), material: 'PLA', color: 'Blanco', weight: 150, pricePerKg: 400 },
      ],
    }))
    const m = listJobs(db)[0].jobFilaments
    expect(m.map(x => x.material)).toEqual(['PETG', 'PLA'])
  })

  it('produces the same computed total before and after a save', () => {
    const job = aJob()
    const before = computeCosts(job)
    saveJob(db, job)
    const after = computeCosts(listJobs(db)[0])
    // Storage must be lossless, or the queue would show a different price than
    // the calculator did.
    expect(after.total).toBe(before.total)
    expect(after.iva).toBe(before.iva)
    expect(after.unitPrice).toBe(before.unitPrice)
  })

  it('updates in place rather than duplicating on second save', () => {
    const job = aJob()
    saveJob(db, job)
    saveJob(db, { ...job, name: 'Renombrado', quantity: 5 })

    const jobs = listJobs(db)
    expect(jobs).toHaveLength(1)
    expect(jobs[0].name).toBe('Renombrado')
    expect(jobs[0].quantity).toBe(5)
    // Child rows are replaced, not accumulated.
    expect(jobs[0].laborStages).toHaveLength(2)
    expect(jobs[0].jobFilaments).toHaveLength(1)
  })

  it('assigns sequential folios', () => {
    const a = aJob()
    const b = aJob()
    saveJob(db, a)
    saveJob(db, b)
    expect(getQuoteTotals(db, a.id)?.folio).toBe(1)
    expect(getQuoteTotals(db, b.id)?.folio).toBe(2)
  })

  it('reuses one customer across several jobs', () => {
    saveJob(db, aJob())
    saveJob(db, aJob())
    expect(listCustomers(db)).toHaveLength(1)
  })

  it('handles a job with no client', () => {
    saveJob(db, aJob({ client: '' }))
    expect(listJobs(db)[0].client).toBe('')
    expect(listCustomers(db)).toHaveLength(0)
  })

  it('returns jobs newest first', () => {
    saveJob(db, aJob({ name: 'Viejo', createdAt: '2026-01-01T00:00:00.000Z' }))
    saveJob(db, aJob({ name: 'Nuevo', createdAt: '2026-06-01T00:00:00.000Z' }))
    expect(listJobs(db).map(j => j.name)).toEqual(['Nuevo', 'Viejo'])
  })

  it('rolls back the whole job if one child row is invalid', () => {
    const bad = aJob({ laborStages: [{ name: 'X', hours: -5, rate: 100, scope: 'per_unit' }] })
    expect(() => saveJob(db, bad)).toThrow()
    // No half-written quote or job left behind.
    expect(listJobs(db)).toHaveLength(0)
    expect(db.all('select 1 from quotes')).toHaveLength(0)
  })
})

describe('status and deletion', () => {
  it('updates status', () => {
    const job = aJob()
    saveJob(db, job)
    updateJobStatus(db, job.id, 'printing')
    expect(listJobs(db)[0].status).toBe('printing')
  })

  it('deletes the job and its orphaned quote', () => {
    const job = aJob()
    saveJob(db, job)
    deleteJob(db, job.id)
    expect(listJobs(db)).toHaveLength(0)
    expect(db.all('select 1 from quotes')).toHaveLength(0)
    expect(db.all('select 1 from job_materials')).toHaveLength(0)
    expect(db.all('select 1 from job_labor_stages')).toHaveLength(0)
  })

  it('deleting an unknown job is a no-op, not an error', () => {
    expect(() => deleteJob(db, 'nope')).not.toThrow()
  })

  it('refuses to delete finished work without force', () => {
    const job = aJob()
    saveJob(db, job)
    updateJobStatus(db, job.id, 'done')

    expect(() => deleteJob(db, job.id)).toThrow(/work history/)
    expect(listJobHistory(db)).toHaveLength(1)

    deleteJob(db, job.id, { force: true })
    expect(listJobHistory(db)).toHaveLength(0)
  })
})

describe('active queue vs history', () => {
  it('keeps unfinished work in the queue and out of history', () => {
    const queued = aJob({ name: 'En cola' })
    const printing = aJob({ name: 'Imprimiendo' })
    saveJob(db, queued)
    saveJob(db, printing)
    updateJobStatus(db, printing.id, 'printing')

    expect(listActiveJobs(db).map(j => j.name).sort()).toEqual(['En cola', 'Imprimiendo'])
    expect(listJobHistory(db)).toHaveLength(0)
  })

  it('moves a job from the queue to history when it finishes', () => {
    const job = aJob()
    saveJob(db, job)
    updateJobStatus(db, job.id, 'done')

    expect(listActiveJobs(db)).toHaveLength(0)
    const history = listJobHistory(db)
    expect(history).toHaveLength(1)
    expect(history[0].job.id).toBe(job.id)
    expect(history[0].folio).toBe(1)
  })

  it('records a cancelled job in history too', () => {
    const job = aJob()
    saveJob(db, job)
    updateJobStatus(db, job.id, 'cancelled')
    expect(listJobHistory(db).map(e => e.job.status)).toEqual(['cancelled'])
  })

  it('stamps when the run started and when it closed', () => {
    const job = aJob()
    saveJob(db, job)
    updateJobStatus(db, job.id, 'printing')
    const started = db.get<{ started_at: string }>('select started_at from jobs where id = ?', [job.id])!.started_at
    expect(started).not.toBeNull()

    updateJobStatus(db, job.id, 'done')
    const [entry] = listJobHistory(db)
    expect(entry.startedAt).toBe(started)
    expect(entry.completedAt).not.toBeNull()
  })

  it('does not reset the start stamp when a job is restarted', () => {
    const job = aJob()
    saveJob(db, job)
    updateJobStatus(db, job.id, 'printing')
    const first = db.get<{ started_at: string }>('select started_at from jobs where id = ?', [job.id])!.started_at
    updateJobStatus(db, job.id, 'queued')
    updateJobStatus(db, job.id, 'printing')
    expect(db.get<{ started_at: string }>('select started_at from jobs where id = ?', [job.id])!.started_at).toBe(first)
  })

  it('reopening a finished job pulls it back out of history', () => {
    const job = aJob()
    saveJob(db, job)
    updateJobStatus(db, job.id, 'done')
    updateJobStatus(db, job.id, 'queued')

    expect(listJobHistory(db)).toHaveLength(0)
    expect(listActiveJobs(db)).toHaveLength(1)
    // The freeze is undone, so finishing it again will record the corrected
    // numbers rather than a stale total.
    const t = getQuoteTotals(db, job.id)!
    expect(t.status).toBe('draft')
    expect(t.total).toBeNull()
    expect(t.frozenAt).toBeNull()
  })

  it('does not retract the figures of a quote the user actually sent', () => {
    const job = aJob()
    saveJob(db, job)
    issueQuote(db, job.id, 'sent')
    const sent = getQuoteTotals(db, job.id)!

    updateJobStatus(db, job.id, 'done')
    updateJobStatus(db, job.id, 'queued')

    const after = getQuoteTotals(db, job.id)!
    // Completing it recorded the customer's acceptance; reopening the print does
    // not undo that, and the price the customer was given is still on record.
    expect(after.status).toBe('accepted')
    expect(after.total).toBe(sent.total)
    expect(after.frozenAt).toBe(sent.frozenAt)
  })

  it('orders history by completion, newest first', () => {
    const a = aJob({ name: 'Primero', createdAt: '2026-01-01T00:00:00.000Z' })
    const b = aJob({ name: 'Segundo', createdAt: '2026-02-01T00:00:00.000Z' })
    saveJob(db, a)
    saveJob(db, b)
    // b finishes first, so it must appear last despite being created later.
    updateJobStatus(db, b.id, 'done')
    db.run("update jobs set completed_at = '2026-03-01T00:00:00.000Z' where id = ?", [b.id])
    updateJobStatus(db, a.id, 'done')
    db.run("update jobs set completed_at = '2026-04-01T00:00:00.000Z' where id = ?", [a.id])

    expect(listJobHistory(db).map(e => e.job.name)).toEqual(['Primero', 'Segundo'])
  })
})

describe('history freezes what was charged', () => {
  it('freezes totals when a job is marked done', () => {
    const job = aJob()
    saveJob(db, job)
    const expected = computeCosts(job)

    updateJobStatus(db, job.id, 'done')

    const [entry] = listJobHistory(db)
    expect(entry.frozen).not.toBeNull()
    expect(entry.frozen!.total).toBeCloseTo(expected.total, 2)
    expect(entry.frozen!.totalIva).toBeCloseTo(expected.iva, 2)
    expect(entry.frozen!.totalPreTax).toBeCloseTo(expected.jobPreTax, 2)
    expect(entry.quoteStatus).toBe('accepted')
  })

  it('a later filament price rise does not rewrite a finished job', () => {
    const fid = createFilament(db, { brand: 'P', type: 'PLA', color: 'N', hex: '#000000', pricePerKg: 400 })
    const job = aJob({
      jobFilaments: [{ id: crypto.randomUUID(), filamentId: fid, material: 'P PLA', color: 'N', weight: 500, pricePerKg: 400 }],
    })
    saveJob(db, job)
    updateJobStatus(db, job.id, 'done')
    const recorded = listJobHistory(db)[0].frozen!.total

    updateFilamentPrice(db, fid, 1500)

    // This is the whole reason history exists: what was charged stays charged.
    expect(listJobHistory(db)[0].frozen!.total).toBe(recorded)
  })

  it('keeps the issued figures when a sent quote is later marked done', () => {
    const job = aJob()
    saveJob(db, job)
    issueQuote(db, job.id, 'sent')
    const sentTotal = getQuoteTotals(db, job.id)!.total

    // The job is edited after being quoted — a discount, say — and only then
    // completed. The customer-facing number must not move.
    saveJob(db, { ...job, quantity: 20 })
    updateJobStatus(db, job.id, 'done')

    expect(listJobHistory(db)[0].frozen!.total).toBe(sentTotal)
  })
})

describe('duplicateJob', () => {
  it('re-quotes a past job as a new queued job', () => {
    const job = aJob()
    saveJob(db, job)
    updateJobStatus(db, job.id, 'done')

    const copyId = duplicateJob(db, job.id)
    const copy = getJob(db, copyId)!

    expect(copyId).not.toBe(job.id)
    expect(copy.status).toBe('queued')
    expect(copy.name).toBe('Soporte de teléfono (REPETICIÓN)')
    expect(copy.client).toBe(job.client)
    expect(copy.quantity).toBe(job.quantity)
    expect(copy.marginPercent).toBe(job.marginPercent)
    expect(copy.ivaEnabled).toBe(true)
    expect(copy.jobFilaments.map(f => [f.material, f.weight, f.pricePerKg])).toEqual(
      job.jobFilaments.map(f => [f.material, f.weight, f.pricePerKg]),
    )
    expect(copy.laborStages).toEqual(job.laborStages)
    // Prices the customer paid last time, so old and new are comparable.
    expect(computeCosts(copy).total).toBeCloseTo(computeCosts(job).total, 6)
  })

  it('leaves the original in history untouched and takes a new folio', () => {
    const job = aJob()
    saveJob(db, job)
    updateJobStatus(db, job.id, 'done')

    const copyId = duplicateJob(db, job.id, 'Segunda tanda')

    expect(listJobHistory(db)).toHaveLength(1)
    expect(listActiveJobs(db).map(j => j.name)).toEqual(['Segunda tanda'])
    expect(getQuoteTotals(db, job.id)!.folio).toBe(1)
    expect(getQuoteTotals(db, copyId)!.folio).toBe(2)
    // The copy is a fresh draft, not a quote that has already been issued.
    expect(getQuoteTotals(db, copyId)!.frozenAt).toBeNull()
  })

  it('gives copied materials new ids so they do not collide', () => {
    const job = aJob()
    saveJob(db, job)
    const copyId = duplicateJob(db, job.id)
    const original = getJob(db, job.id)!
    const copy = getJob(db, copyId)!
    expect(copy.jobFilaments[0].id).not.toBe(original.jobFilaments[0].id)
  })

  it('rejects duplicating a job that does not exist', () => {
    expect(() => duplicateJob(db, 'missing')).toThrow(/not found/)
  })
})

describe('issueQuote', () => {
  it('freezes totals matching pricing.ts', () => {
    const job = aJob()
    saveJob(db, job)
    const expected = computeCosts(job)

    issueQuote(db, job.id)

    const t = getQuoteTotals(db, job.id)!
    expect(t.status).toBe('sent')
    expect(t.frozenAt).not.toBeNull()
    expect(t.total).toBeCloseTo(expected.total, 2)
    expect(t.totalIva).toBeCloseTo(expected.iva, 2)
    expect(t.totalPreTax).toBeCloseTo(expected.jobPreTax, 2)
  })

  it('keeps frozen totals when the filament price later changes', () => {
    const fid = createFilament(db, { brand: 'P', type: 'PLA', color: 'N', hex: '#000000', pricePerKg: 440 })
    const job = aJob({
      jobFilaments: [{ id: crypto.randomUUID(), filamentId: fid, material: 'P PLA', color: 'N', weight: 500, pricePerKg: 440 }],
    })
    saveJob(db, job)
    issueQuote(db, job.id, 'accepted')
    const frozen = getQuoteTotals(db, job.id)!.total

    updateFilamentPrice(db, fid, 1200)

    expect(getQuoteTotals(db, job.id)!.total).toBe(frozen)
  })

  it('a draft has no frozen totals', () => {
    const job = aJob()
    saveJob(db, job)
    const t = getQuoteTotals(db, job.id)!
    expect(t.status).toBe('draft')
    expect(t.total).toBeNull()
    expect(t.frozenAt).toBeNull()
  })

  it('rejects issuing a job that does not exist', () => {
    expect(() => issueQuote(db, 'missing')).toThrow(/not found/)
  })

  it('records the IVA amount separately so it can be reported to SAT', () => {
    // Every cost except packaging is zeroed so the IVA arithmetic is isolated.
    const job = aJob({
      ivaEnabled: true, marginPercent: 0, packagingCost: 1000, finishingCost: 0, quantity: 1,
      jobFilaments: [], laborStages: [], printTimeHours: 0, powerWatts: 0,
    })
    saveJob(db, job)
    issueQuote(db, job.id)
    const t = getQuoteTotals(db, job.id)!
    expect(t.totalPreTax).toBe(1000)
    expect(t.totalIva).toBe(160)
    expect(t.total).toBe(1160)
  })
})
