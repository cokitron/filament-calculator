import { PrintJob, Filament, Printer, PrinterStatus } from "../types";
import type {
  Settings,
  Customer,
  FrozenTotals,
  JobHistoryEntry,
} from "./repository";
import { callLocal } from "./localTransport";
import {
  callRemote,
  fetchSession,
  loginRemote,
  logoutRemote,
  downloadBackupRemote,
  restoreBackupRemote,
  UnauthorizedError,
} from "./remoteTransport";

export type { JobHistoryEntry } from "./repository";
export { UnauthorizedError } from "./remoteTransport";

/**
 * The app's database API.
 *
 * There are two places the data can live, and exactly one of them is active:
 *
 *   local   SQLite in this browser, in OPFS, reached through a Worker. Offline,
 *           private, and per-device — two devices never see the same data.
 *   remote  SQLite on the server, on a persistent volume, behind a shared
 *           password. Shared across devices, and requires the network.
 *
 * The mode is a build-time decision (VITE_STORAGE_MODE), not runtime detection.
 * Guessing would risk writing a day's quotes into the wrong database, and the
 * static build — including the Figma Make preview, which has no server — must
 * keep working on OPFS.
 *
 * Every function below has the same signature in both modes, so components never
 * know which is in use.
 */

export type StorageMode = "local" | "remote";

export const STORAGE_MODE: StorageMode =
  import.meta.env.VITE_STORAGE_MODE === "remote" ? "remote" : "local";

const isRemote = STORAGE_MODE === "remote";

/** Route one op to whichever transport is active. */
const call = <T>(payload: Record<string, unknown>): Promise<T> =>
  isRemote ? callRemote<T>(payload) : callLocal<T>(payload);

export interface OpenResult {
  persistent: boolean;
  schema: { from: number; to: number };
}

let openPromise: Promise<OpenResult> | null = null;

/**
 * Prepare storage. Safe to call repeatedly: the work happens once and every
 * caller awaits the same promise.
 *
 * In remote mode there is nothing to open — the server did it at boot — but the
 * call is kept so the startup path is identical in both modes.
 */
export function openDatabase(): Promise<OpenResult> {
  if (isRemote) {
    return Promise.resolve({ persistent: true, schema: { from: 1, to: 1 } });
  }
  if (!openPromise) {
    openPromise = callLocal<OpenResult>({ op: "open" }).catch((err) => {
      // Clear the cache so a later retry can genuinely re-attempt rather than
      // replaying the failure forever.
      openPromise = null;
      throw err;
    });
  }
  return openPromise;
}

// --- Authentication ---------------------------------------------------------
//
// Local mode has no concept of a session: the data is already on the device and
// the browser profile is the only thing guarding it. These resolve accordingly
// so App.tsx does not need a branch for every call.

export async function getSession(): Promise<{ authenticated: boolean }> {
  if (!isRemote) return { authenticated: true };
  return fetchSession();
}

export async function login(password: string): Promise<void> {
  if (!isRemote) return;
  return loginRemote(password);
}

export async function logout(): Promise<void> {
  if (!isRemote) return;
  return logoutRemote();
}

// --- Jobs -------------------------------------------------------------------

export const listJobs = () => call<PrintJob[]>({ op: "listJobs" });
/** Work in progress only: queued and printing. */
export const listActiveJobs = () => call<PrintJob[]>({ op: "listActiveJobs" });
/** Finished work, most recently completed first. */
export const listJobHistory = () =>
  call<JobHistoryEntry[]>({ op: "listJobHistory" });
export const saveJob = (job: PrintJob) => call<string>({ op: "saveJob", job });
export const updateJobStatus = (jobId: string, status: PrintJob["status"]) =>
  call<void>({ op: "updateJobStatus", jobId, status });
/**
 * Delete a job. Rejects a finished job unless `force` is set, so the work
 * history cannot be thrown away by a stray click.
 */
export const deleteJob = (jobId: string, force = false) =>
  call<void>({ op: "deleteJob", jobId, force });
/** Re-quote a past job: copies it into a new queued job and returns its id. */
export const duplicateJob = (jobId: string, name?: string) =>
  call<string>({ op: "duplicateJob", jobId, name });
export const issueQuote = (
  jobId: string,
  status?: "sent" | "accepted" | "rejected",
) => call<void>({ op: "issueQuote", jobId, status });
export const getQuoteTotals = (jobId: string) =>
  call<FrozenTotals | undefined>({ op: "getQuoteTotals", jobId });

// --- Filaments and customers ------------------------------------------------

export const listFilaments = () => call<Filament[]>({ op: "listFilaments" });
export const createFilament = (filament: Omit<Filament, "id">) =>
  call<string>({ op: "createFilament", filament });
export const deactivateFilament = (filamentId: string) =>
  call<void>({ op: "deactivateFilament", filamentId });
export const listCustomers = () => call<Customer[]>({ op: "listCustomers" });

// --- Printers ----------------------------------------------------------------

export const listPrinters = (includeInactive = false) =>
  call<Printer[]>({ op: "listPrinters", includeInactive });
export const createPrinter = (printer: Omit<Printer, "id" | "status">) =>
  call<string>({ op: "createPrinter", printer });
export const updatePrinter = (
  id: string,
  patch: Partial<Omit<Printer, "id" | "status">>,
) => call<void>({ op: "updatePrinter", id, patch });
export const setPrinterStatus = (id: string, status: PrinterStatus) =>
  call<void>({ op: "setPrinterStatus", id, status });

// --- Settings ---------------------------------------------------------------

export const getSettings = () => call<Settings>({ op: "getSettings" });
export const updateSettings = (patch: Partial<Settings>) =>
  call<void>({ op: "updateSettings", patch });

// --- Legacy localStorage migration -----------------------------------------

export interface ImportSummary {
  alreadyDone: boolean;
  filamentsImported: number;
  jobsImported: number;
  skipped: { job: string; reason: string }[];
}

/**
 * Move any data the old localStorage version saved into SQLite.
 *
 * Local mode only. localStorage is per-browser, so importing it into a shared
 * server database would copy one device's history into everyone's view; in
 * remote mode the migration path is Export here, then Import there.
 */
export async function importLegacyIfNeeded(): Promise<ImportSummary> {
  const nothingToDo: ImportSummary = {
    alreadyDone: true,
    filamentsImported: 0,
    jobsImported: 0,
    skipped: [],
  };
  if (isRemote) return nothingToDo;

  const { readLegacyLocalStorage } = await import("./importLegacy");
  const legacy = readLegacyLocalStorage(window.localStorage);
  if (legacy.filaments.length === 0 && legacy.jobs.length === 0)
    return nothingToDo;

  return callLocal<ImportSummary>({ op: "importLegacy", legacy });
}

// --- Backup -----------------------------------------------------------------

/**
 * Download the database as a .sqlite3 file.
 *
 * In local mode this is the only copy that exists anywhere: OPFS is wiped when
 * the browser clears site data. In remote mode the volume holds the data, but
 * this is still the only backup off that volume.
 */
export async function downloadBackup(): Promise<string> {
  if (isRemote) return downloadBackupRemote();

  const bytes = await callLocal<Uint8Array>({ op: "export" });
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const filename = `printdesk-${stamp}.sqlite3`;

  // Copy into a plain ArrayBuffer. The bytes arrive from the Worker typed as
  // Uint8Array<ArrayBufferLike>, which Blob will not accept because it could in
  // principle be a SharedArrayBuffer.
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);

  const blob = new Blob([buffer], { type: "application/vnd.sqlite3" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);

  return filename;
}

/**
 * Replace the current database with the contents of a backup file.
 * Destructive and irreversible — the caller must confirm with the user first.
 */
export async function restoreBackup(file: File): Promise<void> {
  if (isRemote) return restoreBackupRemote(file);
  const bytes = new Uint8Array(await file.arrayBuffer());
  await callLocal<void>({ op: "import", bytes });
}

/** True when a failure means "log in again" rather than "storage is broken". */
export const isUnauthorized = (err: unknown): boolean =>
  err instanceof UnauthorizedError;
