import { describe, it, expect, beforeEach, afterEach } from "vitest";
import schemaSql from "./schema.sql?raw";
import { NodeSqlExecutor } from "./nodeExecutor";
import {
  initializeSchema,
  readVersion,
  ensureSettings,
  ensureDefaultPrinter,
  SCHEMA_VERSION,
} from "./schema";

let db: NodeSqlExecutor;

beforeEach(() => {
  db = new NodeSqlExecutor();
  initializeSchema(db, schemaSql);
  ensureSettings(db);
});

afterEach(() => db.close());

/** Insert a minimal draft quote and return its id. */
function makeQuote(folio = 1): string {
  const id = crypto.randomUUID();
  db.run(
    "insert into quotes (id, folio, created_at, updated_at) values (?, ?, ?, ?)",
    [id, folio, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z"],
  );
  return id;
}

function makeJob(quoteId: string, quantity = 1): string {
  const id = crypto.randomUUID();
  db.run(
    "insert into jobs (id, quote_id, name, quantity, created_at, updated_at) values (?, ?, ?, ?, ?, ?)",
    [
      id,
      quoteId,
      "Job",
      quantity,
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z",
    ],
  );
  return id;
}

describe("schema initialisation", () => {
  it("records the schema version", () => {
    expect(readVersion(db)).toBe(SCHEMA_VERSION);
  });

  it("is idempotent — re-running does not fail or duplicate", () => {
    const result = initializeSchema(db, schemaSql);
    expect(result.to).toBe(SCHEMA_VERSION);
    const rows = db.all("select version from schema_version");
    expect(rows.length).toBe(1);
  });

  it("refuses to open a database written by a newer app version", () => {
    db.run("insert into schema_version (version, applied_at) values (?, ?)", [
      99,
      "x",
    ]);
    expect(() => initializeSchema(db, schemaSql)).toThrow(
      /newer than this app supports/,
    );
  });

  it("creates every expected table", () => {
    const names = db
      .all<{
        name: string;
      }>("select name from sqlite_master where type='table' order by name")
      .map((r) => r.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "customers",
        "filament_spools",
        "filaments",
        "job_actuals",
        "job_labor_stages",
        "job_materials",
        "jobs",
        "printers",
        "quotes",
        "schema_version",
        "settings",
      ]),
    );
  });

  it("gives a fresh database the minimum_order and machine_rate columns immediately", () => {
    // db here was already brought up from version 0 in beforeEach, via
    // schema.sql's CREATE TABLE blocks rather than MIGRATIONS[2] — this
    // guards against the fresh-DB columns ever being removed from schema.sql
    // while only living in the migration.
    const settingsColumns = db
      .all<{ name: string }>("pragma table_info('settings')")
      .map((r) => r.name);
    const jobsColumns = db
      .all<{ name: string }>("pragma table_info('jobs')")
      .map((r) => r.name);

    expect(settingsColumns).toContain("minimum_order");
    expect(jobsColumns).toContain("machine_rate");

    const settingsRow = db.get<{ minimum_order: number }>(
      "select minimum_order from settings",
    );
    expect(settingsRow?.minimum_order).toBe(0);

    const jobId = makeJob(makeQuote());
    const jobRow = db.get<{ machine_rate: number }>(
      "select machine_rate from jobs where id = ?",
      [jobId],
    );
    expect(jobRow?.machine_rate).toBe(0);
  });
});

describe("foreign keys", () => {
  it("has foreign key enforcement switched ON", () => {
    // SQLite defaults this OFF. If the pragma is missing, every ON DELETE
    // CASCADE in the schema silently does nothing.
    const row = db.get<{ foreign_keys: number }>("pragma foreign_keys");
    expect(row?.foreign_keys).toBe(1);
  });

  it("rejects a job pointing at a non-existent quote", () => {
    expect(() => makeJob("no-such-quote")).toThrow();
  });

  it("cascades deletes from quote to job to labor and materials", () => {
    const quoteId = makeQuote();
    const jobId = makeJob(quoteId);
    db.run(
      "insert into job_labor_stages (id, job_id, name, hours, rate, scope, created_at) values (?, ?, ?, ?, ?, ?, ?)",
      [crypto.randomUUID(), jobId, "Setup", 0.25, 120, "per_job", "x"],
    );
    db.run(
      "insert into job_materials (id, job_id, grams, price_per_kg, created_at) values (?, ?, ?, ?, ?)",
      [crypto.randomUUID(), jobId, 50, 440, "x"],
    );

    db.run("delete from quotes where id = ?", [quoteId]);

    expect(db.all("select 1 from jobs")).toHaveLength(0);
    expect(db.all("select 1 from job_labor_stages")).toHaveLength(0);
    expect(db.all("select 1 from job_materials")).toHaveLength(0);
  });

  it("blocks deleting a filament that a spool still references", () => {
    const fid = crypto.randomUUID();
    db.run(
      "insert into filaments (id, brand, type, color, price_per_kg, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?)",
      [fid, "Polymaker", "PLA+", "Negro", 440, "x", "x"],
    );
    db.run(
      "insert into filament_spools (id, filament_id, created_at, updated_at) values (?, ?, ?, ?)",
      [crypto.randomUUID(), fid, "x", "x"],
    );
    expect(() => db.run("delete from filaments where id = ?", [fid])).toThrow();
  });

  it("nulls a job material filament reference instead of deleting history", () => {
    const fid = crypto.randomUUID();
    db.run(
      "insert into filaments (id, brand, type, color, price_per_kg, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?)",
      [fid, "Overture", "ABS", "Amarillo", 400, "x", "x"],
    );
    const jobId = makeJob(makeQuote());
    db.run(
      "insert into job_materials (id, job_id, filament_id, material_label, grams, price_per_kg, created_at) values (?, ?, ?, ?, ?, ?, ?)",
      [crypto.randomUUID(), jobId, fid, "ABS Amarillo", 95, 400, "x"],
    );

    db.run("delete from filaments where id = ?", [fid]);

    const row = db.get<{
      filament_id: string | null;
      material_label: string;
      price_per_kg: number;
    }>("select filament_id, material_label, price_per_kg from job_materials");
    // The catalog entry is gone but the historical record of what was printed,
    // and what it cost, survives.
    expect(row?.filament_id).toBeNull();
    expect(row?.material_label).toBe("ABS Amarillo");
    expect(row?.price_per_kg).toBe(400);
  });
});

describe("settings", () => {
  it("is a singleton — a second row is rejected", () => {
    expect(() =>
      db.run(
        "insert into settings (id, created_at, updated_at) values (2, ?, ?)",
        ["x", "x"],
      ),
    ).toThrow();
  });

  it("defaults to MXN with IVA off at 16%", () => {
    const s = db.get<{
      currency: string;
      default_iva_enabled: number;
      iva_rate: number;
      electricity_rate: number;
    }>(
      "select currency, default_iva_enabled, iva_rate, electricity_rate from settings",
    );
    expect(s?.currency).toBe("MXN");
    expect(s?.default_iva_enabled).toBe(0);
    expect(s?.iva_rate).toBe(0.16);
    expect(s?.electricity_rate).toBe(2.8);
  });

  it("rejects an out-of-range IVA rate", () => {
    expect(() => db.run("update settings set iva_rate = 1.5")).toThrow();
  });

  it("ensureSettings does not overwrite existing values", () => {
    db.run("update settings set business_name = ?", ["Mi Taller"]);
    ensureSettings(db);
    const s = db.get<{ business_name: string }>(
      "select business_name from settings",
    );
    expect(s?.business_name).toBe("Mi Taller");
  });
});

describe("constraints", () => {
  it("rejects an invalid labor scope", () => {
    const jobId = makeJob(makeQuote());
    expect(() =>
      db.run(
        "insert into job_labor_stages (id, job_id, scope, created_at) values (?, ?, ?, ?)",
        [crypto.randomUUID(), jobId, "per_decade", "x"],
      ),
    ).toThrow();
  });

  it("accepts both valid labor scopes", () => {
    const jobId = makeJob(makeQuote());
    for (const scope of ["per_job", "per_unit"]) {
      db.run(
        "insert into job_labor_stages (id, job_id, scope, created_at) values (?, ?, ?, ?)",
        [crypto.randomUUID(), jobId, scope, "x"],
      );
    }
    expect(db.all("select 1 from job_labor_stages")).toHaveLength(2);
  });

  it("rejects quantity below 1", () => {
    const quoteId = makeQuote();
    expect(() => makeJob(quoteId, 0)).toThrow();
  });

  it("rejects a spool with more remaining than it started with", () => {
    const fid = crypto.randomUUID();
    db.run(
      "insert into filaments (id, brand, type, color, price_per_kg, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?)",
      [fid, "B", "PLA", "C", 400, "x", "x"],
    );
    expect(() =>
      db.run(
        "insert into filament_spools (id, filament_id, initial_grams, grams_remaining, created_at, updated_at) values (?, ?, ?, ?, ?, ?)",
        [crypto.randomUUID(), fid, 1000, 1500, "x", "x"],
      ),
    ).toThrow();
  });

  it("rejects a malformed hex colour", () => {
    expect(() =>
      db.run(
        "insert into filaments (id, brand, type, color, price_per_kg, hex, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?)",
        [crypto.randomUUID(), "B", "PLA", "C", 400, "nothex", "x", "x"],
      ),
    ).toThrow();
  });

  it("rejects duplicate customer names differing only by case or spacing", () => {
    db.run(
      "insert into customers (id, name, created_at, updated_at) values (?, ?, ?, ?)",
      [crypto.randomUUID(), "Studio Verde", "x", "x"],
    );
    expect(() =>
      db.run(
        "insert into customers (id, name, created_at, updated_at) values (?, ?, ?, ?)",
        [crypto.randomUUID(), "  studio verde ", "x", "x"],
      ),
    ).toThrow();
  });

  it("rejects a blank customer name", () => {
    expect(() =>
      db.run(
        "insert into customers (id, name, created_at, updated_at) values (?, ?, ?, ?)",
        [crypto.randomUUID(), "   ", "x", "x"],
      ),
    ).toThrow();
  });

  it("requires frozen totals once a quote leaves draft", () => {
    const id = makeQuote();
    expect(() =>
      db.run("update quotes set status = ? where id = ?", ["sent", id]),
    ).toThrow();

    db.run(
      "update quotes set status = ?, total = ?, total_pre_tax = ?, total_iva = ?, frozen_at = ? where id = ?",
      ["sent", 1160, 1000, 160, "2026-01-02T00:00:00.000Z", id],
    );
    const q = db.get<{ status: string; total: number }>(
      "select status, total from quotes where id = ?",
      [id],
    );
    expect(q?.status).toBe("sent");
    expect(q?.total).toBe(1160);
  });

  it("forbids a draft from carrying frozen totals", () => {
    const id = makeQuote();
    expect(() =>
      db.run("update quotes set frozen_at = ?, total = ? where id = ?", [
        "x",
        100,
        id,
      ]),
    ).toThrow();
  });

  it("enforces unique folios", () => {
    makeQuote(7);
    expect(() => makeQuote(7)).toThrow();
  });
});

describe("money storage", () => {
  it("round-trips peso values with no precision loss", () => {
    // The reason REAL is used rather than integer centavos: a JS number and a
    // SQLite REAL are both IEEE 754 doubles, so storage is lossless and the
    // stored value cannot disagree with what pricing.ts computed.
    const values = [0.01, 2.8, 440, 1234.56, 0.005, 99999.99, 1 / 3];
    const jobId = makeJob(makeQuote());
    for (const v of values) {
      db.run(
        "insert into job_materials (id, job_id, grams, price_per_kg, created_at) values (?, ?, ?, ?, ?)",
        [crypto.randomUUID(), jobId, 1, v, "x"],
      );
    }
    const stored = db.all<{ price_per_kg: number }>(
      "select price_per_kg from job_materials order by rowid",
    );
    expect(stored.map((r) => r.price_per_kg)).toEqual(values);
  });
});

describe("transactions", () => {
  it("rolls back every statement when one fails", () => {
    const quoteId = makeQuote();
    expect(() =>
      db.transaction(() => {
        makeJob(quoteId);
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(db.all("select 1 from jobs")).toHaveLength(0);
  });

  it("commits when the body succeeds", () => {
    const quoteId = makeQuote();
    db.transaction(() => {
      makeJob(quoteId);
    });
    expect(db.all("select 1 from jobs")).toHaveLength(1);
  });
});

describe("v_job_overview", () => {
  it("joins job, quote, customer and printer", () => {
    const customerId = crypto.randomUUID();
    db.run(
      "insert into customers (id, name, created_at, updated_at) values (?, ?, ?, ?)",
      [customerId, "Studio Verde", "x", "x"],
    );
    const printerId = crypto.randomUUID();
    db.run(
      "insert into printers (id, name, created_at, updated_at) values (?, ?, ?, ?)",
      [printerId, "Bambu P1S", "x", "x"],
    );
    const quoteId = crypto.randomUUID();
    db.run(
      "insert into quotes (id, customer_id, folio, iva_enabled, created_at, updated_at) values (?, ?, ?, ?, ?, ?)",
      [quoteId, customerId, 42, 1, "x", "x"],
    );
    db.run(
      "insert into jobs (id, quote_id, printer_id, name, quantity, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?)",
      [crypto.randomUUID(), quoteId, printerId, "Maqueta", 3, "x", "x"],
    );

    const row = db.get<Record<string, unknown>>("select * from v_job_overview");
    expect(row).toMatchObject({
      job_name: "Maqueta",
      quantity: 3,
      folio: 42,
      iva_enabled: 1,
      customer_name: "Studio Verde",
      printer_name: "Bambu P1S",
    });
  });

  it("still returns the job when there is no customer", () => {
    makeJob(makeQuote());
    const row = db.get<{ customer_name: string }>(
      "select * from v_job_overview",
    );
    expect(row?.customer_name).toBe("");
  });
});

describe("ensureDefaultPrinter", () => {
  it("seeds exactly one Creality K2 SE row on an empty printers table", () => {
    ensureDefaultPrinter(db);

    const rows = db.all<{
      name: string;
      model: string | null;
      power_watts: number;
      purchase_cost: number;
      amortization_hours: number;
      maintenance_cost_per_hour: number;
      status: string;
    }>("select * from printers");

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      name: "Creality K2 SE",
      model: "K2 SE",
      power_watts: 350,
      purchase_cost: 7600,
      amortization_hours: 4000,
      maintenance_cost_per_hour: 1,
      status: "active",
    });
  });

  it("does nothing on a second call", () => {
    ensureDefaultPrinter(db);
    ensureDefaultPrinter(db);

    const rows = db.all("select 1 from printers");
    expect(rows).toHaveLength(1);
  });

  it("does not seed when the printers table already has a row", () => {
    db.run(
      "insert into printers (id, name, created_at, updated_at) values (?, ?, ?, ?)",
      [crypto.randomUUID(), "Bambu P1S", "x", "x"],
    );

    ensureDefaultPrinter(db);

    const names = db
      .all<{ name: string }>("select name from printers")
      .map((r) => r.name);
    expect(names).toEqual(["Bambu P1S"]);
  });
});
