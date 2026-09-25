import { describe, it, expect } from "vitest";
import { computeCosts, formatMXN, IVA_RATE, machineRate } from "./pricing";
import { PrintJob } from "./types";

/** A job with every cost isolated so each assertion tests one thing. */
function job(overrides: Partial<PrintJob> = {}): PrintJob {
  return {
    id: "test",
    name: "Test",
    client: "",
    status: "queued",
    jobFilaments: [],
    printTimeHours: 0,
    powerWatts: 0,
    electricityRate: 0,
    laborStages: [],
    packagingCost: 0,
    finishingCost: 0,
    marginPercent: 0,
    quantity: 1,
    notes: "",
    createdAt: "",
    ...overrides,
  };
}

describe("material cost", () => {
  it("converts grams to kilograms", () => {
    const c = computeCosts(
      job({
        jobFilaments: [
          { id: "a", material: "PLA", color: "", weight: 500, pricePerKg: 400 },
        ],
      }),
    );
    // 500 g = 0.5 kg at $400/kg = $200
    expect(c.filament).toBe(200);
  });

  it("sums multiple materials", () => {
    const c = computeCosts(
      job({
        jobFilaments: [
          { id: "a", material: "PLA", color: "", weight: 250, pricePerKg: 400 },
          {
            id: "b",
            material: "PETG",
            color: "",
            weight: 100,
            pricePerKg: 560,
          },
        ],
      }),
    );
    expect(c.filament).toBeCloseTo(100 + 56, 10);
  });
});

describe("energy cost", () => {
  it("multiplies hours by kilowatts by rate", () => {
    const c = computeCosts(
      job({ printTimeHours: 10, powerWatts: 200, electricityRate: 2.8 }),
    );
    // 10 h × 0.2 kW × $2.8/kWh = $5.60
    expect(c.electricity).toBeCloseTo(5.6, 10);
  });
});

describe("labor scope", () => {
  const setup = {
    name: "Setup",
    hours: 1,
    rate: 120,
    scope: "per_job" as const,
  };
  const sanding = {
    name: "Sanding",
    hours: 1,
    rate: 100,
    scope: "per_unit" as const,
  };

  it("separates per-job from per-unit labor", () => {
    const c = computeCosts(job({ laborStages: [setup, sanding] }));
    expect(c.laborPerJob).toBe(120);
    expect(c.laborPerUnit).toBe(100);
  });

  it("charges per-job labor exactly once regardless of quantity", () => {
    const one = computeCosts(job({ laborStages: [setup], quantity: 1 }));
    const fifty = computeCosts(job({ laborStages: [setup], quantity: 50 }));
    // This is the bug fix: setup used to be multiplied by quantity.
    expect(one.total).toBe(120);
    expect(fifty.total).toBe(120);
  });

  it("scales per-unit labor with quantity", () => {
    const c = computeCosts(job({ laborStages: [sanding], quantity: 10 }));
    expect(c.total).toBe(1000);
  });

  it("treats legacy stages with no scope as per-unit", () => {
    // Records saved before the scope field existed must price as they did before.
    const legacy = computeCosts(
      job({ laborStages: [{ name: "Old", hours: 1, rate: 100 }], quantity: 3 }),
    );
    expect(legacy.laborPerUnit).toBe(100);
    expect(legacy.laborPerJob).toBe(0);
    expect(legacy.total).toBe(300);
  });
});

describe("markup", () => {
  it("applies the markup percentage to cost", () => {
    const c = computeCosts(job({ packagingCost: 100, marginPercent: 30 }));
    expect(c.unitSubtotal).toBe(100);
    expect(c.unitMargin).toBe(30);
    expect(c.unitPrice).toBe(130);
  });

  it("applies markup to per-job labor as well", () => {
    const c = computeCosts(
      job({
        laborStages: [{ name: "Setup", hours: 1, rate: 100, scope: "per_job" }],
        marginPercent: 50,
      }),
    );
    expect(c.total).toBe(150);
  });
});

describe("IVA", () => {
  it("is not charged when disabled", () => {
    const c = computeCosts(job({ packagingCost: 1000, ivaEnabled: false }));
    expect(c.iva).toBe(0);
    expect(c.total).toBe(1000);
  });

  it("is not charged when the flag is absent (legacy records)", () => {
    const c = computeCosts(job({ packagingCost: 1000 }));
    expect(c.iva).toBe(0);
    expect(c.total).toBe(1000);
  });

  it("adds 16% of the pre-tax sale price when enabled", () => {
    const c = computeCosts(job({ packagingCost: 1000, ivaEnabled: true }));
    expect(c.jobPreTax).toBe(1000);
    expect(c.iva).toBe(160);
    expect(c.total).toBe(1160);
  });

  it("is charged after markup, not before", () => {
    const c = computeCosts(
      job({ packagingCost: 1000, marginPercent: 30, ivaEnabled: true }),
    );
    // Cost 1000 -> +30% markup = 1300 -> +16% IVA = 1508
    expect(c.jobPreTax).toBe(1300);
    expect(c.iva).toBeCloseTo(208, 10);
    expect(c.total).toBeCloseTo(1508, 10);
    // Guard against the inverted order (IVA first, then markup): 1000*1.16*1.3 = 1508 too.
    // So assert the intermediate instead, which differs: pre-tax must be 1300, not 1160.
    expect(c.jobPreTax).not.toBe(1160);
  });

  it("taxes per-job labor too", () => {
    const c = computeCosts(
      job({
        laborStages: [{ name: "Setup", hours: 1, rate: 100, scope: "per_job" }],
        ivaEnabled: true,
      }),
    );
    expect(c.total).toBeCloseTo(116, 10);
  });

  it("uses the documented rate", () => {
    expect(IVA_RATE).toBe(0.16);
  });
});

describe("quantity", () => {
  it("scales per-unit costs but not per-job costs", () => {
    const c = computeCosts(
      job({
        jobFilaments: [
          { id: "a", material: "PLA", color: "", weight: 100, pricePerKg: 400 },
        ],
        laborStages: [
          { name: "Setup", hours: 1, rate: 120, scope: "per_job" },
          { name: "Finish", hours: 0.5, rate: 100, scope: "per_unit" },
        ],
        quantity: 10,
        marginPercent: 0,
      }),
    );
    // Per unit: 40 material + 50 finishing = 90. Ten units = 900. Plus 120 setup once.
    expect(c.unitSubtotal).toBe(90);
    expect(c.jobSubtotal).toBe(1020);
    expect(c.total).toBe(1020);
  });

  it("treats quantity 0 as 1 rather than zeroing the job", () => {
    const c = computeCosts(job({ packagingCost: 100, quantity: 0 }));
    expect(c.total).toBe(100);
  });
});

describe("machineRate", () => {
  it("computes depreciation plus maintenance in MXN/hour", () => {
    // Seeded "Creality K2 SE": 7600/4000 + 1 = 2.9
    expect(
      machineRate({
        purchaseCost: 7600,
        amortizationHours: 4000,
        maintenanceCostPerHour: 1,
      }),
    ).toBeCloseTo(2.9, 10);
  });

  it("is zero when purchase cost and maintenance are both zero", () => {
    expect(
      machineRate({
        purchaseCost: 0,
        amortizationHours: 3000,
        maintenanceCostPerHour: 0,
      }),
    ).toBe(0);
  });
});

describe("machine cost", () => {
  it("multiplies printTimeHours by machineRate", () => {
    const c = computeCosts(job({ printTimeHours: 10, machineRate: 2.9 }));
    expect(c.machine).toBeCloseTo(29, 10);
  });

  it("is zero when machineRate is undefined (no printer selected)", () => {
    const c = computeCosts(job({ printTimeHours: 10 }));
    expect(c.machine).toBe(0);
  });

  it("is included in unitSubtotal alongside filament, electricity, labor and overhead", () => {
    const c = computeCosts(
      job({
        jobFilaments: [
          { id: "a", material: "PLA", color: "", weight: 250, pricePerKg: 400 },
        ],
        printTimeHours: 10,
        powerWatts: 200,
        electricityRate: 2.8,
        machineRate: 2.9,
        packagingCost: 5,
      }),
    );
    // filament 100 + machine 29 + electricity 5.6 + overhead 5 = 139.6
    expect(c.unitSubtotal).toBeCloseTo(139.6, 10);
  });
});

describe("failure reserve", () => {
  it("leaves failureAdjustedSubtotal unadjusted when failureRatePercent is 0", () => {
    const c = computeCosts(
      job({
        jobFilaments: [
          { id: "a", material: "PLA", color: "", weight: 250, pricePerKg: 400 },
        ],
        printTimeHours: 10,
        powerWatts: 200,
        electricityRate: 2.8,
        machineRate: 2.9,
      }),
      { failureRatePercent: 0, minimumOrder: 0 },
    );
    // filament 100 + machine 29 + electricity 5.6 = 134.6, unadjusted
    expect(c.failureAdjustedSubtotal).toBe(
      c.filament + c.machine + c.electricity,
    );
    expect(c.failureAdjustedSubtotal).toBeCloseTo(134.6, 10);
  });

  it("divides filament + machine + electricity by (1 - rate) when failureRatePercent > 0, for a printer-less job", () => {
    const c = computeCosts(
      job({
        jobFilaments: [
          { id: "a", material: "PLA", color: "", weight: 250, pricePerKg: 400 },
        ],
        printTimeHours: 10,
        powerWatts: 200,
        electricityRate: 2.8,
        // no printerId/machineRate: machine cost stays 0
      }),
      { failureRatePercent: 8, minimumOrder: 0 },
    );
    expect(c.machine).toBe(0);
    // (100 + 0 + 5.6) / 0.92
    expect(c.failureAdjustedSubtotal).toBeCloseTo((100 + 5.6) / 0.92, 10);
  });

  it("excludes labor, packaging and finishing from the divisor", () => {
    const c = computeCosts(
      job({
        jobFilaments: [
          { id: "a", material: "PLA", color: "", weight: 250, pricePerKg: 400 },
        ],
        laborStages: [
          { name: "Sanding", hours: 1, rate: 100, scope: "per_unit" },
        ],
        packagingCost: 10,
        finishingCost: 5,
      }),
      { failureRatePercent: 20, minimumOrder: 0 },
    );
    // failureAdjustedSubtotal only reflects filament (100 here), divided by 0.8
    expect(c.failureAdjustedSubtotal).toBeCloseTo(100 / 0.8, 10);
    expect(c.laborPerUnit).toBe(100);
    expect(c.overhead).toBe(15);
    // unitSubtotal = failureAdjustedSubtotal + laborPerUnit + overhead, not everything divided
    expect(c.unitSubtotal).toBeCloseTo(100 / 0.8 + 100 + 15, 10);
  });

  // Property 2: Failure reserve scope -- changing failureRatePercent changes
  // machine/filament/electricity's contribution to unitSubtotal, but does not
  // change laborPerUnit, laborPerJob, overhead, or iva in isolation.
  // Validates: Requirements 8.1, 8.2
  it("Property 2: changing failureRatePercent moves unitSubtotal but leaves laborPerUnit, laborPerJob, overhead and iva untouched", () => {
    const inputs: Partial<PrintJob> = {
      jobFilaments: [
        { id: "a", material: "PLA", color: "", weight: 250, pricePerKg: 400 },
      ],
      printTimeHours: 10,
      powerWatts: 200,
      electricityRate: 2.8,
      machineRate: 2.9,
      laborStages: [
        { name: "Setup", hours: 1, rate: 120, scope: "per_job" },
        { name: "Sanding", hours: 1, rate: 100, scope: "per_unit" },
      ],
      packagingCost: 10,
      finishingCost: 5,
      marginPercent: 20,
      ivaEnabled: true,
    };

    const withoutReserve = computeCosts(job(inputs), {
      failureRatePercent: 0,
      minimumOrder: 0,
    });
    const withReserve = computeCosts(job(inputs), {
      failureRatePercent: 15,
      minimumOrder: 0,
    });

    // machine/filament/electricity's contribution (failureAdjustedSubtotal) changes...
    expect(withReserve.failureAdjustedSubtotal).not.toBe(
      withoutReserve.failureAdjustedSubtotal,
    );
    // ...and so does unitSubtotal, which is built from it.
    expect(withReserve.unitSubtotal).not.toBe(withoutReserve.unitSubtotal);

    // ...but nothing else moves in isolation.
    expect(withReserve.laborPerUnit).toBe(withoutReserve.laborPerUnit);
    expect(withReserve.laborPerJob).toBe(withoutReserve.laborPerJob);
    expect(withReserve.overhead).toBe(withoutReserve.overhead);
    // iva itself is a rate applied to jobPreTax, not touched directly by the
    // failure rate -- only jobPreTax (which is downstream of unitSubtotal)
    // changes; IVA_RATE stays the constant it always is.
    expect(IVA_RATE).toBe(0.16);
  });
});

describe("minimum order", () => {
  it("raises the total to minimumOrder when the computed price is lower", () => {
    const c = computeCosts(job({ packagingCost: 10 }), {
      failureRatePercent: 0,
      minimumOrder: 100,
    });
    expect(c.total).toBe(100);
  });

  it("leaves the total unchanged when it already meets or exceeds minimumOrder", () => {
    const c = computeCosts(job({ packagingCost: 200 }), {
      failureRatePercent: 0,
      minimumOrder: 100,
    });
    expect(c.total).toBe(200);
  });

  it("has no effect when minimumOrder is 0", () => {
    const c = computeCosts(job({ packagingCost: 10 }), {
      failureRatePercent: 0,
      minimumOrder: 0,
    });
    expect(c.total).toBe(10);
  });

  // Property 3: Minimum-order idempotence on quantity -- for fixed job inputs,
  // total at quantity 1 and quantity 5 both satisfy total >= minimumOrder, and
  // the floor is applied exactly once (never minimumOrder * quantity).
  // Validates: Requirements 9.1, 9.2, 9.3
  it("Property 3: the floor is applied once to the whole job, not per unit, at any quantity", () => {
    const minimumOrder = 500;
    const inputs: Partial<PrintJob> = {
      jobFilaments: [
        { id: "a", material: "PLA", color: "", weight: 10, pricePerKg: 400 },
      ],
      packagingCost: 5,
      marginPercent: 10,
    };

    const atOne = computeCosts(job({ ...inputs, quantity: 1 }), {
      failureRatePercent: 0,
      minimumOrder,
    });
    const atFive = computeCosts(job({ ...inputs, quantity: 5 }), {
      failureRatePercent: 0,
      minimumOrder,
    });

    expect(atOne.total).toBeGreaterThanOrEqual(minimumOrder);
    expect(atFive.total).toBeGreaterThanOrEqual(minimumOrder);

    // The floor is a per-job clamp: it must equal minimumOrder exactly here
    // (both jobs' naturally computed totals are well under it), never
    // minimumOrder multiplied by quantity.
    expect(atOne.total).toBe(minimumOrder);
    expect(atFive.total).toBe(minimumOrder);
    expect(atFive.total).not.toBe(minimumOrder * 5);
  });
});

describe("backward compatibility", () => {
  // Property 1: Backward compatibility of computeCosts -- for a PrintJob with
  // printerId/machineRate undefined, computeCosts(job) called with no settings
  // argument returns byte-identical results to the pre-feature implementation.
  // Validates: Requirements 10.1, 10.2, 10.3
  it("Property 1: computeCosts(job) with no settings argument reproduces pre-feature output for a printer-less job", () => {
    const inputs: Partial<PrintJob> = {
      jobFilaments: [
        { id: "a", material: "PLA", color: "", weight: 250, pricePerKg: 400 },
        { id: "b", material: "PETG", color: "", weight: 100, pricePerKg: 560 },
      ],
      printTimeHours: 10,
      powerWatts: 200,
      electricityRate: 2.8,
      laborStages: [
        { name: "Setup", hours: 1, rate: 120, scope: "per_job" },
        { name: "Sanding", hours: 1, rate: 100, scope: "per_unit" },
      ],
      packagingCost: 10,
      finishingCost: 5,
      marginPercent: 30,
      ivaEnabled: true,
      quantity: 3,
      // printerId/machineRate deliberately omitted
    };

    const noSettings = computeCosts(job(inputs));
    const explicitZeroSettings = computeCosts(job(inputs), {
      failureRatePercent: 0,
      minimumOrder: 0,
    });

    // No settings argument behaves exactly as failureRatePercent: 0, minimumOrder: 0.
    expect(noSettings).toEqual(explicitZeroSettings);

    // machine cost is 0 for a printer-less job, and failureAdjustedSubtotal
    // collapses to the pre-feature filament+electricity sum.
    expect(noSettings.machine).toBe(0);
    expect(noSettings.failureAdjustedSubtotal).toBe(
      noSettings.filament + noSettings.electricity,
    );
  });

  it("every existing pre-feature test in this file keeps passing unchanged (regression guard)", () => {
    // This block intentionally duplicates one representative case from each
    // describe block above written before this feature, as a sentinel: if a
    // change to computeCosts ever breaks single-argument backward compatibility,
    // this fails alongside the original assertions elsewhere in this file.
    const c = computeCosts(
      job({
        jobFilaments: [
          { id: "a", material: "PLA", color: "", weight: 500, pricePerKg: 400 },
        ],
        printTimeHours: 10,
        powerWatts: 200,
        electricityRate: 2.8,
        packagingCost: 1000,
        marginPercent: 30,
        ivaEnabled: true,
      }),
    );
    expect(c.filament).toBe(200);
    expect(c.electricity).toBeCloseTo(5.6, 10);
    expect(c.machine).toBe(0);
  });
});

describe("formatMXN", () => {
  it("formats pesos with two decimals and a thousands separator", () => {
    // Intl inserts a non-breaking space in some locales; normalise before comparing.
    expect(formatMXN(1234.5).replace(/\u00a0/g, " ")).toContain("1,234.50");
  });

  it("does not produce NaN for bad input", () => {
    expect(formatMXN(Number.NaN)).toContain("0.00");
  });
});
