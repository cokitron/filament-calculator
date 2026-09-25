/** Whether a labor stage is billed once per job or once per unit produced. */
export type LaborScope = "per_job" | "per_unit";

export interface LaborStage {
  name: string;
  hours: number;
  rate: number;
  /**
   * Setup-type work (slicing, plating, first-layer babysitting) is 'per_job'
   * and charged once. Hands-on-each-part work (sanding, painting) is
   * 'per_unit'. Omitted on records saved before this field existed, which are
   * treated as 'per_unit'.
   */
  scope?: LaborScope;
}

export interface Filament {
  id: string;
  brand: string;
  type: string;
  color: string;
  hex: string;
  /** Cost per kilogram in MXN. */
  pricePerKg: number;
}

export interface JobFilament {
  id: string;
  filamentId?: string;
  material: string;
  color: string;
  weight: number;
  /**
   * MXN per kilogram, snapshotted when the job was quoted. Deliberately a copy
   * rather than a live lookup: raising a filament's price must not retroactively
   * rewrite the cost of jobs already quoted.
   */
  pricePerKg: number;
}

export interface PrintJob {
  id: string;
  name: string;
  client: string;
  status: "queued" | "printing" | "done" | "cancelled";
  jobFilaments: JobFilament[];
  printTimeHours: number;
  powerWatts: number;
  /** MXN per kWh. */
  electricityRate: number;
  laborStages: LaborStage[];
  packagingCost: number;
  finishingCost: number;
  marginPercent: number;
  quantity: number;
  /**
   * Whether to add IVA to this job's total. Optional per job; absent on records
   * saved before IVA support, which are treated as not taxed.
   */
  ivaEnabled?: boolean;
  /** Selected printer's id, or undefined if no printer was chosen. */
  printerId?: string;
  /**
   * MXN/hour, snapshotted from the selected printer's Machine_Rate at save
   * time. 0 when no printer was selected. Never recomputed from a live join —
   * editing or deactivating the printer later must not change this job's cost,
   * for the same reason jobFilaments[].pricePerKg is a snapshot.
   */
  machineRate?: number;
  notes: string;
  createdAt: string;
}

/** Lifecycle state of a Printer. Deactivated printers keep their history but drop out of selection for new jobs. */
export type PrinterStatus = "active" | "maintenance" | "retired";

export interface Printer {
  id: string;
  name: string;
  model: string | null;
  powerWatts: number;
  purchaseCost: number;
  amortizationHours: number;
  maintenanceCostPerHour: number;
  status: PrinterStatus;
}
