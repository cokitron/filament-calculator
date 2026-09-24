import { SqlExecutor, SqlParam, nowIso, toDbBool, fromDbBool, roundMoney } from './types'
import { Filament, PrintJob, LaborStage, JobFilament, LaborScope } from '../types'
import { computeCosts } from '../pricing'

/**
 * All database reads and writes. Written against SqlExecutor rather than any
 * specific engine, so these exact functions are what the test suite exercises
 * under node:sqlite and what the app runs under sqlite-wasm.
 *
 * Nothing here calculates money. src/pricing.ts is the only place that does;
 * this layer stores its inputs and, when a quote is issued, its frozen output.
 */

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export interface Settings {
  businessName: string | null
  rfc: string | null
  currency: string
  electricityRate: number
  defaultMarkupPercent: number
  defaultIvaEnabled: boolean
  ivaRate: number
  failureRatePercent: number
  quoteValidityDays: number
}

export function getSettings(db: SqlExecutor): Settings {
  const row = db.get<Record<string, unknown>>('select * from settings where id = 1')
  if (!row) throw new Error('settings row missing; call ensureSettings first')
  return {
    businessName: (row.business_name as string) ?? null,
    rfc: (row.rfc as string) ?? null,
    currency: row.currency as string,
    electricityRate: row.electricity_rate as number,
    defaultMarkupPercent: row.default_markup_percent as number,
    defaultIvaEnabled: fromDbBool(row.default_iva_enabled),
    ivaRate: row.iva_rate as number,
    failureRatePercent: row.failure_rate_percent as number,
    quoteValidityDays: row.quote_validity_days as number,
  }
}

export function updateSettings(db: SqlExecutor, patch: Partial<Settings>): void {
  const columns: Record<keyof Settings, string> = {
    businessName: 'business_name',
    rfc: 'rfc',
    currency: 'currency',
    electricityRate: 'electricity_rate',
    defaultMarkupPercent: 'default_markup_percent',
    defaultIvaEnabled: 'default_iva_enabled',
    ivaRate: 'iva_rate',
    failureRatePercent: 'failure_rate_percent',
    quoteValidityDays: 'quote_validity_days',
  }

  const sets: string[] = []
  const params: (string | number | null)[] = []
  for (const [key, column] of Object.entries(columns) as [keyof Settings, string][]) {
    if (!(key in patch)) continue
    const value = patch[key]
    sets.push(`${column} = ?`)
    params.push(typeof value === 'boolean' ? toDbBool(value) : (value as string | number | null))
  }
  if (sets.length === 0) return

  sets.push('updated_at = ?')
  params.push(nowIso())
  db.run(`update settings set ${sets.join(', ')} where id = 1`, params)
}

// ---------------------------------------------------------------------------
// Filaments (catalog)
// ---------------------------------------------------------------------------

export function listFilaments(db: SqlExecutor, includeInactive = false): Filament[] {
  const rows = db.all<Record<string, unknown>>(
    `select id, brand, type, color, hex, price_per_kg from filaments
     ${includeInactive ? '' : 'where is_active = 1'}
     order by brand, type, color`,
  )
  return rows.map(r => ({
    id: r.id as string,
    brand: r.brand as string,
    type: r.type as string,
    color: r.color as string,
    hex: (r.hex as string) ?? '#ffffff',
    pricePerKg: r.price_per_kg as number,
  }))
}

export function createFilament(db: SqlExecutor, f: Omit<Filament, 'id'> & { id?: string }): string {
  const id = f.id ?? crypto.randomUUID()
  const ts = nowIso()
  db.run(
    `insert into filaments (id, brand, type, color, hex, price_per_kg, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, f.brand, f.type, f.color, f.hex || null, f.pricePerKg, ts, ts],
  )
  return id
}

export function updateFilamentPrice(db: SqlExecutor, id: string, pricePerKg: number): void {
  // Only the catalog price changes. Quotes hold their own snapshot, so this
  // cannot alter the cost of anything already quoted.
  db.run('update filaments set price_per_kg = ?, updated_at = ? where id = ?', [
    pricePerKg,
    nowIso(),
    id,
  ])
}

/**
 * Retire a filament rather than deleting it. A hard delete would be blocked by
 * any spool referencing it, and would strip the catalog link from historical
 * jobs. Deactivating keeps history intact and hides it from new quotes.
 */
export function deactivateFilament(db: SqlExecutor, id: string): void {
  db.run('update filaments set is_active = 0, updated_at = ? where id = ?', [nowIso(), id])
}

// ---------------------------------------------------------------------------
// Customers
// ---------------------------------------------------------------------------

export interface Customer {
  id: string
  name: string
  email: string | null
  phone: string | null
}

export function listCustomers(db: SqlExecutor): Customer[] {
  return db
    .all<Record<string, unknown>>(
      'select id, name, email, phone from customers where is_active = 1 order by name',
    )
    .map(r => ({
      id: r.id as string,
      name: r.name as string,
      email: (r.email as string) ?? null,
      phone: (r.phone as string) ?? null,
    }))
}

/**
 * Find a customer by name, or create one. Matching is case- and
 * whitespace-insensitive to line up with the unique index, so importing the
 * old free-text client strings collapses duplicates instead of failing.
 */
export function findOrCreateCustomer(db: SqlExecutor, name: string): string | null {
  const trimmed = name.trim()
  if (!trimmed) return null

  const existing = db.get<{ id: string }>(
    'select id from customers where lower(trim(name)) = lower(trim(?))',
    [trimmed],
  )
  if (existing) return existing.id

  const id = crypto.randomUUID()
  const ts = nowIso()
  db.run('insert into customers (id, name, created_at, updated_at) values (?, ?, ?, ?)', [
    id,
    trimmed,
    ts,
    ts,
  ])
  return id
}

// ---------------------------------------------------------------------------
// Quotes and jobs
//
// The app's PrintJob type is a flat structure that predates the quote/job
// split. One PrintJob maps to one quote holding one job, which keeps the
// existing UI working while the normalised tables underneath allow a quote to
// grow several jobs later without another migration.
// ---------------------------------------------------------------------------

function nextFolio(db: SqlExecutor): number {
  const row = db.get<{ next: number }>('select coalesce(max(folio), 0) + 1 as next from quotes')
  return row?.next ?? 1
}

/** Persist a PrintJob as a quote plus its job, materials and labor stages. */
export function saveJob(db: SqlExecutor, job: PrintJob): string {
  return db.transaction(() => {
    const ts = nowIso()
    const customerId = findOrCreateCustomer(db, job.client)
    const existing = db.get<{ quote_id: string }>('select quote_id from jobs where id = ?', [job.id])

    let quoteId: string
    if (existing) {
      quoteId = existing.quote_id
      db.run(
        `update quotes set customer_id = ?, iva_enabled = ?, markup_percent = ?,
                           electricity_rate = ?, notes = ?, updated_at = ?
         where id = ?`,
        [
          customerId,
          toDbBool(job.ivaEnabled),
          job.marginPercent,
          job.electricityRate,
          job.notes ?? null,
          ts,
          quoteId,
        ],
      )
      db.run(
        `update jobs set name = ?, quantity = ?, print_time_hours = ?, power_watts = ?,
                         packaging_cost = ?, finishing_cost = ?, status = ?, notes = ?, updated_at = ?
         where id = ?`,
        [
          job.name,
          job.quantity,
          job.printTimeHours,
          job.powerWatts,
          job.packagingCost,
          job.finishingCost,
          job.status,
          job.notes ?? null,
          ts,
          job.id,
        ],
      )
      // Child rows are replaced wholesale. Diffing them would add ordering and
      // identity bugs for no benefit at this size.
      db.run('delete from job_materials where job_id = ?', [job.id])
      db.run('delete from job_labor_stages where job_id = ?', [job.id])
    } else {
      quoteId = crypto.randomUUID()
      db.run(
        `insert into quotes (id, customer_id, folio, status, iva_enabled, markup_percent,
                             electricity_rate, notes, created_at, updated_at)
         values (?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?)`,
        [
          quoteId,
          customerId,
          nextFolio(db),
          toDbBool(job.ivaEnabled),
          job.marginPercent,
          job.electricityRate,
          job.notes ?? null,
          job.createdAt || ts,
          ts,
        ],
      )
      db.run(
        `insert into jobs (id, quote_id, name, quantity, print_time_hours, power_watts,
                           packaging_cost, finishing_cost, status, notes, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          job.id,
          quoteId,
          job.name,
          job.quantity,
          job.printTimeHours,
          job.powerWatts,
          job.packagingCost,
          job.finishingCost,
          job.status,
          job.notes ?? null,
          job.createdAt || ts,
          ts,
        ],
      )
    }

    ;(job.jobFilaments ?? []).forEach((m, i) => {
      db.run(
        `insert into job_materials (id, job_id, filament_id, material_label, color_label,
                                    grams, price_per_kg, sort_order, created_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          m.id || crypto.randomUUID(),
          job.id,
          m.filamentId || null,
          m.material ?? '',
          m.color ?? '',
          m.weight ?? 0,
          m.pricePerKg ?? 0,
          i,
          ts,
        ],
      )
    })

    ;(job.laborStages ?? []).forEach((s, i) => {
      db.run(
        `insert into job_labor_stages (id, job_id, name, hours, rate, scope, sort_order, created_at)
         values (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          crypto.randomUUID(),
          job.id,
          s.name ?? '',
          s.hours ?? 0,
          s.rate ?? 0,
          s.scope ?? 'per_unit',
          i,
          ts,
        ],
      )
    })

    return job.id
  })
}

/**
 * Job statuses that mean the work is over and the record belongs to history
 * rather than the queue. Finishing a job freezes its totals; see
 * updateJobStatus.
 */
export const TERMINAL_JOB_STATUSES = ['done', 'cancelled'] as const

export function isTerminalStatus(status: string): boolean {
  return (TERMINAL_JOB_STATUSES as readonly string[]).includes(status)
}

interface JobFilter {
  jobId?: string
  statuses?: readonly PrintJob['status'][]
}

/** Build the shared `where` clause so jobs and their children agree on scope. */
function jobWhere(filter: JobFilter): { clause: string; params: SqlParam[] } {
  const conditions: string[] = []
  const params: SqlParam[] = []

  if (filter.jobId) {
    conditions.push('j.id = ?')
    params.push(filter.jobId)
  }
  if (filter.statuses && filter.statuses.length > 0) {
    conditions.push(`j.status in (${filter.statuses.map(() => '?').join(', ')})`)
    params.push(...filter.statuses)
  }

  return { clause: conditions.length > 0 ? `where ${conditions.join(' and ')}` : '', params }
}

/** Read jobs back as the flat PrintJob shape the UI already expects. */
function readJobs(db: SqlExecutor, filter: JobFilter = {}): PrintJob[] {
  const { clause, params } = jobWhere(filter)

  const jobRows = db.all<Record<string, unknown>>(
    `select j.*, q.iva_enabled, q.markup_percent, q.electricity_rate,
            coalesce(c.name, '') as client
     from jobs j
     join quotes q on q.id = j.quote_id
     left join customers c on c.id = q.customer_id
     ${clause}
     order by j.created_at desc`,
    params,
  )
  if (jobRows.length === 0) return []

  // Fetch all children in two queries rather than one per job, so a queue of
  // 500 jobs is 3 queries instead of 1001. The subquery repeats the filter so a
  // single-job read does not drag every other job's children along with it.
  const childScope = `where job_id in (select j.id from jobs j ${clause})`
  const materials = db.all<Record<string, unknown>>(
    `select * from job_materials ${childScope} order by job_id, sort_order`,
    params,
  )
  const stages = db.all<Record<string, unknown>>(
    `select * from job_labor_stages ${childScope} order by job_id, sort_order`,
    params,
  )

  const materialsByJob = new Map<string, JobFilament[]>()
  for (const m of materials) {
    const jobId = m.job_id as string
    const list = materialsByJob.get(jobId) ?? []
    list.push({
      id: m.id as string,
      filamentId: (m.filament_id as string) ?? undefined,
      material: m.material_label as string,
      color: m.color_label as string,
      weight: m.grams as number,
      pricePerKg: m.price_per_kg as number,
    })
    materialsByJob.set(jobId, list)
  }

  const stagesByJob = new Map<string, LaborStage[]>()
  for (const s of stages) {
    const jobId = s.job_id as string
    const list = stagesByJob.get(jobId) ?? []
    list.push({
      name: s.name as string,
      hours: s.hours as number,
      rate: s.rate as number,
      scope: s.scope as LaborScope,
    })
    stagesByJob.set(jobId, list)
  }

  return jobRows.map(r => {
    const id = r.id as string
    return {
      id,
      name: r.name as string,
      client: r.client as string,
      status: r.status as PrintJob['status'],
      jobFilaments: materialsByJob.get(id) ?? [],
      printTimeHours: r.print_time_hours as number,
      powerWatts: r.power_watts as number,
      electricityRate: r.electricity_rate as number,
      laborStages: stagesByJob.get(id) ?? [],
      packagingCost: r.packaging_cost as number,
      finishingCost: r.finishing_cost as number,
      marginPercent: r.markup_percent as number,
      quantity: r.quantity as number,
      ivaEnabled: fromDbBool(r.iva_enabled),
      notes: (r.notes as string) ?? '',
      createdAt: r.created_at as string,
    }
  })
}

/** Every job, newest first. */
export function listJobs(db: SqlExecutor): PrintJob[] {
  return readJobs(db)
}

/** Only work still in progress — what the queue screen shows. */
export function listActiveJobs(db: SqlExecutor): PrintJob[] {
  return readJobs(db, { statuses: ['queued', 'printing'] })
}

export function getJob(db: SqlExecutor, jobId: string): PrintJob | undefined {
  return readJobs(db, { jobId })[0]
}

export function updateJobStatus(db: SqlExecutor, jobId: string, status: PrintJob['status']): void {
  db.transaction(() => {
    const row = db.get<{ status: string; started_at: string | null; completed_at: string | null }>(
      'select status, started_at, completed_at from jobs where id = ?',
      [jobId],
    )
    if (!row) return

    const ts = nowIso()
    const wasTerminal = isTerminalStatus(row.status)
    const isTerminal = isTerminalStatus(status)

    // First time it starts printing is the start of the run; later re-starts do
    // not overwrite it, or the elapsed time of a job would reset on every fix.
    const startedAt = status === 'printing' ? (row.started_at ?? ts) : row.started_at
    // Reopening a finished job clears the completion stamp, so history only
    // ever contains work that actually ended.
    const completedAt = isTerminal ? (row.completed_at ?? ts) : null

    db.run(
      'update jobs set status = ?, started_at = ?, completed_at = ?, updated_at = ? where id = ?',
      [status, startedAt, completedAt, ts, jobId],
    )

    if (isTerminal && !wasTerminal) {
      // Finishing the work is what turns a live estimate into a historical
      // record, so the numbers are frozen here. Without this, next month's
      // filament price increase would silently rewrite what last month's jobs
      // "cost", and the history would be worthless for comparison.
      freezeQuote(db, jobId, status === 'done' ? 'accepted' : 'cancelled')
    } else if (wasTerminal && !isTerminal) {
      unfreezeQuote(db, jobId)
    }
  })
}

/** Delete a job, and the quote with it when no sibling jobs remain. */
export function deleteJob(db: SqlExecutor, jobId: string, opts: { force?: boolean } = {}): void {
  db.transaction(() => {
    const row = db.get<{ quote_id: string; status: string }>(
      'select quote_id, status from jobs where id = ?',
      [jobId],
    )
    if (!row) return

    // Finished work is the permanent record of what the shop has produced and
    // charged. Deleting it is still possible, but never by accident: the caller
    // has to say so explicitly after confirming with the user.
    if (!opts.force && isTerminalStatus(row.status)) {
      throw new Error(
        `Job ${jobId} is part of the work history (status "${row.status}"). ` +
          'Deleting it would destroy that record; pass { force: true } to override.',
      )
    }

    db.run('delete from jobs where id = ?', [jobId])
    const siblings = db.get<{ n: number }>('select count(*) as n from jobs where quote_id = ?', [
      row.quote_id,
    ])
    if ((siblings?.n ?? 0) === 0) {
      db.run('delete from quotes where id = ?', [row.quote_id])
    }
  })
}

/**
 * Copy a past job into a new queued one: same materials, labor and markup, new
 * identity and folio.
 *
 * This is the point of keeping history — repeat orders are re-quoted from what
 * was actually charged last time instead of being rebuilt from memory. Prices
 * are copied as they were, so the old and new quote are comparable; edit the
 * copy in the calculator to bring it up to today's costs.
 */
export function duplicateJob(db: SqlExecutor, jobId: string, name?: string): string {
  const source = getJob(db, jobId)
  if (!source) throw new Error(`job ${jobId} not found`)

  const copy: PrintJob = {
    ...source,
    id: crypto.randomUUID(),
    name: name ?? `${source.name} (REPETICIÓN)`,
    status: 'queued',
    createdAt: nowIso(),
    // New child identities: reusing them would make saveJob write rows that
    // collide with the originals' primary keys.
    jobFilaments: (source.jobFilaments ?? []).map(m => ({ ...m, id: crypto.randomUUID() })),
    laborStages: (source.laborStages ?? []).map(s => ({ ...s })),
  }

  saveJob(db, copy)
  return copy.id
}

/**
 * Write pricing.ts's output onto the quote and take it out of draft.
 *
 * Runs inside the caller's transaction — SqlExecutor.transaction cannot nest —
 * so both issueQuote and updateJobStatus can reuse it.
 *
 * A quote that already carries frozen totals keeps them unless `refreeze` is
 * set. Marking a job done must not recompute what the customer was already
 * quoted; only a deliberate re-issue may do that.
 */
function freezeQuote(
  db: SqlExecutor,
  jobId: string,
  status: 'sent' | 'accepted' | 'rejected' | 'cancelled',
  opts: { refreeze?: boolean } = {},
): void {
  const row = db.get<{ quote_id: string; frozen_at: string | null }>(
    `select j.quote_id, q.frozen_at from jobs j join quotes q on q.id = j.quote_id
     where j.id = ?`,
    [jobId],
  )
  if (!row) throw new Error(`job ${jobId} not found`)

  const ts = nowIso()
  const decided = status === 'sent' ? null : ts

  if (row.frozen_at && !opts.refreeze) {
    db.run(
      `update quotes set status = ?, decided_at = coalesce(decided_at, ?), updated_at = ?
       where id = ?`,
      [status, decided, ts, row.quote_id],
    )
    return
  }

  const job = getJob(db, jobId)
  if (!job) throw new Error(`job ${jobId} not found`)
  const costs = computeCosts(job)

  db.run(
    `update quotes set status = ?, total_pre_tax = ?, total_iva = ?, total = ?,
                       frozen_at = ?, sent_at = coalesce(sent_at, ?),
                       decided_at = coalesce(decided_at, ?), updated_at = ?
     where id = ?`,
    [
      status,
      roundMoney(costs.jobPreTax),
      roundMoney(costs.iva),
      roundMoney(costs.total),
      ts,
      // Only an explicit send stamps sent_at. Completing a job that was never
      // formally quoted must not claim it was, because sent_at is what tells
      // a correctable internal record apart from a price given to a customer.
      status === 'sent' ? ts : null,
      decided,
      ts,
      row.quote_id,
    ],
  )
}

/**
 * Return a quote to draft after its job was reopened, so completing it again
 * freezes the corrected numbers rather than keeping a stale total.
 *
 * Restricted to quotes that were never sent. Once a price has gone to a
 * customer it is a commitment, and reopening the print is a production
 * decision that must not quietly rewrite it. An unsent quote has no such
 * weight, so an accidental "done" click stays correctable.
 */
function unfreezeQuote(db: SqlExecutor, jobId: string): void {
  db.run(
    `update quotes set status = 'draft', total_pre_tax = null, total_iva = null, total = null,
                       frozen_at = null, decided_at = null, updated_at = ?
     where id = (select quote_id from jobs where id = ?)
       and sent_at is null
       and status in ('accepted', 'cancelled')`,
    [nowIso(), jobId],
  )
}

/**
 * Move a quote out of draft, freezing the totals that pricing.ts computed.
 *
 * After this the numbers are a historical record: later changes to filament
 * prices, labor rates or the IVA rate must not alter what the customer was
 * quoted. The schema enforces that a non-draft quote carries these totals.
 */
export function issueQuote(
  db: SqlExecutor,
  jobId: string,
  status: 'sent' | 'accepted' | 'rejected' = 'sent',
): void {
  db.transaction(() => freezeQuote(db, jobId, status, { refreeze: true }))
}

export interface FrozenTotals {
  folio: number
  status: string
  totalPreTax: number | null
  totalIva: number | null
  total: number | null
  frozenAt: string | null
}

export function getQuoteTotals(db: SqlExecutor, jobId: string): FrozenTotals | undefined {
  const row = db.get<Record<string, unknown>>(
    `select q.folio, q.status, q.total_pre_tax, q.total_iva, q.total, q.frozen_at
     from quotes q join jobs j on j.quote_id = q.id where j.id = ?`,
    [jobId],
  )
  if (!row) return undefined
  return {
    folio: row.folio as number,
    status: row.status as string,
    totalPreTax: (row.total_pre_tax as number) ?? null,
    totalIva: (row.total_iva as number) ?? null,
    total: (row.total as number) ?? null,
    frozenAt: (row.frozen_at as string) ?? null,
  }
}

// ---------------------------------------------------------------------------
// Work history
//
// The permanent record of jobs the shop has actually produced. Separate from
// the queue so finished work stops competing for attention with work in
// progress, and so it can never be edited away by accident.
// ---------------------------------------------------------------------------

export interface JobHistoryEntry {
  /** The job exactly as it was priced, with its snapshotted material costs. */
  job: PrintJob
  folio: number
  quoteStatus: string
  startedAt: string | null
  completedAt: string | null
  /**
   * The invoice figures as they stood when the job finished. Null only for
   * records that predate freezing, where the UI falls back to recomputing from
   * the job's own snapshotted inputs.
   */
  frozen: { totalPreTax: number; totalIva: number; total: number; frozenAt: string } | null
}

/**
 * Every finished job, most recently completed first.
 *
 * No aggregation happens here: pricing.ts owns all money arithmetic and a
 * parallel SUM() in SQL would eventually disagree with it.
 */
export function listJobHistory(db: SqlExecutor): JobHistoryEntry[] {
  const jobs = readJobs(db, { statuses: TERMINAL_JOB_STATUSES })
  if (jobs.length === 0) return []

  const meta = db.all<Record<string, unknown>>(
    `select j.id as job_id, j.started_at, j.completed_at,
            q.folio, q.status as quote_status,
            q.total_pre_tax, q.total_iva, q.total, q.frozen_at
     from jobs j join quotes q on q.id = j.quote_id
     where j.status in (${TERMINAL_JOB_STATUSES.map(() => '?').join(', ')})`,
    [...TERMINAL_JOB_STATUSES],
  )
  const metaByJob = new Map(meta.map(m => [m.job_id as string, m]))

  return jobs
    .map(job => {
      const m = metaByJob.get(job.id)
      const frozenAt = (m?.frozen_at as string) ?? null
      return {
        job,
        folio: (m?.folio as number) ?? 0,
        quoteStatus: (m?.quote_status as string) ?? 'draft',
        startedAt: (m?.started_at as string) ?? null,
        completedAt: (m?.completed_at as string) ?? null,
        frozen:
          frozenAt && m?.total != null
            ? {
                totalPreTax: (m.total_pre_tax as number) ?? 0,
                totalIva: (m.total_iva as number) ?? 0,
                total: m.total as number,
                frozenAt,
              }
            : null,
      }
    })
    // Completion order, not creation order: history reads as a log of when work
    // came off the printer. Records with no stamp (finished before this was
    // tracked) fall back to creation time.
    .sort((a, b) => {
      const at = a.completedAt ?? a.job.createdAt
      const bt = b.completedAt ?? b.job.createdAt
      return bt.localeCompare(at)
    })
}
