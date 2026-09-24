import { PrintJob } from './types'

/**
 * Single source of truth for all money math.
 *
 * Every cost figure shown in the UI and every total persisted to the database
 * must come from computeCosts(). Do not re-implement any part of this
 * calculation elsewhere — divergent copies were the original source of the
 * header/queue totals disagreeing with each other.
 */

/** Mexican IVA (Impuesto al Valor Agregado). */
export const IVA_RATE = 0.16

export interface CostBreakdown {
  /** Material cost for one unit. */
  filament: number
  /** Energy cost for one unit. */
  electricity: number
  /** Labor that repeats for every unit (sanding, painting, assembly). */
  laborPerUnit: number
  /** Labor charged once for the whole job (slicing, setup, plating). */
  laborPerJob: number
  /** Packaging + finishing, per unit. */
  overhead: number

  /** Per-unit cost before margin. */
  unitSubtotal: number
  /** Margin amount earned on one unit. */
  unitMargin: number
  /** Sale price of one unit, before IVA. */
  unitPrice: number

  /** Cost of the whole job before margin, including per-job labor. */
  jobSubtotal: number
  /** Sale price of the whole job before IVA. */
  jobPreTax: number
  /** IVA charged, or 0 when the job has IVA switched off. */
  iva: number
  /** Final amount the customer pays. */
  total: number
}

/**
 * Labor stages saved before the per_job/per_unit distinction existed have no
 * `scope`. They are treated as per-unit, which is exactly how the old
 * calculation behaved, so historical job totals do not silently change.
 */
function isPerJob(scope: string | undefined): boolean {
  return scope === 'per_job'
}

export function computeCosts(job: PrintJob): CostBreakdown {
  const quantity = Math.max(1, job.quantity || 1)
  const marginRate = (job.marginPercent || 0) / 100

  // --- Per-unit costs ---
  const filament = (job.jobFilaments || []).reduce(
    (sum, f) => sum + ((f.weight || 0) / 1000) * (f.pricePerKg || 0),
    0,
  )

  const electricity =
    (job.printTimeHours || 0) * ((job.powerWatts || 0) / 1000) * (job.electricityRate || 0)

  const stages = job.laborStages || []
  const laborPerUnit = stages
    .filter(s => !isPerJob(s.scope))
    .reduce((sum, s) => sum + (s.hours || 0) * (s.rate || 0), 0)

  const overhead = (job.packagingCost || 0) + (job.finishingCost || 0)

  const unitSubtotal = filament + electricity + laborPerUnit + overhead
  const unitMargin = unitSubtotal * marginRate
  const unitPrice = unitSubtotal + unitMargin

  // --- Whole-job costs ---
  // Setup-type labor is charged once no matter how many units are printed.
  const laborPerJob = stages
    .filter(s => isPerJob(s.scope))
    .reduce((sum, s) => sum + (s.hours || 0) * (s.rate || 0), 0)

  const jobSubtotal = unitSubtotal * quantity + laborPerJob

  // Margin applies to per-job labor too: it is a cost like any other.
  const jobPreTax = unitPrice * quantity + laborPerJob * (1 + marginRate)

  // IVA is a tax on the sale price, charged after margin — never folded into
  // the cost base, or the margin would be calculated on top of the tax.
  const iva = job.ivaEnabled ? jobPreTax * IVA_RATE : 0
  const total = jobPreTax + iva

  return {
    filament,
    electricity,
    laborPerUnit,
    laborPerJob,
    overhead,
    unitSubtotal,
    unitMargin,
    unitPrice,
    jobSubtotal,
    jobPreTax,
    iva,
    total,
  }
}

const mxn = new Intl.NumberFormat('es-MX', {
  style: 'currency',
  currency: 'MXN',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

/** Format a peso amount for display, e.g. 1234.5 -> "$1,234.50". */
export function formatMXN(amount: number): string {
  return mxn.format(Number.isFinite(amount) ? amount : 0)
}

const mxnPrecise = new Intl.NumberFormat('es-MX', {
  style: 'currency',
  currency: 'MXN',
  minimumFractionDigits: 2,
  maximumFractionDigits: 3,
})

/**
 * Format small per-unit amounts where rounding to centavos hides the value,
 * such as material cost for a few grams of filament.
 */
export function formatMXNPrecise(amount: number): string {
  return mxnPrecise.format(Number.isFinite(amount) ? amount : 0)
}
