# Requirements Document

## Introduction

PrintDesk's pricing engine (`src/pricing.ts`) currently ignores machine cost, print failures, and a price floor: a job's price is filament + electricity (typed in by hand) + labor + packaging/finishing + markup. The `printers` table already exists in `src/db/schema.sql` with the fields needed to derive a machine hourly rate, and `jobs.printer_id` already exists as a column, but neither is read or written anywhere in the app. The `settings` table already has `failure_rate_percent` (defaulting to 0), but nothing sets or applies it.

This feature adds a Shop Settings screen where the user manages a fleet of printers (name, model, purchase cost, amortization hours, maintenance cost per hour, power watts) and two global values: failure rate percent and minimum order amount. It wires printer selection into the job calculator so a job's machine cost and energy cost are derived from the selected printer instead of typed in free-hand, applies the global failure rate as a reserve on material + machine + energy cost, and applies the global minimum order as a floor on the final job price. A default printer profile ("Creality K2 SE") is seeded so the fleet list is not empty on first use.

This feature does not touch the existing `marginPercent` (markup) calculation, labor stages, packaging/finishing costs, IVA, multi-line quotes, PDF/invoice generation, or authentication. Those remain exactly as they behave today.

## Glossary

- **Shop_Settings_Screen**: The new UI tab/screen where the user manages the printer fleet and the two global pricing values (failure rate percent, minimum order amount).
- **Printer**: A row in the `printers` table representing one physical machine in the user's fleet, holding `name`, `model`, `purchase_cost`, `amortization_hours`, `maintenance_cost_per_hour`, `power_watts`, and `status`.
- **Machine_Rate**: A derived value, not a stored column, computed as `(purchase_cost / amortization_hours) + maintenance_cost_per_hour`, expressed in MXN per hour.
- **Failure_Rate_Percent**: A single global setting (`settings.failure_rate_percent`) representing the expected percentage of print attempts lost to failure, applied uniformly to every job.
- **Minimum_Order**: A single global setting representing the minimum MXN amount a job's final price may be, applied uniformly to every job.
- **Pricing_Engine**: The `computeCosts` function in `src/pricing.ts`, the sole place job cost and price arithmetic happens.
- **Job_Calculator**: The existing "new job estimate" screen (`src/components/Calculator.tsx`) where a job's inputs are entered before being added to the queue.
- **Repository_Layer**: The functions in `src/db/repository.ts` that read and write SQL rows, called through `src/db/client.ts`.
- **Active_Printer**: A Printer whose `status` is `'active'`, eligible for selection on a job.
- **Deactivated_Printer**: A Printer whose `status` has been changed away from `'active'` (to `'maintenance'` or `'retired'`) so it no longer appears as selectable for new jobs, while its historical data is preserved.

## Requirements

### Requirement 1: Printer fleet CRUD in the data layer

**User Story:** As a shop owner, I want the app to let me create, read, update, and deactivate printers in my fleet, so that I can maintain accurate machine cost inputs without editing the database directly.

#### Acceptance Criteria

1. THE Repository_Layer SHALL provide a function to list Printers, with an option to include deactivated printers or restrict the result to Active_Printer rows only.
2. THE Repository_Layer SHALL provide a function to create a Printer given `name`, `model`, `purchase_cost`, `amortization_hours`, `maintenance_cost_per_hour`, and `power_watts`.
3. THE Repository_Layer SHALL provide a function to update an existing Printer's `name`, `model`, `purchase_cost`, `amortization_hours`, `maintenance_cost_per_hour`, and `power_watts`.
4. THE Repository_Layer SHALL provide a function to change a Printer's `status` among `'active'`, `'maintenance'`, and `'retired'`.
5. IF a request to create or update a Printer supplies `amortization_hours` less than or equal to zero, THEN THE Repository_Layer SHALL reject the request without writing a row.
6. IF a request to create or update a Printer supplies a negative `power_watts`, `purchase_cost`, or `maintenance_cost_per_hour`, THEN THE Repository_Layer SHALL reject the request without writing a row.
7. THE Repository_Layer SHALL expose every Printer CRUD function through `src/db/client.ts` using the same call-routing pattern as the existing filament and settings operations.

### Requirement 2: Default seeded printer

**User Story:** As a shop owner opening the app for the first time after this feature ships, I want a starter printer already in my fleet, so that I can see how machine cost works without having to look up my own printer's specs first.

#### Acceptance Criteria

1. WHERE the `printers` table contains zero rows at database initialization, THE Repository_Layer SHALL seed one Printer named "Creality K2 SE" with `model` "K2 SE", `purchase_cost` 7600, `amortization_hours` 4000, `maintenance_cost_per_hour` 1, `power_watts` 350, and `status` `'active'`.
2. THE Shop_Settings_Screen SHALL allow the user to edit every field of the seeded "Creality K2 SE" Printer, including `purchase_cost`, `amortization_hours`, `maintenance_cost_per_hour`, and `power_watts`.
3. THE Shop_Settings_Screen SHALL display, near the seeded "Creality K2 SE" Printer or in on-screen help text, a note that its default values are approximate figures derived from a public price listing and currency conversion, not authoritative figures, and that the user should adjust them to match their actual purchase price and usage.

### Requirement 3: Global minimum order setting

**User Story:** As a shop owner, I want to set one minimum order amount for my whole shop, so that no job is ever priced below what makes a print worth doing.

#### Acceptance Criteria

1. THE Repository_Layer SHALL store a `minimum_order` value as part of the existing Settings record.
2. WHERE no `minimum_order` value has been set, THE Repository_Layer SHALL report a default `minimum_order` of 0.
3. THE Shop_Settings_Screen SHALL display the current `minimum_order` value and SHALL allow the user to change it.
4. IF the user enters a negative `minimum_order` value, THEN THE Shop_Settings_Screen SHALL reject the change and SHALL leave the previously stored value in place.

### Requirement 4: Global failure rate setting

**User Story:** As a shop owner, I want to set one failure rate percentage for my whole shop, so that every quote already accounts for the material, machine time, and energy lost to failed prints.

#### Acceptance Criteria

1. THE Shop_Settings_Screen SHALL display the current `failure_rate_percent` value from Settings and SHALL allow the user to change it.
2. WHERE no `failure_rate_percent` value has been set by the user, THE Shop_Settings_Screen SHALL display a default of 8.
3. IF the user enters a `failure_rate_percent` value less than 0 or greater than or equal to 100, THEN THE Shop_Settings_Screen SHALL reject the change and SHALL leave the previously stored value in place.

### Requirement 5: Shop Settings screen

**User Story:** As a shop owner, I want one place to manage my printers and my global pricing floor and failure rate, so that I don't have to hunt across different screens to keep my fleet and shop-wide pricing assumptions current.

#### Acceptance Criteria

1. THE Shop_Settings_Screen SHALL be reachable as a tab alongside the existing calculator, queue, history, and filament inventory tabs.
2. THE Shop_Settings_Screen SHALL list every Printer, showing its `name`, `model`, `purchase_cost`, `amortization_hours`, `maintenance_cost_per_hour`, `power_watts`, `status`, and computed Machine_Rate.
3. WHEN the user changes any of `purchase_cost`, `amortization_hours`, or `maintenance_cost_per_hour` for a Printer in the Shop_Settings_Screen before saving, THE Shop_Settings_Screen SHALL recompute and display that Printer's Machine_Rate without requiring the change to be saved first.
4. THE Shop_Settings_Screen SHALL provide a control to add a new Printer by entering `name`, `model`, `purchase_cost`, `amortization_hours`, `maintenance_cost_per_hour`, and `power_watts`.
5. THE Shop_Settings_Screen SHALL provide a control to edit an existing Printer's `name`, `model`, `purchase_cost`, `amortization_hours`, `maintenance_cost_per_hour`, and `power_watts`.
6. THE Shop_Settings_Screen SHALL provide a control to deactivate a Printer, changing its `status` away from `'active'`, without deleting its row.
7. WHEN a Printer is deactivated, THE Shop_Settings_Screen SHALL continue to display it in the fleet list with a visual indication that it is not active.
8. IF the user attempts to add a Printer without a `name`, THEN THE Shop_Settings_Screen SHALL reject the submission and SHALL indicate that a name is required.

### Requirement 6: Printer selection and snapshot on a job

**User Story:** As a shop owner pricing a job, I want to pick which printer will run it, so that the job's machine cost and energy cost reflect that specific printer instead of a number I have to remember and retype.

#### Acceptance Criteria

1. THE Job_Calculator SHALL provide a control to select one Active_Printer for a job from the current fleet.
2. WHEN the user selects a Printer on the Job_Calculator, THE Job_Calculator SHALL populate the job's power draw field from that Printer's `power_watts`.
3. WHEN a job is saved, THE Repository_Layer SHALL store the selected Printer's identifier on the job as `printer_id`.
4. WHEN a job is saved, THE Repository_Layer SHALL snapshot the selected Printer's Machine_Rate and `power_watts` onto the job record at that moment, following the same snapshot pattern already used for filament `pricePerKg`.
5. IF a job's snapshotted Printer is later deactivated or its cost fields are edited, THEN THE Repository_Layer SHALL leave that job's previously snapshotted Machine_Rate and `power_watts` unchanged.
6. WHERE a job predates this feature and has no `printer_id`, THE Job_Calculator SHALL treat that job's machine cost as zero, consistent with machine cost not existing before this feature.
7. THE Job_Calculator SHALL allow a job to be saved without selecting a Printer.

### Requirement 7: Machine cost line in the pricing engine

**User Story:** As a shop owner, I want the price the calculator shows me to include what the printer itself costs to run, so that my quotes stop underpricing wear, depreciation, and maintenance on the machine.

#### Acceptance Criteria

1. WHEN a job has a snapshotted Machine_Rate, THE Pricing_Engine SHALL compute a machine cost line as `Machine_Rate` multiplied by the job's `printTimeHours`.
2. WHERE a job has no snapshotted Machine_Rate, THE Pricing_Engine SHALL compute a machine cost line of zero.
3. THE Pricing_Engine SHALL include the machine cost line in the per-unit subtotal used to compute markup, in the same way `filament`, `electricity`, `laborPerUnit`, and `overhead` are included today.
4. THE Pricing_Engine SHALL compute the energy cost line using the job's snapshotted `power_watts` from the selected Printer when a Printer is selected, and SHALL otherwise compute it using the job's own `powerWatts` field exactly as it does today.
5. THE Pricing_Engine SHALL leave the existing `marginPercent` (markup) calculation, labor per-job and per-unit split, packaging cost, finishing cost, and IVA calculation unchanged in behavior for any job that has no snapshotted Printer.

### Requirement 8: Failure rate reserve in the pricing engine

**User Story:** As a shop owner, I want the price to already absorb the cost of prints that fail, so that a failed attempt doesn't come out of my own pocket.

#### Acceptance Criteria

1. WHEN Failure_Rate_Percent is greater than zero, THE Pricing_Engine SHALL divide the sum of the filament cost, machine cost, and electricity cost by `(1 - Failure_Rate_Percent / 100)` to produce a failure-adjusted cost for that sum.
2. THE Pricing_Engine SHALL exclude labor cost, packaging cost, and finishing cost from the failure rate adjustment described in Acceptance Criterion 8.1.
3. WHERE Failure_Rate_Percent is zero, THE Pricing_Engine SHALL leave the filament, machine, and electricity costs unadjusted.
4. THE Pricing_Engine SHALL apply the failure-adjusted cost from Acceptance Criterion 8.1 as the basis for the existing markup calculation, in place of the unadjusted filament, machine, and electricity costs.

### Requirement 9: Minimum order floor in the pricing engine

**User Story:** As a shop owner, I want every quote to respect my minimum order amount automatically, so that a tiny job never gets priced below what's worth my time to run it.

#### Acceptance Criteria

1. WHEN the Pricing_Engine computes a job's final total price, THE Pricing_Engine SHALL raise that price to Minimum_Order whenever the computed price is less than Minimum_Order.
2. WHERE the computed price is greater than or equal to Minimum_Order, THE Pricing_Engine SHALL leave the computed price unchanged.
3. THE Pricing_Engine SHALL apply the Minimum_Order floor described in Acceptance Criterion 9.1 to the whole job's total price, not to each unit's price individually, when the job quantity is greater than one.
4. WHERE Minimum_Order is zero, THE Pricing_Engine SHALL leave every job's computed price unaffected by the minimum order floor.

### Requirement 10: Non-interference with existing behavior

**User Story:** As a shop owner already using PrintDesk, I want my existing jobs, markup calculation, and history to keep working exactly as before, so that adding printer and failure-rate pricing doesn't change numbers I've already relied on.

#### Acceptance Criteria

1. THE Pricing_Engine SHALL leave the `marginPercent` field's meaning and its markup calculation unchanged by this feature.
2. THE Pricing_Engine SHALL leave the labor per-job and per-unit cost calculations unchanged by this feature.
3. THE Pricing_Engine SHALL leave the IVA calculation unchanged by this feature.
4. IF a job was frozen (quoted, issued, or completed) before this feature's Repository_Layer changes are applied, THEN THE Repository_Layer SHALL leave that job's previously frozen totals unchanged.
5. THE Shop_Settings_Screen and Job_Calculator SHALL NOT expose any control for multi-line quotes, PDF or invoice generation, CFDI/SAT integration, G-code import, or a per-printer minimum order or per-printer failure rate override.
