# Implementation Plan: Printer Fleet & Shop Settings

## Overview

Implementation proceeds bottom-up through the app's four layers: schema/migration, types, repository (with tests), pricing engine (with tests), worker/server/client wiring, then UI. Machine cost, failure-rate reserve, and minimum-order floor are all additive to `computeCosts`, so existing call sites and tests must keep passing unchanged throughout.

## Tasks

- [x] 1. Add schema migration and fresh-DB columns for `minimum_order` and `machine_rate`
  - In `src/db/schema.ts`, bump `SCHEMA_VERSION` from `1` to `2`.
  - Add `MIGRATIONS[2]` running `alter table settings add column minimum_order real not null default 0.0` and `alter table jobs add column machine_rate real not null default 0.0`.
  - Update `schema.sql`'s `create table if not exists settings (...)` block to include `minimum_order real not null default 0.0` directly, and the `create table if not exists jobs (...)` block to include `machine_rate real not null default 0.0` directly, so fresh databases skip the migration.
  - _Requirements: 3.1, 3.2_

- [x] 2. Add `ensureDefaultPrinter` seed function and wire it into both DB open paths
  - In `src/db/schema.ts`, add `ensureDefaultPrinter(db: SqlExecutor)`: if `select count(*) as n from printers` is 0, insert one row named "Creality K2 SE", `model` "K2 SE", `power_watts` 350, `purchase_cost` 7600, `amortization_hours` 4000, `maintenance_cost_per_hour` 1, `status` 'active'.
  - Call `ensureDefaultPrinter(executor)` immediately after the existing `ensureSettings(executor)` call in `src/db/worker.ts`'s `open()`.
  - Call `ensureDefaultPrinter(executor)` immediately after the existing `ensureSettings(executor)` call in `server/db.ts`'s `openDatabase()`.
  - _Requirements: 2.1_

- [x] 2.1 Write schema tests for migration and seeding
  - Assert a fresh database (`initializeSchema` from version 0) has `minimum_order` and `machine_rate` columns present immediately.
  - Assert `ensureDefaultPrinter` seeds exactly one "Creality K2 SE" row on an empty `printers` table, and does nothing on a second call.
  - _Requirements: 2.1, 3.1, 3.2_

- [x] 3. Add `Printer`/`PrinterStatus` types and extend `PrintJob`/`Settings` types
  - In `src/types.ts`, add `export type PrinterStatus = 'active' | 'maintenance' | 'retired'` and `export interface Printer { id, name, model: string | null, powerWatts, purchaseCost, amortizationHours, maintenanceCostPerHour, status: PrinterStatus }`.
  - In `src/types.ts`, add optional fields `printerId?: string` and `machineRate?: number` to `PrintJob`.
  - In `src/db/repository.ts`, add `minimumOrder: number` to the existing `Settings` interface.
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 3.1, 6.3, 6.4_

- [x] 4. Implement printer CRUD functions in the repository layer
  - In `src/db/repository.ts`, implement `listPrinters(db, includeInactive = false)` selecting from `printers`, filtering to `status = 'active'` unless `includeInactive` is true, ordered by name.
  - Implement `createPrinter(db, p)` validating `amortizationHours > 0` and `powerWatts`/`purchaseCost`/`maintenanceCostPerHour >= 0`, throwing `Error` with a human-readable message and writing no row on failure; inserts with `status: 'active'` and a generated id.
  - Implement `updatePrinter(db, id, patch)` applying the same validation only to fields present in `patch`.
  - Implement `setPrinterStatus(db, id, status)` updating `status` and `updated_at`.
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6_

- [x] 5. Extend settings get/update and job save/read for the new fields
  - In `src/db/repository.ts`'s `updateSettings`, add `minimumOrder: 'minimum_order'` to the `columns` map.
  - In `getSettings`'s return object, add `minimumOrder: row.minimum_order as number`.
  - In `saveJob`'s INSERT/UPDATE statements for `jobs`, add `printer_id` and `machine_rate` columns populated from `job.printerId` and `job.machineRate`.
  - In `readJobs`, map `printer_id`/`machine_rate` onto the returned `PrintJob` as `printerId: (r.printer_id as string) ?? undefined` and `machineRate: (r.machine_rate as number) ?? 0`.
  - Update `freezeQuote` to call `computeCosts(job, getSettings(db))` instead of the single-argument form.
  - _Requirements: 3.1, 3.2, 6.3, 6.4, 6.5, 10.4_

- [x] 5.1 Write repository tests for printer CRUD, settings, and job snapshot round-trip
  - Assert `createPrinter`/`updatePrinter` reject `amortizationHours <= 0` and negative `powerWatts`/`purchaseCost`/`maintenanceCostPerHour` without writing a row.
  - **Property 5: Validation atomicity** — a rejected `createPrinter`/`updatePrinter` call leaves the `printers` table exactly as it was before the call.
  - **Validates: Requirements 1.5, 1.6**
  - Assert `listPrinters(db, false)` excludes a printer after `setPrinterStatus(..., 'retired')`; `listPrinters(db, true)` still includes it.
  - Assert `saveJob` round-trips `printerId`/`machineRate` through `getJob` unchanged.
  - **Property 4: Snapshot immutability** — save a job referencing a printer, mutate that printer's `purchaseCost`/`amortizationHours`/`maintenanceCostPerHour` via `updatePrinter`, re-read the job via `getJob`/`listJobs`, and assert its `machineRate`/`powerWatts` are unchanged.
  - **Validates: Requirements 6.5**
  - Assert `updateSettings({ minimumOrder: ... })` round-trips through `getSettings`.
  - _Requirements: 1.1, 1.5, 1.6, 3.1, 3.2, 5.7, 6.5_

- [x] 6. Checkpoint - Ensure all repository and schema tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 7. Implement `machineRate()` and extend `CostBreakdown`/`computeCosts` in the pricing engine
  - In `src/pricing.ts`, add `export function machineRate(printer: Pick<Printer, 'purchaseCost' | 'amortizationHours' | 'maintenanceCostPerHour'>): number` returning `purchaseCost / amortizationHours + maintenanceCostPerHour`.
  - Add `machine: number` and `failureAdjustedSubtotal: number` fields to `CostBreakdown`.
  - Change `computeCosts` signature to `computeCosts(job: PrintJob, settings?: Pick<Settings, 'failureRatePercent' | 'minimumOrder'>)`, keeping the second argument optional so existing single-argument call sites are unaffected.
  - Add the `machine` cost line (`(job.printTimeHours || 0) * (job.machineRate || 0)`), placed into `unitSubtotal` via a `failureAdjustedSubtotal` computed from `filament + machine + electricity` divided by `(1 - failureRate)` when `failureRate > 0` (else unadjusted).
  - Apply the `minimumOrder` floor as the last step: `total = Math.max(preFloorTotal, minimumOrder)`, applied once to the whole job's total, not per unit.
  - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 8.1, 8.2, 8.3, 8.4, 9.1, 9.2, 9.3, 9.4, 10.1, 10.2, 10.3_

- [x] 7.1 Write property and unit tests for the pricing engine changes in `src/pricing.test.ts`
  - **Property 1: Backward compatibility of computeCosts** — for a `PrintJob` with `printerId`/`machineRate` undefined, `computeCosts(job)` called with no `settings` argument returns byte-identical results to the existing pre-feature tests.
  - **Validates: Requirements 10.1, 10.2, 10.3**
  - **Property 2: Failure reserve scope** — for `failureRatePercent > 0`, changing it changes `machine`, `filament`, and `electricity`'s contribution to `unitSubtotal` but does not change `laborPerUnit`, `laborPerJob`, `overhead`, or `iva` in isolation.
  - **Validates: Requirements 8.1, 8.2**
  - **Property 3: Minimum-order idempotence on quantity** — for fixed job inputs, `total` at `quantity: 1` and the same inputs at `quantity: 5` both satisfy `total >= minimumOrder`, and the floor is applied exactly once (never `minimumOrder * quantity`).
  - **Validates: Requirements 9.1, 9.2, 9.3**
  - Test `machineRate()` arithmetic using the seeded K2 SE numbers (`7600/4000 + 1 = 2.9`).
  - Test `computeCosts` with `failureRatePercent: 0` asserts `failureAdjustedSubtotal === filament + machine + electricity` exactly.
  - Test `computeCosts` with a printer-less job but `failureRatePercent: 8` only adjusts filament+electricity.
  - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 8.1, 8.2, 8.3, 8.4, 9.1, 9.2, 9.3, 9.4, 10.1, 10.2, 10.3_

- [x] 8. Checkpoint - Ensure all pricing tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 9. Add matching `op` cases for printer CRUD in `src/db/worker.ts` and `server/api.ts`
  - In `src/db/worker.ts`'s dispatch switch, add `case 'listPrinters'`, `case 'createPrinter'`, `case 'updatePrinter'`, and `case 'setPrinterStatus'`, each calling the corresponding `repository.ts` function.
  - In `server/api.ts`'s dispatch switch, add the identical four cases calling the same repository functions. These two files must stay in sync — a case present in only one leaves the other transport throwing "unknown op".
  - _Requirements: 1.7_

- [x] 10. Add `client.ts` wrapper exports for printer CRUD
  - In `src/db/client.ts`, add `listPrinters`, `createPrinter`, `updatePrinter`, and `setPrinterStatus` wrapper functions that call `call({ op, ...args })`, following the same pattern as the existing filament/settings wrappers.
  - _Requirements: 1.7_

- [x] 11. Checkpoint - Ensure all tests pass and both transports expose identical ops
  - Ensure all tests pass, ask the user if questions arise.

- [x] 12. Build `ShopSettings.tsx` component
  - Create `src/components/ShopSettings.tsx` modeled on the structure of `src/components/Filaments.tsx`: a list + inline add/edit form + deactivate/reactivate control, no modal, no router.
  - Add a global section with `failureRatePercent` (0-99, default display 8) and `minimumOrder` (>= 0, default 0) number inputs, rejecting invalid values client-side and leaving the previously stored value in place on rejection.
  - Add a printer fleet section: an "add printer" inline form (name, model, purchase cost, amortization hours, maintenance/hour, watts) calling `db.createPrinter`, a table listing every printer with name/model/purchase cost/amortization hours/maintenance per hour/watts/computed Machine_Rate/status, and per-row edit and deactivate/reactivate controls calling `db.updatePrinter`/`db.setPrinterStatus`.
  - Compute the live Machine_Rate preview in the add/edit form using the `machineRate()` pure function from `src/pricing.ts` directly on in-progress form state, before saving.
  - Reject an add-printer submission with no `name`, indicating a name is required.
  - Display help text near the seeded "Creality K2 SE" row noting its default values are approximate figures from a public listing and unit conversion, and should be adjusted to the user's actual purchase price and usage.
  - _Requirements: 2.2, 2.3, 3.3, 3.4, 4.1, 4.2, 4.3, 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 5.8_

- [x] 13. Wire printer selection and snapshot-on-save into `Calculator.tsx`
  - Add `printers: Printer[]` and `settings: Settings` props to `Calculator.tsx`.
  - Add a printer `<select>` populated from `printers` (Active_Printer only), mirroring the existing filament-select pattern.
  - Implement `handlePrinterSelect`: on selection, set `printerId` and `powerWatts` (from the printer) and `machineRate` (via `machineRate(p)`); on deselection, clear `printerId`/`machineRate` to `undefined`/0 while leaving any manually-typed `powerWatts` value untouched.
  - Update `defaultJob()` to include `printerId: undefined, machineRate: 0` so a new job defaults to today's exact behavior until a printer is chosen.
  - Change the `computeCosts` call site to `computeCosts(mockJob, settings)`.
  - Add a `<CostRow label="MACHINE" value={costs.machine} />` to the summary panel alongside the existing MATERIAL/ENERGY/LABOR/OVERHEAD rows.
  - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.6, 6.7, 7.1, 7.2, 7.3, 7.4_

- [x] 14. Wire the new 'settings' tab, printers/settings state, and `computeCosts` call sites in `App.tsx`
  - Add `'settings'` to the `Tab` type and add the corresponding tab button following the existing `.map` pattern.
  - Add `printers: Printer[]` state, loaded in `refresh()` alongside `filaments`, and pass it to `Calculator` and `ShopSettings`.
  - Add/confirm `settings: Settings` state loaded via the existing `refresh()` path, passed to `Calculator` and `ShopSettings`.
  - Render `ShopSettings` when the `'settings'` tab is active.
  - Update every `computeCosts(job)` call site (including the `totalRevenue` reducer) to `computeCosts(job, settings)`.
  - _Requirements: 5.1, 10.1, 10.2, 10.3_

- [x] 15. Final checkpoint - Full-suite regression run
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP; they cover property and unit tests only, never core implementation.
- The `computeCosts` second parameter (`settings`) is optional throughout, so every pre-existing single-argument call site keeps compiling and keeps today's behavior (Requirement 10) without any conditional logic.
- `src/db/worker.ts` and `server/api.ts` must receive identical new `op` cases (task 9) — this is the design's explicitly called-out top integration risk; a mismatch leaves one transport throwing "unknown op".
- Component tests for `ShopSettings`/`Calculator` are exploratory/manual unless a component-testing setup already exists in this repo — verify tooling availability during task 12/13 implementation before deciding whether to add automated component tests.
- Deletion of printers is out of scope; only deactivation (`setPrinterStatus`) is implemented.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1", "3"] },
    { "id": 1, "tasks": ["2", "4", "5", "7"] },
    { "id": 2, "tasks": ["2.1", "5.1", "7.1", "9", "10"] },
    { "id": 3, "tasks": ["12", "13"] },
    { "id": 4, "tasks": ["14"] }
  ]
}
```
