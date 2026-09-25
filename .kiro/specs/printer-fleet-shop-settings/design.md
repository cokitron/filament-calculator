# Design Document

## Overview

This feature wires up three parts of the schema that already exist but are dead code: the `printers` table, the `jobs.printer_id` column, and `settings.failure_rate_percent`. It adds one new column (`settings.minimum_order`), extends the flat `PrintJob` type with three optional fields (`printerId`, plus two snapshotted values), and adds a machine-cost line, a failure-rate divisor, and a minimum-order floor to `computeCosts`. A "Creality K2 SE" printer is seeded once so the fleet list is never empty on first run.

Everything here is additive. Every new field is optional or defaulted to a value that reproduces today's behavior (machine cost 0, failure rate 0, minimum order 0), so a job saved before this feature ships, and every existing test in `pricing.test.ts`, keeps passing unchanged.

## Architecture

The app has four layers, and this feature touches all four the same way the filament price-snapshot pattern already does:

```
UI (Calculator.tsx, new ShopSettings.tsx)
   |  reads/writes PrintJob, Printer, Settings (plain objects)
   v
Client (src/db/client.ts)
   |  call({ op, ...args }) -- routes to whichever transport is active
   v
Transport (localTransport.ts -> worker.ts  |  remoteTransport.ts -> server/api.ts)
   |  both dispatch the same `op` string to the same repository function
   v
Repository (src/db/repository.ts)
   |  the only code that touches SQL; computeCosts is the only code that touches money
   v
SQLite (schema.sql: printers, settings, jobs)
```

Because `worker.ts` and `server/api.ts` both switch on the same `op` values against the same `repository.ts` functions, every new repository function needs one matching `case` added in **both** files, plus one wrapper in `client.ts`. Missing either one leaves local mode working and remote mode throwing "unknown op" (or vice versa) — this is the most likely integration mistake and is called out explicitly in the tasks.

## Data Models

### `printers` table — no schema change

The table already has every column this feature needs:

```sql
create table if not exists printers (
  id                        text    not null primary key,
  name                      text    not null,
  model                     text,
  power_watts               real    not null default 200.0,
  purchase_cost             real    not null default 0.0,
  amortization_hours        integer not null default 3000,
  maintenance_cost_per_hour real    not null default 0.0,
  build_volume              text,
  status                    text    not null default 'active',
  created_at                text    not null,
  updated_at                text    not null,
  constraint printers_status_valid check (status in ('active', 'maintenance', 'retired')),
  constraint printers_amort_sane    check (amortization_hours > 0),
  constraint printers_power_sane    check (power_watts >= 0)
)
```

`purchase_cost` and `maintenance_cost_per_hour` have no non-negative CHECK constraint at the SQL level today. Rather than a migration to add one (which would need a rebuild-and-copy on SQLite for an existing table), Requirement 1.6's validation is enforced in the repository function before the INSERT/UPDATE runs, matching how `settings_failure_sane` is already duplicated in application logic elsewhere. The existing `amortization_hours > 0` and `power_watts >= 0` constraints already double as a backstop.

`Machine_Rate` is **not** a column. It is computed wherever a printer's cost is needed:

```ts
machineRate = purchase_cost / amortization_hours + maintenance_cost_per_hour  // MXN/hour
```

### `settings` table — one new column

`failure_rate_percent` already exists (default `0.0`, CHECK `>= 0 and < 100`). Add `minimum_order`:

```sql
-- MIGRATIONS[2] in src/db/schema.ts
alter table settings add column minimum_order real not null default 0.0;
```

SQLite's `ALTER TABLE ADD COLUMN` with a constant default works on an existing table without a rebuild, so this is a plain migration entry, not a schema.sql rewrite. `SCHEMA_VERSION` bumps from `1` to `2`. `schema.sql` itself also gets the column added to the `create table if not exists settings (...)` block, so a **fresh** database (version 0) gets it directly from the CREATE TABLE and never runs migration 2 — `initializeSchema` already skips migrations for a fresh database (`before === 0` branch runs `schemaSql` verbatim and stops).

No CHECK constraint is added for `minimum_order >= 0` at the SQL level, consistent with how `default_markup_percent` has none either; Requirement 3.4's rejection is application-level in `updateSettings`.

### `jobs.printer_id` — no schema change, but three new job-level fields carried outside the column

`jobs.printer_id` already exists as `text references printers(id) on delete set null`. That default `ON DELETE SET NULL` is exactly Requirement 6.5's "leave the job's snapshot unchanged if the printer is deactivated" — deactivation only ever sets `status`, never deletes the row, so this FK behavior is not even exercised by this feature, only by a future hard-delete that is out of scope.

The snapshot values (machine rate and wattage at the moment the job was saved) are **not** new columns. `jobs.power_watts` already exists and is already documented as "Snapshotted from the printer" in schema.sql's own comment — this feature is what finally makes that comment true. The machine-rate snapshot reuses the same idea but has nowhere to live in `jobs` today; rather than adding a `machine_rate_snapshot` column (a second migration), it is derived and frozen at read time from `printer_id` joined against the `printers` row **as it existed when saved** — which is impossible without a snapshot column if the printer is later edited.

This is a real gap, and the fix is a second new column:

```sql
-- MIGRATIONS[2] in src/db/schema.ts (same migration as minimum_order)
alter table jobs add column machine_rate real not null default 0.0;
```

`schema.sql`'s `jobs` table definition also gets `machine_rate real not null default 0.0` added directly, for the same fresh-database reason as `minimum_order`. This mirrors `job_materials.price_per_kg`: a plain snapshot column written once at save time and never re-derived from a join.

Final job-relevant columns after this feature (new ones marked):

| Column | Table | Status |
|---|---|---|
| `printer_id` | `jobs` | already existed, unused until now |
| `power_watts` | `jobs` | already existed; now actually snapshotted from the printer when one is selected |
| `machine_rate` | `jobs` | **new** — snapshotted MXN/hour at save time |
| `failure_rate_percent` | `settings` | already existed, unused until now |
| `minimum_order` | `settings` | **new** |

### `PrintJob` type (`src/types.ts`)

```ts
export interface PrintJob {
  // ...existing fields unchanged...
  /** Selected printer's id, or undefined if no printer was chosen. */
  printerId?: string
  /**
   * MXN/hour, snapshotted from the selected printer's Machine_Rate at save
   * time. 0 when no printer was selected. Never recomputed from a live join —
   * editing or deactivating the printer later must not change this job's cost,
   * for the same reason jobFilaments[].pricePerKg is a snapshot.
   */
  machineRate?: number
}
```

`powerWatts` is unchanged in shape — it already exists and is already free-typed. This feature changes *how the UI populates it* (from the selected printer) but not the type.

### `Printer` type (new, `src/types.ts`)

```ts
export type PrinterStatus = 'active' | 'maintenance' | 'retired'

export interface Printer {
  id: string
  name: string
  model: string | null
  powerWatts: number
  purchaseCost: number
  amortizationHours: number
  maintenanceCostPerHour: number
  status: PrinterStatus
}
```

No `buildVolume` in the app-facing type — the column exists in SQL but no requirement calls for surfacing it, so the repository simply never selects it. Adding it later is a non-breaking type extension.

### `Settings` type (`src/db/repository.ts`)

Add one field to the existing exported interface:

```ts
export interface Settings {
  // ...existing fields unchanged...
  minimumOrder: number
}
```

## Components and Interfaces

### Repository layer (`src/db/repository.ts`)

#### Printer CRUD

```ts
export function listPrinters(db: SqlExecutor, includeInactive = false): Printer[]
// select ... from printers [where status = 'active'] order by name

export function createPrinter(db: SqlExecutor, p: Omit<Printer, 'id' | 'status'> & { id?: string }): string
// validates amortizationHours > 0, powerWatts/purchaseCost/maintenanceCostPerHour >= 0
// throws (not silently ignores) on violation -- same pattern as findOrCreateCustomer's
// guard clauses, since this is a form submission, not a background job

export function updatePrinter(db: SqlExecutor, id: string, patch: Partial<Omit<Printer, 'id' | 'status'>>): void
// same validation as createPrinter, applied only to fields present in patch

export function setPrinterStatus(db: SqlExecutor, id: string, status: PrinterStatus): void
// update printers set status = ?, updated_at = ? where id = ?
```

`createPrinter`/`updatePrinter` validation throws `Error` with a message the UI surfaces inline, following the existing convention in this file (e.g. `deleteJob`'s force-flag guard) rather than returning a result object — there is no other validation-result convention in this codebase to match instead.

Machine rate is computed, not stored, so there is no `getMachineRate` repository function — `machineRate(printer)` is a plain pure function exported from `src/pricing.ts` (see below) and imported wherever needed (repository snapshot-on-save, UI live preview).

#### Settings

`getSettings`/`updateSettings` already exist and already follow a "diff-based column map" pattern. Both simply gain one more entry:

```ts
// in the `columns` map inside updateSettings:
minimumOrder: 'minimum_order',

// in getSettings's return object:
minimumOrder: row.minimum_order as number,
```

No new functions needed here — `failureRatePercent` already round-trips through this exact pair of functions today; it is simply never read by the UI or `computeCosts` yet.

#### Job save/read — printer snapshot

`saveJob`'s existing INSERT/UPDATE statements for the `jobs` table gain `printer_id` and `machine_rate` as two more columns, populated from `job.printerId` and `job.machineRate` exactly like every other job field. No new logic is needed to "compute" the snapshot inside `saveJob` — the snapshot is computed by the **caller** (Calculator.tsx, when the user picks a printer) and arrives on the `PrintJob` object already resolved, the same way `jobFilaments[].pricePerKg` arrives already resolved from `Calculator.tsx`'s `handleFilamentSelect`. This keeps `saveJob` a pure persistence function with no dependency on `listPrinters`.

`readJobs` (the shared function behind `listJobs`, `listActiveJobs`, `getJob`, `listJobHistory`) adds `printer_id` and `machine_rate` to its `select j.*, ...` (already `select j.*`, so no change needed there) and maps them onto the returned `PrintJob`:

```ts
printerId: (r.printer_id as string) ?? undefined,
machineRate: (r.machine_rate as number) ?? 0,
```

#### Seeding the default printer

`ensureSettings(db)` in `src/db/schema.ts` is the existing idempotent "insert the one row if missing" seed function, called on every `open()` in both `worker.ts` and `server/db.ts`. Add a sibling function next to it:

```ts
/** Seed a starter printer if the fleet is empty. Idempotent like ensureSettings. */
export function ensureDefaultPrinter(db: SqlExecutor): void {
  const existing = db.get<{ n: number }>('select count(*) as n from printers')
  if (existing && existing.n > 0) return

  const ts = nowIso()
  db.run(
    `insert into printers
       (id, name, model, power_watts, purchase_cost, amortization_hours,
        maintenance_cost_per_hour, status, created_at, updated_at)
     values (?, 'Creality K2 SE', 'K2 SE', 350, 7600, 4000, 1, 'active', ?, ?)`,
    [crypto.randomUUID(), ts, ts],
  )
}
```

Called once, right next to the existing `ensureSettings(executor)` call, in both places that call it today: `worker.ts`'s `open()` and `server/db.ts`'s `openDatabase()`. This is a data seed, not a schema change, so it does not go through `MIGRATIONS` — same reasoning as `ensureSettings` itself, which is also called directly rather than as a migration step (a migration only runs once per database; a seed-if-empty check needs to run every open in case a user deletes every printer later — though deletion is out of scope here, defensive idempotency costs nothing).

`count(*) = 0` rather than a "seeded" flag: simpler, and matches `ensureSettings`'s own idempotency check. A user who deletes the seeded printer will get it back once — that reintroduction is deemed acceptable rather than doing hard-delete tracking. Deletion is out of scope anyway (Requirement 5.6 only asks for deactivate, not delete), so in practice `count(*) = 0` is only ever true on a genuinely fresh database.

Requirement 2.3 (on-screen note about approximate defaults) is a UI-only concern — no repository or schema support needed, just static help text near the seeded row in `ShopSettings.tsx`.

### Pricing engine (`src/pricing.ts`)

This is the highest-risk part of the change: `computeCosts` is covered by an existing test suite and is read by `repository.ts`'s `freezeQuote`, so its exported shape change must be additive only.

#### `machineRate` as a pure function

```ts
/** MXN/hour: depreciation plus maintenance. Not tied to any one job. */
export function machineRate(printer: Pick<Printer, 'purchaseCost' | 'amortizationHours' | 'maintenanceCostPerHour'>): number {
  return printer.purchaseCost / printer.amortizationHours + printer.maintenanceCostPerHour
}
```

Exported so `ShopSettings.tsx` can show a live-recomputed rate as the user edits an unsaved printer form (Requirement 5.3), and so `Calculator.tsx` can snapshot it onto the job at selection time, without either UI reimplementing the formula.

#### `CostBreakdown` — new fields, all additive

```ts
export interface CostBreakdown {
  filament: number
  electricity: number
  machine: number              // NEW
  laborPerUnit: number
  laborPerJob: number
  overhead: number

  failureAdjustedSubtotal: number  // NEW -- (filament + machine + electricity) / (1 - failureRate)

  unitSubtotal: number
  unitMargin: number
  unitPrice: number

  jobSubtotal: number
  jobPreTax: number
  iva: number
  total: number                 // now includes the minimum-order floor
}
```

#### `computeCosts` — exact placement of the three new lines

```ts
export function computeCosts(
  job: PrintJob,
  settings?: Pick<Settings, 'failureRatePercent' | 'minimumOrder'>,
): CostBreakdown {
  const quantity = Math.max(1, job.quantity || 1)
  const marginRate = (job.marginPercent || 0) / 100
  const failureRate = (settings?.failureRatePercent ?? 0) / 100
  const minimumOrder = settings?.minimumOrder ?? 0

  const filament = /* unchanged */
  const electricity = /* unchanged -- already reads job.powerWatts, which the
                          Calculator now populates from the selected printer,
                          so this line needs no code change at all */

  // NEW: machine cost line. job.machineRate defaults to 0 for any job saved
  // before this feature, or any job with no printer selected -- reproducing
  // today's behavior exactly (Requirement 7.2).
  const machine = (job.printTimeHours || 0) * (job.machineRate || 0)

  // NEW: failure reserve applies ONLY to filament + machine + electricity
  // (Requirement 8.2), never labor/packaging/finishing, and is a no-op divisor
  // of 1 when failureRate is 0 (Requirement 8.3).
  const rawProductionCost = filament + machine + electricity
  const failureAdjustedSubtotal =
    failureRate > 0 ? rawProductionCost / (1 - failureRate) : rawProductionCost

  const stages = job.laborStages || []
  const laborPerUnit = /* unchanged */
  const overhead = /* unchanged */

  // unitSubtotal now built from failureAdjustedSubtotal instead of the raw
  // filament + electricity sum, per Requirement 8.4. laborPerUnit and overhead
  // are NOT divided by the failure rate.
  const unitSubtotal = failureAdjustedSubtotal + laborPerUnit + overhead
  const unitMargin = unitSubtotal * marginRate
  const unitPrice = unitSubtotal + unitMargin

  const laborPerJob = /* unchanged */
  const jobSubtotal = unitSubtotal * quantity + laborPerJob
  const jobPreTax = unitPrice * quantity + laborPerJob * (1 + marginRate)

  const iva = job.ivaEnabled ? jobPreTax * IVA_RATE : 0
  const preFloorTotal = jobPreTax + iva

  // NEW: minimum-order floor applies to the WHOLE JOB's total (Requirement
  // 9.3), after IVA, and is a no-op when minimumOrder is 0 (Requirement 9.4).
  const total = Math.max(preFloorTotal, minimumOrder)

  return { filament, electricity, machine, laborPerUnit, laborPerJob, overhead,
           failureAdjustedSubtotal, unitSubtotal, unitMargin, unitPrice,
           jobSubtotal, jobPreTax, iva, total }
}
```

Design decisions worth calling out:

- **`settings` is an optional second parameter, not a required one.** Every existing call site — `repository.ts`'s `freezeQuote`, and any test calling `computeCosts(job)` with one argument — keeps compiling and keeps its current behavior (failure rate 0, minimum order 0) with zero changes. This is what makes Requirement 10 ("non-interference") mechanically true rather than just asserted: old callers get old behavior by construction, not by a conditional the author has to remember to write correctly.
- **`freezeQuote` in `repository.ts` is updated to pass settings through** (`computeCosts(job, getSettings(db))`), because a frozen quote *should* reflect the shop's failure rate and minimum order at the moment it's frozen — this is a one-line change at the one production call site, orthogonal to the function signature staying backward compatible for tests.
- **The minimum-order floor is applied once, to `total`, not per-unit.** Requirement 9.3 is explicit about this. Applying it to `unitPrice` instead would double-apply it after multiplying by quantity for any job with `quantity > 1`, which is the bug this design avoids by construction — the floor line is the very last line of the function, after quantity and IVA have both already been folded in.
- **`failureAdjustedSubtotal` is a new field on `CostBreakdown` rather than silently folded into `unitSubtotal`,** so the audit-minded UI (and Requirement 8's own testability) can show "production cost before failure reserve" vs "after" as two distinct numbers, matching the brief's stated differentiator of showing the arithmetic rather than hiding it.

#### `formatMXN` / `formatMXNPrecise`

Unchanged. No new formatting need beyond what these two functions already do.

### UI

#### New `ShopSettings.tsx` component

Structurally mirrors the existing `Filaments.tsx` (a list + inline add form + deactivate button, no modal, no router) since that is the closest existing analog: a small catalog CRUD screen reachable from a tab.

```
Shop Settings
├── Global section
│   ├── Field: FAILURE RATE % (number input, 0-99, default 8)
│   └── Field: MINIMUM ORDER (MXN) (number input, >= 0, default 0)
├── Printer fleet section
│   ├── + ADD PRINTER (reveals inline form: name, model, purchase cost,
│   │   amortization hours, maintenance/hour, watts)
│   └── Table, one row per printer:
│       NAME | MODEL | PURCHASE COST | AMORT. HOURS | MAINT./H | WATTS |
│       MACHINE RATE (computed live) | STATUS | [Edit] [Deactivate/Reactivate]
└── Help text under the seeded "Creality K2 SE" row: "Default values are
    estimated from a public price listing and unit conversion — adjust them
    to your actual purchase price and usage."
```

State shape: local component state for the add/edit form (`useState`), calling `db.createPrinter` / `db.updatePrinter` / `db.setPrinterStatus` on submit, then the parent (`App.tsx`) refetches via the existing `refresh()` pattern — identical to how `Filaments.tsx`'s `onAdd`/`onRemove` props work today. Live machine-rate preview while typing uses the exported `machineRate()` pure function directly on the in-progress form state, no round trip needed (Requirement 5.3).

`App.tsx` changes:
- `Tab` type gains `'settings'`.
- New tab button, following the existing `.map` over the `Tab` array.
- New state: `printers: Printer[]`, loaded in `refresh()` alongside `filaments`.
- New state: `settings: Settings`, loaded once in `start()` (settings rarely change mid-session, but re-fetching in `refresh()` is cheap and keeps it simple — reuse the same `refresh()` call rather than adding a second refresh path).
- `computeCosts(j)` call sites (the `totalRevenue` reducer, and inside `Calculator.tsx`) gain the `settings` second argument.

#### `Calculator.tsx` changes

- New prop: `printers: Printer[]` (Active_Printer only — filtered by the parent, same convention as `filaments`).
- New prop: `settings: Settings` (for passing to `computeCosts` and showing the live floor/failure-adjusted preview).
- New field in the `01 // IDENTIFICATION` or a new `00 // PRINTER` block: a `<select>` populated from `printers`, mirroring the existing filament `<select>` in `handleFilamentSelect`'s pattern exactly:

```ts
const handlePrinterSelect = (printerId: string) => {
  const p = printers.find(x => x.id === printerId)
  if (p) {
    set('printerId', p.id)
    set('powerWatts', p.powerWatts)          // Requirement 6.2
    set('machineRate', machineRate(p))        // snapshot happens HERE, at selection time
  } else {
    set('printerId', undefined)
    set('machineRate', 0)
    // powerWatts is deliberately left as whatever the user had typed --
    // clearing it would destroy a manually-entered value for someone not
    // using the printer-cost feature at all (Requirement 6.7: printer
    // selection must remain optional)
  }
}
```
- `defaultJob()` gains `printerId: undefined, machineRate: 0` so a brand-new job defaults to today's exact behavior until the user actively picks a printer.
- `computeCosts(mockJob, settings)` instead of `computeCosts(mockJob)`.
- Summary panel gains one `<CostRow label="MACHINE" value={costs.machine} />` alongside the existing MATERIAL/ENERGY/LABOR/OVERHEAD rows.

#### `worker.ts` / `server/api.ts` — new `op` cases

Both files need the identical five new cases added to their `switch (msg.op)`:

```ts
case 'listPrinters':      return repo.listPrinters(db, msg.includeInactive)
case 'createPrinter':     return repo.createPrinter(db, msg.printer)
case 'updatePrinter':     return repo.updatePrinter(db, msg.id, msg.patch)
case 'setPrinterStatus':  return repo.setPrinterStatus(db, msg.id, msg.status)
```

(Settings already has its `case 'getSettings'` / `case 'updateSettings'` — no new op needed there, just the new field flowing through the existing patch object.)

#### `client.ts` — new exported wrappers

```ts
export const listPrinters = (includeInactive = false) =>
  call<Printer[]>({ op: 'listPrinters', includeInactive })
export const createPrinter = (printer: Omit<Printer, 'id' | 'status'>) =>
  call<string>({ op: 'createPrinter', printer })
export const updatePrinter = (id: string, patch: Partial<Omit<Printer, 'id' | 'status'>>) =>
  call<void>({ op: 'updatePrinter', id, patch })
export const setPrinterStatus = (id: string, status: PrinterStatus) =>
  call<void>({ op: 'setPrinterStatus', id, status })
```

## Migration path

1. `SCHEMA_VERSION` bumps `1 -> 2`.
2. `MIGRATIONS[2]` runs `alter table settings add column minimum_order real not null default 0.0` and `alter table jobs add column machine_rate real not null default 0.0` for any **existing** database opened after this ships.
3. `schema.sql`'s `create table if not exists settings (...)` and `create table if not exists jobs (...)` blocks are updated to include both new columns directly, so a **fresh** database created after this ships gets them from the initial `db.exec(schemaSql)` and never touches `MIGRATIONS[2]` (consistent with how `initializeSchema`'s `before === 0` branch already works).
4. `ensureDefaultPrinter(db)` is called once per `open()`, right after `ensureSettings(db)`, in `worker.ts` and `server/db.ts`.
5. Any job row written before this migration has `printer_id = NULL` and `machine_rate = 0` (the column default), so `readJobs` maps it to `machineRate: 0`, and `computeCosts` computes `machine = printTimeHours * 0 = 0` — reproducing exactly what that job cost before this feature existed (Requirement 6.6, Requirement 10.4). A frozen quote's `total` in the `quotes` table is untouched by this migration (Requirement 10.4) since `freezeQuote` is never re-run by a schema migration.

## Correctness Properties

### Property 1: Backward compatibility of computeCosts

For any `PrintJob` with `printerId` undefined and `machineRate` undefined/0, `computeCosts(job)` called with no `settings` argument SHALL return byte-identical results to the pre-feature implementation. This is checked directly by re-running the existing `pricing.test.ts` cases unchanged.

**Validates: Requirements 10.1, 10.2, 10.3**

### Property 2: Failure reserve scope

For any `failureRatePercent > 0`, changing it SHALL change `machine`, `filament`, and `electricity`'s contribution to `unitSubtotal` but SHALL NOT change `laborPerUnit`, `laborPerJob`, `overhead`, or `iva`'s value in isolation.

**Validates: Requirements 8.1, 8.2**

### Property 3: Minimum-order idempotence on quantity

For a fixed set of job inputs, `total` computed at `quantity: 1` and the same inputs scaled to `quantity: 5` SHALL both respect `total >= minimumOrder`, and the floor SHALL be applied exactly once regardless of quantity — i.e. `total` is never `minimumOrder * quantity`.

**Validates: Requirements 9.1, 9.2, 9.3**

### Property 4: Snapshot immutability

Once a job is saved with a given `printerId` and `machineRate`, subsequently changing that printer's `purchaseCost`, `amortizationHours`, or `maintenanceCostPerHour` (via `updatePrinter`) SHALL NOT change the value returned by `getJob`/`listJobs` for that already-saved job.

**Validates: Requirements 6.5**

### Property 5: Validation atomicity

`createPrinter`/`updatePrinter` SHALL NOT write any row when validation fails — a rejected request leaves the `printers` table exactly as it was before the call.

**Validates: Requirements 1.5, 1.6**

## Error Handling

- `createPrinter`/`updatePrinter` throw a plain `Error` with a human-readable message (e.g. `"amortizationHours must be greater than 0"`) when validation fails, following the existing convention in `repository.ts` (`deleteJob`'s force-flag guard, `findOrCreateCustomer`'s blank-name handling). The UI (`ShopSettings.tsx`) catches this and renders the message inline next to the offending field, the same pattern `Calculator.tsx` already uses for the empty-job-name error.
- `updateSettings({ minimumOrder: -5 })` and `updateSettings({ failureRatePercent: 150 })`: rejected at the UI layer before the call is made (Requirement 3.4, 4.3), not at the repository layer — `updateSettings` itself stays a thin column-map writer with no validation, consistent with how it treats every other field today (e.g. nothing stops `defaultMarkupPercent` from being set negative at the repository level either). This is a deliberate scope narrowing: adding repository-level validation to `updateSettings` would be a larger, unrequested change to an existing shared function; the two new fields get the same level of protection (UI-only) as their siblings already have.
- A printer referenced by `jobs.printer_id` that is later deactivated: no error anywhere. `setPrinterStatus` succeeds unconditionally; the FK's `on delete set null` only matters for a hard delete, which this feature never performs (Requirement 5.6 is deactivate-only).
- Worker/server dispatch: an `op` string with no matching `case` in `worker.ts` or `server/api.ts` falls through to each file's existing `default` branch (an "unknown op" error surfaced to the caller as a rejected promise) — no new error path is introduced, this is the existing dispatch failure mode and is why every new repository function needs its `case` added in both files, called out explicitly as a task risk.

## Testing Strategy

**Unit tests, `src/pricing.test.ts` (extend existing file, do not replace):**
- `machineRate()`: purchase/hours/maintenance arithmetic, including the seeded K2 SE numbers as a named case (`7600/4000 + 1 = 2.9`).
- `computeCosts` with no `settings` argument: identical output to today's existing tests (regression guard for Requirement 10).
- `computeCosts` with a printer-less job but `failureRatePercent: 8`: only filament+electricity get the reserve divisor (machine is 0, so the sum is unaffected by machine but the divisor still applies to filament+electricity).
- `computeCosts` with `machineRate` set and `printTimeHours`: machine line appears, included in `unitSubtotal` and thus in markup.
- `computeCosts` with `failureRatePercent: 0`: `failureAdjustedSubtotal === filament + machine + electricity` exactly (Requirement 8.3).
- `computeCosts` with `minimumOrder` above and below the naturally computed total, at `quantity: 1` and `quantity: 5` (Requirement 9.3's per-job-not-per-unit check).
- Labor, packaging, finishing, IVA, and markup remain excluded from the failure divisor — assert by constructing a case where changing `failureRatePercent` does not move `laborPerJob`/`laborPerUnit`/`overhead`/`iva` at all.

**Repository tests, `src/db/repository.test.ts` (extend existing file):**
- `createPrinter`/`updatePrinter` reject `amortizationHours <= 0` and negative `powerWatts`/`purchaseCost`/`maintenanceCostPerHour` without writing a row (Requirement 1.5, 1.6).
- `listPrinters(db, false)` excludes a printer after `setPrinterStatus(..., 'retired')`; `listPrinters(db, true)` still includes it (Requirement 1.1, 5.7).
- `saveJob` round-trips `printerId`/`machineRate` through `getJob` unchanged.
- Editing a printer's cost fields after a job referencing it was saved does not change that job's already-read `machineRate` (Requirement 6.5) — save job, mutate printer, re-read job, assert unchanged.
- `updateSettings({ minimumOrder: ... })` round-trips through `getSettings`.

**Schema tests, `src/db/schema.test.ts` (extend existing file):**
- Fresh database (`initializeSchema` from version 0) has `minimum_order` and `machine_rate` columns present immediately.
- `ensureDefaultPrinter` seeds exactly one "Creality K2 SE" row on an empty `printers` table, and does nothing on a second call (idempotency, matching the existing `ensureSettings does not overwrite existing values` test).

**Component tests** (if a component-testing setup exists in this repo — verify during implementation; if none exists, this is manual/exploratory verification only, called out as a task):
- `ShopSettings`: add printer form validation messages; machine-rate preview updates as purchase cost/hours/maintenance are typed, before saving.
- `Calculator`: selecting a printer populates the watts field and shows a MACHINE cost row; deselecting (choosing the blank option) does not clear a manually-typed watts value.

No test doubles for `worker.ts`/`server/api.ts` dispatch exist today (they are exercised indirectly through `repository.ts` tests using `NodeSqlExecutor`); this feature does not introduce a new testing layer for that dispatch, consistent with existing coverage.
