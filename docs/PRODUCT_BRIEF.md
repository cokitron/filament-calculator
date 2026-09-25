# PrintDesk — Product Brief: From MVP to Production Quoting System

**Date:** 2026-09-24
**Status:** Findings + proposal, pre-build
**Audience:** Client (3D printing business owner), delivery team

---

## 1. Executive summary

The MVP proves the concept: it is a fast, opinionated single-part cost calculator with real
persistence, a job queue, and work history. The client's own read is accurate — *"great to
calculate for a single plate"* — and that is precisely the ceiling we need to break.

Three things are true after auditing the code and the market:

1. **There is one blocking defect.** "Confirm & Queue" silently does nothing when the job name
   is empty. Verified and reproduced. It is a ~10-line fix.
2. **The pricing engine systematically underquotes.** On a realistic 20-part order it quotes
   **34% below** the industry-standard model. Two independent causes: no machine cost at all,
   and "margin" that is actually markup. Both verified against the live code.
3. **The product is one job = one part.** Real orders are several different parts on one
   estimate. This is the gap between "calculator" and "the system we run the business on,"
   and it is what the invoicing requirement actually depends on.

None of this is a rewrite. The costing core (`computeCosts`) is already a clean single source of
truth with a test suite around it, which is the right foundation to extend.

---

## 2. The blocking defect: "Confirm & Queue" does nothing

### What happens

`handleSubmit` in `src/components/Calculator.tsx` rejects a job with an empty name and returns.
The only feedback is the `JOB NAME` label turning red and gaining an asterisk.

Reproduced in Chrome against the production build:

| Case | Queue count | View | Feedback shown to user |
|---|---|---|---|
| A — JOB NAME empty | `[0]` → `[0]` | stays on form | label turns red, `"JOB NAME *"`. **Zero error messages.** No console errors. |
| B — JOB NAME filled | `[0]` → `[1]` | switches to queue | works correctly |

The field is in section `01 // IDENTIFICATION` at the top of a long form. The button is at the
very bottom, and on mobile it is in a sticky bar. **The user never sees the one pixel of feedback
that exists.** From where they sit, the button is dead.

### A second, latent path to the same symptom

`Calculator` types the prop as `onAddToQueue: (job: PrintJob) => void`, but `App.addToQueue` is
`async`. The returned promise is never awaited, so if the database write throws, the rejection is
unhandled and invisible — *and the form is cleared regardless*, because `setForm(defaultJob())`
runs immediately after the call. A real save failure therefore looks identical to success-with-no-
navigation, and the user's data is gone. Not yet observed in the wild; structurally present.

### Fix

- Validate and **scroll to + focus** the first invalid field, with a visible inline message.
- Make the prop `=> Promise<void>`, `await` it, and only clear the form after the write succeeds.
- Add a busy state on the button, and a visible error toast on failure.
- Require what actually matters for an invoice: job name **and** client.

---

## 3. Pricing audit: where the numbers are wrong

All figures below were produced by running the **real** `computeCosts` from `src/pricing.ts`.

### Reference job

20 brackets · 45 g/part · PLA @ 400 MXN/kg · plate fits 5 parts → 4 plates × 7 h = **28 h machine
time** · printer 200 W · tariff 2.80 MXN/kWh · slice & setup 0.5 h @ 120 (per order) ·
post-process 0.1 h/part @ 120 · **35% entered as "margin"**.

### Finding 3.1 — "Margin" is really markup (≈9% of revenue, every job)

`unitPrice = unitSubtotal × (1 + marginPercent/100)`. That is markup on cost, not margin on price.

| Entered "margin" | App's real margin |
|---|---|
| 35% | **25.93%** |

The database column is already named `markup_percent` while the UI and types call it
`marginPercent` — the inconsistency is baked in at both ends. Industry convention is
`price = cost / (1 − margin)`. For this job that is 1382 vs 912.

> "A 30% margin prices a $10 cost at about $14.29, while a 30% markup prices it at $13.00."
> — [3dprintcostcalc.com](https://www.3dprintcostcalc.com/)

### Finding 3.2 — Machine cost / depreciation is entirely absent

The engine charges material, electricity, labour, packaging and finishing. It never charges for
**the printer wearing out**. Every tool we surveyed treats this as a primary cost line.

For this job, at a modest 25,000 MXN printer over a 4,000 h life (6.25 MXN/h):

| Cost line | Amount | In the app today? |
|---|---|---|
| Electricity (28 h) | 15.68 | yes |
| **Machine wear (28 h)** | **175.00** | **no** |

Machine wear is **11× larger than the electricity** the app does charge for. This is the single
biggest omission, and it scales with exactly the jobs the client wants to win — long ones.

> "Machine Depreciation = (Printer Purchase Price ÷ Expected Lifespan Hours) × Print Time"
> — [mtxlaser.com print-farm guide](https://mtxlaser.com/how-to-start-a-3d-print-farm)

### Finding 3.3 — No failure / scrap reserve

Failed prints are a certainty in a farm, and the universal recommendation is a 5–15% reserve
applied to material + machine cost (`cost / (1 − failureRate)`), not a vague margin cushion.
The app has no such field, so every failure eats margin directly.

> "10% is a sensible default for FDM on prosumer machines… entry-level closer to 15 to 20 percent."
> — [grandpacad.com](https://grandpacad.com/en/tools/3d-printing-business-calculator)

### Finding 3.4 — Print time is per-unit, but slicers report per-plate

This is the "mismatch" the client sensed, and it is the direct consequence of the single-plate
design. `printTimeHours` is a per-unit field multiplied by `quantity`. A slicer reports **one time
for the whole plate**. With 5 parts nested per plate there is no correct number to type:

| What the user types | Electricity charged | Reality |
|---|---|---|
| 7 h (the plate time, as the slicer shows it) | **78.40** | 15.68 — **5× overstated** |
| 1.4 h (7 ÷ 5, after doing mental arithmetic the app never asked for) | 15.68 | 15.68 ✓ |

The app is only correct if the user silently performs a division that is nowhere in the UI. Note
the true margin stays 25.93% in both rows — the markup bug is independent and stacks on top.

### Finding 3.5 — Packaging and finishing cannot be per-order

Labour already has a `scope: 'per_job' | 'per_unit'` distinction, which is good design. Packaging
and finishing do not — they are always per-unit. Ship 20 parts in **one** box and the app bills 20
boxes.

### Finding 3.6 — Missing commercial lines

No shipping. No platform or payment-processing fees. No minimum order charge. For a business
taking real orders these are not edge cases; a 40 MXN part is not worth invoicing at all.

> `price = (jobCost + fixedFee) / (1 − feeRate − marginRate)`
> — [mandarin3d.com](https://mandarin3d.com/blog/how-to-price-3d-printing-jobs)

### Finding 3.7 — No rounding policy

Money is carried as floating point and only rounded at display. For an invoice whose line items
must visibly sum to its total, rounding has to be defined per line and then summed. Today the
printed lines can disagree with the printed total by centavos — the fastest way to lose a client's
trust in the whole document.

### The combined effect

| Model | Quote (pre-IVA) |
|---|---|
| PrintDesk today, best-case data entry | **912.17** |
| Industry-standard model, same job, same 35% target | **1,382.41** |

**The app underquotes this order by 34.0%.** Material 360.00 + machine 175.00 + energy 15.68,
carried at an 8% failure reserve = 598.57, plus 300.00 labour = 898.57 cost, priced at a true 35%
margin = 1,382.41.

### What the MVP already gets right — keep it

- `computeCosts` as the **only** place money math happens, with tests around it.
- Filament `pricePerKg` **snapshotted** onto the job, so re-pricing a spool never rewrites history.
- Labour `per_job` vs `per_unit` scope — the right idea, and the model for everything else.
- IVA applied to the post-margin price, never folded into the cost base.
- Folio numbering and immutable work history already in the schema.

---

## 4. Market research: what comparable products do

| Product | Machine depr. | Failure % | Target-margin solve | Fees / min | Multi-line order | Invoice out | File parsing |
|---|---|---|---|---|---|---|---|
| [3dprintcostcalc.com](https://www.3dprintcostcalc.com/) | yes | yes | yes | yes | yes | client quote + **internal audit PDF** | G-code, STL, 3MF |
| [MakerQuote.io](https://makerquote.io/) | yes | — | yes | — | yes | **quote → invoice** | — |
| [QuotationX](https://quotationx.com/) | yes | yes | yes | — | yes | yes | — |
| [calc3dprint.com](https://calc3dprint.com/) | yes | yes | yes | Etsy fees | — | quote | G-code (local) |
| [3D Costify](https://3dcostify.com/) | yes | yes | — | — | — | — | G-code, STL |
| [PrintQuote](https://print-quote-livid.vercel.app/) | yes | yes | — | VAT | — | — | — |
| **PrintDesk today** | **no** | **no** | **no (markup)** | **no** | **no** | **no** | no |

Two conclusions.

**The cost model is a solved, standardised problem.** Every serious tool charges the same seven
layers: material, energy, machine ownership, labour (split one-time vs per-unit), failure reserve,
overhead, then fees and margin. We are missing three of the seven. There is no innovation risk
here — only the work of implementing a known model correctly.

**The differentiator the client is asking for is the audit trail, and it is rare.** Of everything
surveyed, only 3dprintcostcalc exposes the arithmetic itself — a table where each line reads
`0.050 kg × $26.32/kg = $1.32` — and separates a *client-facing quote* from an *internal cost
audit*. That is almost exactly the client's stated requirement: *"every item and how it's
calculated in our view, so that we know how each value is getting into our estimate."* Building
that as a first-class feature rather than a debug view is a genuine competitive position.

Also worth noting: the mature tools ingest G-code/3MF to get time and grams automatically. That
removes the entire class of error described in Finding 3.4. It is the highest-leverage feature on
this list, and it is the right long-term destination.

---

## 5. Proposed cost model

Explicit, ordered, and auditable. Every line below becomes a visible row in the internal view.

```
# Per plate, from the slicer — not per unit
plates          = ceil(quantity / partsPerPlate)
machineHours    = plates × hoursPerPlate

materialCost    = Σ (grams ÷ 1000 × pricePerKg)        per part, price snapshotted
energyCost      = machineHours × kW × tariff
machineCost     = machineHours × machineRate           # depreciation + maintenance

productionCost  = (materialCost + energyCost + machineCost) ÷ (1 − failureRate)

laborCost       = Σ perOrderStages + Σ perUnitStages × quantity
directCost      = Σ scoped extras (packaging, consumables, shipping — per order OR per unit)

subtotal        = productionCost + laborCost + directCost

price           = (subtotal + fixedFee) ÷ (1 − feeRate − marginRate)
price           = max(price, minimumOrder)
iva             = price × 0.16                          # when enabled
total           = price + iva
```

Deliberate choices:

- **`machineRate` is one number the client configures per printer** (purchase ÷ lifespan hours,
  plus a maintenance allowance). Stated plainly in the UI so electricity is never double-counted
  inside it — a trap the research calls out explicitly.
- **`marginRate` is true margin**, with markup shown next to it as a read-only cross-check. This
  ends the ambiguity permanently.
- **`partsPerPlate` + `hoursPerPlate`** replace the impossible per-unit time field. The user types
  what the slicer actually shows them.
- **Failure reserve applies only to material + machine + energy**, not labour — you do not pay a
  technician twice for one reprint.
- **Rounding:** each line rounds to centavos, totals sum the rounded lines. The document always
  adds up.

### Migration

`marginPercent` semantics change, so historical jobs must not silently re-price. Existing rows
already carry `markup_percent`; they keep markup behaviour via an explicit
`pricingModel: 'v1_markup' | 'v2_margin'` stamp on the quote, exactly as `scope` was introduced
for labour stages. History stays frozen; new work uses v2.

---

## 6. Proposed UX / IA

The MVP's four tabs are a calculator's information architecture. An estimating system needs an
order's.

```
Estimate #0042 ──────────────────────────── Client · dates · status
├── Line 1  Bracket ×20      plate 5-up, 7.0 h    MXN 1,382.41
├── Line 2  Housing ×4       plate 2-up, 11.5 h   MXN   2,140.00
├── Line 3  Labour — assembly (per order)         MXN     360.00
└── Order   shipping · minimum · fees · IVA · TOTAL
```

**Four screens.**

1. **Shop Settings** — printers (purchase price, lifespan hours, maintenance, wattage), labour
   rates, electricity tariff, default failure %, target margin, fees, minimum order. Set once;
   every estimate inherits. This is what makes quotes consistent between jobs and between staff.
2. **Estimate builder** — an order header plus *n* line items. Each line is roughly today's
   calculator, collapsed to a row. Adding a second part is the core new motion.
3. **Cost audit panel** — per line and per order, the arithmetic expanded:
   `Material · 0.900 kg × 400.00/kg · 360.00`. Toggle *Client view* / *Internal view*. This is
   the client's explicit ask and our differentiator.
4. **Documents** — Estimate and Invoice from the same data, with folio, client details, IVA
   breakdown and terms. Client-facing PDF is clean; internal PDF carries the full audit.

**Scalability points worth designing for now:** line items as first-class records (not a JSON
blob) so we can later report margin by part, by client, by printer; printers as entities so a
farm with mixed machines quotes each correctly; quantity **tiers** on a line, since setup
amortises across a batch and the client will be asked for price breaks.

---

## 7. Roadmap

| Phase | Scope | Why this order |
|---|---|---|
| **0 — Unblock** (days) | Confirm & Queue fix; awaited saves; visible validation and error states | The client is looking at a dead button. Nothing else matters until it works. |
| **1 — Trustworthy numbers** | Machine rate, failure reserve, true margin, plate model, scoped extras, rounding policy, v1/v2 migration | Fixes the 34% underquote. Highest financial impact, self-contained in `computeCosts`. |
| **2 — Estimates & invoices** | Multi-line orders, cost audit panel, client/internal PDF, folio | Turns the calculator into the system the business runs on. Depends on Phase 1 being correct. |
| **3 — Shop configuration** | Printer profiles, saved labour rates, fees, minimums, per-client defaults | Consistency across staff and repeat work. |
| **4 — Kill manual entry** | G-code / 3MF import for time, grams and part count | Removes the largest remaining error source and matches the best tools surveyed. |

Phases 0 and 1 are where the client's complaints actually live and should be quoted as one block
of work.

---

## 8. Decisions needed from the client

1. **Printer fleet** — machines, purchase price, expected life hours, maintenance spend. Required
   to set `machineRate`; we should not invent it.
2. **Observed failure rate.** If unknown, start at 8% and revisit once history accumulates.
3. **Target margin, and confirmation it means margin-on-price.** This changes every quote.
4. **Minimum order charge**, and whether price breaks by quantity are needed at launch.
5. **Fees to model** — card processing, marketplace, delivery.
6. **Invoicing scope.** Is the PDF a commercial document only, or does this need to become a CFDI
   / SAT-stamped factura? That is a materially different project and needs a PAC integration —
   flagging it now rather than at delivery.
7. **Who else uses this.** Multi-user changes the single shared password currently in place.

---

## Appendix — verification

- `computeCosts` read from `src/pricing.ts`; all pricing figures produced by executing that module
  directly against the reference job.
- Queue defect reproduced in Chrome via Playwright against the production build (`pnpm build`),
  both the empty-name and filled-name cases.
- Existing suite: **159 tests across 6 files, all passing** — the baseline to protect during
  Phase 1.
- Market data gathered 2026-09-24; each product linked inline in §4.
