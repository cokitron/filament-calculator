import { PrintJob, Printer } from "./types";
import type { Settings } from "./db/repository";

/**
 * Single source of truth for all money math.
 *
 * Every cost figure shown in the UI and every total persisted to the database
 * must come from computeCosts(). Do not re-implement any part of this
 * calculation elsewhere — divergent copies were the original source of the
 * header/queue totals disagreeing with each other.
 */

/** Mexican IVA (Impuesto al Valor Agregado). */
export const IVA_RATE = 0.16;

export interface CostBreakdown {
  /** Material cost for one unit. */
  filament: number;
  /** Energy cost for one unit. */
  electricity: number;
  /** Machine depreciation + maintenance cost for one unit. */
  machine: number;
  /** Labor that repeats for every unit (sanding, painting, assembly). */
  laborPerUnit: number;
  /** Labor charged once for the whole job (slicing, setup, plating). */
  laborPerJob: number;
  /** Packaging + finishing, per unit. */
  overhead: number;

  /**
   * `filament + machine + electricity`, divided by `(1 - failureRate)` when a
   * failure rate is set. Excludes labor, packaging and finishing — those never
   * get reserved against failed prints.
   */
  failureAdjustedSubtotal: number;

  /** Per-unit cost before margin. */
  unitSubtotal: number;
  /** Margin amount earned on one unit. */
  unitMargin: number;
  /** Sale price of one unit, before IVA. */
  unitPrice: number;

  /** Cost of the whole job before margin, including per-job labor. */
  jobSubtotal: number;
  /** Sale price of the whole job before IVA. */
  jobPreTax: number;
  /** IVA charged, or 0 when the job has IVA switched off. */
  iva: number;
  /** Final amount the customer pays. */
  total: number;
}

/**
 * Labor stages saved before the per_job/per_unit distinction existed have no
 * `scope`. They are treated as per-unit, which is exactly how the old
 * calculation behaved, so historical job totals do not silently change.
 */
function isPerJob(scope: string | undefined): boolean {
  return scope === "per_job";
}

/**
 * MXN/hour: depreciation plus maintenance. Not tied to any one job — used both
 * to snapshot a job's `machineRate` at printer-selection time and to preview
 * the rate live in the Shop Settings printer form before saving.
 */
export function machineRate(
  printer: Pick<
    Printer,
    "purchaseCost" | "amortizationHours" | "maintenanceCostPerHour"
  >,
): number {
  return (
    printer.purchaseCost / printer.amortizationHours +
    printer.maintenanceCostPerHour
  );
}

export function computeCosts(
  job: PrintJob,
  settings?: Pick<Settings, "failureRatePercent" | "minimumOrder">,
): CostBreakdown {
  const quantity = Math.max(1, job.quantity || 1);
  const marginRate = (job.marginPercent || 0) / 100;
  const failureRate = (settings?.failureRatePercent ?? 0) / 100;
  const minimumOrder = settings?.minimumOrder ?? 0;

  // --- Per-unit costs ---
  const filament = (job.jobFilaments || []).reduce(
    (sum, f) => sum + ((f.weight || 0) / 1000) * (f.pricePerKg || 0),
    0,
  );

  const electricity =
    (job.printTimeHours || 0) *
    ((job.powerWatts || 0) / 1000) *
    (job.electricityRate || 0);

  // Machine cost defaults to 0 for a job with no snapshotted printer (including
  // every job saved before this feature existed), reproducing today's behavior
  // exactly.
  const machine = (job.printTimeHours || 0) * (job.machineRate || 0);

  // Failure reserve applies only to filament + machine + electricity, never
  // labor/packaging/finishing, and is a no-op divisor of 1 when there is no
  // failure rate set.
  const rawProductionCost = filament + machine + electricity;
  const failureAdjustedSubtotal =
    failureRate > 0 ? rawProductionCost / (1 - failureRate) : rawProductionCost;

  const stages = job.laborStages || [];
  const laborPerUnit = stages
    .filter((s) => !isPerJob(s.scope))
    .reduce((sum, s) => sum + (s.hours || 0) * (s.rate || 0), 0);

  const overhead = (job.packagingCost || 0) + (job.finishingCost || 0);

  const unitSubtotal = failureAdjustedSubtotal + laborPerUnit + overhead;
  const unitMargin = unitSubtotal * marginRate;
  const unitPrice = unitSubtotal + unitMargin;

  // --- Whole-job costs ---
  // Setup-type labor is charged once no matter how many units are printed.
  const laborPerJob = stages
    .filter((s) => isPerJob(s.scope))
    .reduce((sum, s) => sum + (s.hours || 0) * (s.rate || 0), 0);

  const jobSubtotal = unitSubtotal * quantity + laborPerJob;

  // Margin applies to per-job labor too: it is a cost like any other.
  const jobPreTax = unitPrice * quantity + laborPerJob * (1 + marginRate);

  // IVA is a tax on the sale price, charged after margin — never folded into
  // the cost base, or the margin would be calculated on top of the tax.
  const iva = job.ivaEnabled ? jobPreTax * IVA_RATE : 0;
  const preFloorTotal = jobPreTax + iva;

  // Minimum-order floor applies once, to the whole job's total, after IVA —
  // never per-unit, or it would double-apply once multiplied by quantity. A
  // no-op when minimumOrder is 0.
  const total = Math.max(preFloorTotal, minimumOrder);

  return {
    filament,
    electricity,
    machine,
    laborPerUnit,
    laborPerJob,
    overhead,
    failureAdjustedSubtotal,
    unitSubtotal,
    unitMargin,
    unitPrice,
    jobSubtotal,
    jobPreTax,
    iva,
    total,
  };
}

const mxn = new Intl.NumberFormat("es-MX", {
  style: "currency",
  currency: "MXN",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** Format a peso amount for display, e.g. 1234.5 -> "$1,234.50". */
export function formatMXN(amount: number): string {
  return mxn.format(Number.isFinite(amount) ? amount : 0);
}

const mxnPrecise = new Intl.NumberFormat("es-MX", {
  style: "currency",
  currency: "MXN",
  minimumFractionDigits: 2,
  maximumFractionDigits: 3,
});

/**
 * Format small per-unit amounts where rounding to centavos hides the value,
 * such as material cost for a few grams of filament.
 */
export function formatMXNPrecise(amount: number): string {
  return mxnPrecise.format(Number.isFinite(amount) ? amount : 0);
}
