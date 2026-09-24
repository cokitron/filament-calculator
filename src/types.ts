/** Whether a labor stage is billed once per job or once per unit produced. */
export type LaborScope = 'per_job' | 'per_unit'

export interface LaborStage {
  name: string
  hours: number
  rate: number
  /**
   * Setup-type work (slicing, plating, first-layer babysitting) is 'per_job'
   * and charged once. Hands-on-each-part work (sanding, painting) is
   * 'per_unit'. Omitted on records saved before this field existed, which are
   * treated as 'per_unit'.
   */
  scope?: LaborScope
}

export interface Filament {
  id: string
  brand: string
  type: string
  color: string
  hex: string
  /** Cost per kilogram in MXN. */
  pricePerKg: number
}

export interface JobFilament {
  id: string
  filamentId?: string
  material: string
  color: string
  weight: number
  /**
   * MXN per kilogram, snapshotted when the job was quoted. Deliberately a copy
   * rather than a live lookup: raising a filament's price must not retroactively
   * rewrite the cost of jobs already quoted.
   */
  pricePerKg: number
}

export interface PrintJob {
  id: string
  name: string
  client: string
  status: 'queued' | 'printing' | 'done' | 'cancelled'
  jobFilaments: JobFilament[]
  printTimeHours: number
  powerWatts: number
  /** MXN per kWh. */
  electricityRate: number
  laborStages: LaborStage[]
  packagingCost: number
  finishingCost: number
  marginPercent: number
  quantity: number
  /**
   * Whether to add IVA to this job's total. Optional per job; absent on records
   * saved before IVA support, which are treated as not taxed.
   */
  ivaEnabled?: boolean
  notes: string
  createdAt: string
}
