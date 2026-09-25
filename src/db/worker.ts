/// <reference lib="webworker" />
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
// Vite inlines the schema as a string at build time. The schema module itself
// takes the SQL as an argument so that it also loads under Node, where the
// server reads the same file from disk.
import schemaSql from "./schema.sql?raw";
import { SqlExecutor, SqlParam } from "./types";
import {
  initializeSchema,
  ensureSettings,
  ensureDefaultPrinter,
  SCHEMA_VERSION,
} from "./schema";
import * as repo from "./repository";
import { importLegacyData, type LegacyData } from "./importLegacy";
import { PrintJob, Filament, Printer, PrinterStatus } from "../types";

/**
 * Owns the one SQLite connection.
 *
 * Why a Worker at all: OPFS synchronous access handles only exist in Worker
 * threads, so an OPFS-backed database physically cannot be opened on the main
 * thread. Running here also keeps queries off the UI thread.
 *
 * Why the opfs-sahpool VFS rather than the default opfs VFS: the latter needs
 * SharedArrayBuffer, which needs the COOP and COEP response headers, which a
 * static Figma Make deployment cannot set. sahpool needs no headers and is the
 * faster of the two. Its cost is no multi-tab concurrency — a second tab will
 * fail to open the database, which the main thread surfaces as an error rather
 * than silently falling back to a throwaway in-memory database.
 */

const DB_FILENAME = "printdesk.sqlite3";

// Module-scoped handles, initialised once by open().
let sqlite3: any = null;
let poolUtil: any = null;
let rawDb: any = null;
let executor: SqlExecutor | null = null;
let persistent = false;

/** Wraps a sqlite-wasm oo1 DB handle in the engine-agnostic SqlExecutor shape. */
function makeExecutor(db: any): SqlExecutor {
  let depth = 0;
  return {
    exec(sql: string) {
      db.exec(sql);
    },
    run(sql: string, params: SqlParam[] = []) {
      db.exec({ sql, bind: params });
    },
    all<T>(sql: string, params: SqlParam[] = []): T[] {
      return db.exec({
        sql,
        bind: params,
        rowMode: "object",
        returnValue: "resultRows",
      }) as T[];
    },
    get<T>(sql: string, params: SqlParam[] = []): T | undefined {
      const rows = db.exec({
        sql,
        bind: params,
        rowMode: "object",
        returnValue: "resultRows",
      }) as T[];
      return rows[0];
    },
    transaction<T>(fn: () => T): T {
      if (depth > 0)
        throw new Error("SqlExecutor.transaction cannot be nested");
      depth++;
      db.exec("begin");
      try {
        const result = fn();
        db.exec("commit");
        return result;
      } catch (err) {
        db.exec("rollback");
        throw err;
      } finally {
        depth--;
      }
    },
  };
}

async function open(): Promise<{
  persistent: boolean;
  schema: { from: number; to: number };
}> {
  if (executor) {
    return { persistent, schema: { from: SCHEMA_VERSION, to: SCHEMA_VERSION } };
  }

  // The published types declare init() as taking no arguments, but the runtime
  // accepts a config object and this is the documented way to intercept its
  // logging. Narrow cast rather than losing the whole module's types.
  const initWithConfig = sqlite3InitModule as unknown as (cfg: {
    print?: (msg: string) => void;
    printErr?: (msg: string) => void;
  }) => Promise<any>;

  sqlite3 = await initWithConfig({
    print: () => {},
    // sqlite-wasm always attempts to load the header-dependent `opfs` VFS and
    // logs a COOP/COEP warning when it cannot. That warning is expected here
    // and irrelevant, since this app uses opfs-sahpool.
    printErr: (msg: string) => {
      if (msg.includes("COOP") || msg.includes("OPFS sqlite3_vfs")) return;
      console.error("[sqlite]", msg);
    },
  });

  try {
    poolUtil = await sqlite3.installOpfsSAHPoolVfs({
      directory: "/printdesk",
      // Each slot is a preallocated file in the pool. A handful covers the
      // database plus its journal.
      initialCapacity: 6,
    });
    rawDb = new poolUtil.OpfsSAHPoolDb(`/${DB_FILENAME}`);
    persistent = true;
  } catch (err) {
    // Do NOT quietly fall back to an in-memory database: the user would enter a
    // day of quotes and lose all of it on refresh with no indication.
    throw new Error(
      "Could not open persistent storage (OPFS). This usually means the app is already " +
        "open in another tab, or the browser is too old (needs Chrome 108+, Firefox 111+, " +
        `or Safari 16.4+). Original error: ${(err as Error).message}`,
    );
  }

  executor = makeExecutor(rawDb);
  const schema = initializeSchema(executor, schemaSql);
  ensureSettings(executor);
  ensureDefaultPrinter(executor);
  return { persistent, schema };
}

function requireDb(): SqlExecutor {
  if (!executor) throw new Error("database not opened");
  return executor;
}

/**
 * Export the raw database file.
 *
 * This is the only recovery path that exists. OPFS is destroyed when the user
 * clears browsing data, so a periodic export is the real backup.
 */
function exportDatabase(): Uint8Array {
  requireDb();
  return sqlite3.capi.sqlite3_js_db_export(rawDb.pointer);
}

/** Replace the entire database with the contents of a previously exported file. */
async function importDatabase(bytes: Uint8Array): Promise<void> {
  // Validate before destroying anything: a truncated or unrelated file must not
  // be allowed to replace a working database.
  const header = new TextDecoder().decode(bytes.slice(0, 15));
  if (!header.startsWith("SQLite format 3")) {
    throw new Error("That file is not a SQLite database.");
  }
  if (!poolUtil) throw new Error("database not opened");

  if (rawDb) {
    rawDb.close();
    rawDb = null;
    executor = null;
  }

  await poolUtil.importDb(`/${DB_FILENAME}`, bytes);
  rawDb = new poolUtil.OpfsSAHPoolDb(`/${DB_FILENAME}`);
  executor = makeExecutor(rawDb);
  // The imported file may predate this build, so run migrations over it.
  initializeSchema(executor, schemaSql);
  ensureSettings(executor);
}

type Request =
  | { id: number; op: "open" }
  | { id: number; op: "listJobs" }
  | { id: number; op: "listActiveJobs" }
  | { id: number; op: "listJobHistory" }
  | { id: number; op: "saveJob"; job: PrintJob }
  | {
      id: number;
      op: "updateJobStatus";
      jobId: string;
      status: PrintJob["status"];
    }
  | { id: number; op: "deleteJob"; jobId: string; force?: boolean }
  | { id: number; op: "duplicateJob"; jobId: string; name?: string }
  | {
      id: number;
      op: "issueQuote";
      jobId: string;
      status?: "sent" | "accepted" | "rejected";
    }
  | { id: number; op: "getQuoteTotals"; jobId: string }
  | { id: number; op: "listFilaments" }
  | { id: number; op: "createFilament"; filament: Omit<Filament, "id"> }
  | { id: number; op: "deactivateFilament"; filamentId: string }
  | { id: number; op: "listCustomers" }
  | { id: number; op: "listPrinters"; includeInactive?: boolean }
  | {
      id: number;
      op: "createPrinter";
      printer: Omit<Printer, "id" | "status"> & { id?: string };
    }
  | {
      id: number;
      op: "updatePrinter";
      printerId: string;
      patch: Partial<Omit<Printer, "id" | "status">>;
    }
  | {
      id: number;
      op: "setPrinterStatus";
      printerId: string;
      status: PrinterStatus;
    }
  | { id: number; op: "getSettings" }
  | { id: number; op: "updateSettings"; patch: Partial<repo.Settings> }
  | { id: number; op: "export" }
  | { id: number; op: "import"; bytes: Uint8Array }
  | { id: number; op: "importLegacy"; legacy: LegacyData };

async function handle(msg: Request): Promise<unknown> {
  switch (msg.op) {
    case "open":
      return open();
    case "listJobs":
      return repo.listJobs(requireDb());
    case "listActiveJobs":
      return repo.listActiveJobs(requireDb());
    case "listJobHistory":
      return repo.listJobHistory(requireDb());
    case "saveJob":
      return repo.saveJob(requireDb(), msg.job);
    case "updateJobStatus":
      return repo.updateJobStatus(requireDb(), msg.jobId, msg.status);
    case "deleteJob":
      return repo.deleteJob(requireDb(), msg.jobId, { force: msg.force });
    case "duplicateJob":
      return repo.duplicateJob(requireDb(), msg.jobId, msg.name);
    case "issueQuote":
      return repo.issueQuote(requireDb(), msg.jobId, msg.status);
    case "getQuoteTotals":
      return repo.getQuoteTotals(requireDb(), msg.jobId);
    case "listFilaments":
      return repo.listFilaments(requireDb());
    case "createFilament":
      return repo.createFilament(requireDb(), msg.filament);
    case "deactivateFilament":
      return repo.deactivateFilament(requireDb(), msg.filamentId);
    case "listCustomers":
      return repo.listCustomers(requireDb());
    case "listPrinters":
      return repo.listPrinters(requireDb(), msg.includeInactive);
    case "createPrinter":
      return repo.createPrinter(requireDb(), msg.printer);
    case "updatePrinter":
      return repo.updatePrinter(requireDb(), msg.printerId, msg.patch);
    case "setPrinterStatus":
      return repo.setPrinterStatus(requireDb(), msg.printerId, msg.status);
    case "getSettings":
      return repo.getSettings(requireDb());
    case "updateSettings":
      return repo.updateSettings(requireDb(), msg.patch);
    case "export":
      return exportDatabase();
    case "import":
      return importDatabase(msg.bytes);
    case "importLegacy":
      return importLegacyData(requireDb(), msg.legacy);
    default: {
      const never: never = msg;
      throw new Error(`unknown op ${JSON.stringify(never)}`);
    }
  }
}

self.onmessage = async (event: MessageEvent<Request>) => {
  const { id } = event.data;
  try {
    const result = await handle(event.data);
    self.postMessage({ id, ok: true, result });
  } catch (err) {
    // Error objects do not survive structured cloning intact, so send the parts
    // the UI needs in order to display something useful.
    self.postMessage({
      id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
};
