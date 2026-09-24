import { describe, it, expect } from 'vitest'
import { computeCosts, formatMXN, IVA_RATE } from './pricing'
import { PrintJob } from './types'

/** A job with every cost isolated so each assertion tests one thing. */
function job(overrides: Partial<PrintJob> = {}): PrintJob {
  return {
    id: 'test',
    name: 'Test',
    client: '',
    status: 'queued',
    jobFilaments: [],
    printTimeHours: 0,
    powerWatts: 0,
    electricityRate: 0,
    laborStages: [],
    packagingCost: 0,
    finishingCost: 0,
    marginPercent: 0,
    quantity: 1,
    notes: '',
    createdAt: '',
    ...overrides,
  }
}

describe('material cost', () => {
  it('converts grams to kilograms', () => {
    const c = computeCosts(job({
      jobFilaments: [{ id: 'a', material: 'PLA', color: '', weight: 500, pricePerKg: 400 }],
    }))
    // 500 g = 0.5 kg at $400/kg = $200
    expect(c.filament).toBe(200)
  })

  it('sums multiple materials', () => {
    const c = computeCosts(job({
      jobFilaments: [
        { id: 'a', material: 'PLA', color: '', weight: 250, pricePerKg: 400 },
        { id: 'b', material: 'PETG', color: '', weight: 100, pricePerKg: 560 },
      ],
    }))
    expect(c.filament).toBeCloseTo(100 + 56, 10)
  })
})

describe('energy cost', () => {
  it('multiplies hours by kilowatts by rate', () => {
    const c = computeCosts(job({ printTimeHours: 10, powerWatts: 200, electricityRate: 2.8 }))
    // 10 h × 0.2 kW × $2.8/kWh = $5.60
    expect(c.electricity).toBeCloseTo(5.6, 10)
  })
})

describe('labor scope', () => {
  const setup = { name: 'Setup', hours: 1, rate: 120, scope: 'per_job' as const }
  const sanding = { name: 'Sanding', hours: 1, rate: 100, scope: 'per_unit' as const }

  it('separates per-job from per-unit labor', () => {
    const c = computeCosts(job({ laborStages: [setup, sanding] }))
    expect(c.laborPerJob).toBe(120)
    expect(c.laborPerUnit).toBe(100)
  })

  it('charges per-job labor exactly once regardless of quantity', () => {
    const one = computeCosts(job({ laborStages: [setup], quantity: 1 }))
    const fifty = computeCosts(job({ laborStages: [setup], quantity: 50 }))
    // This is the bug fix: setup used to be multiplied by quantity.
    expect(one.total).toBe(120)
    expect(fifty.total).toBe(120)
  })

  it('scales per-unit labor with quantity', () => {
    const c = computeCosts(job({ laborStages: [sanding], quantity: 10 }))
    expect(c.total).toBe(1000)
  })

  it('treats legacy stages with no scope as per-unit', () => {
    // Records saved before the scope field existed must price as they did before.
    const legacy = computeCosts(job({ laborStages: [{ name: 'Old', hours: 1, rate: 100 }], quantity: 3 }))
    expect(legacy.laborPerUnit).toBe(100)
    expect(legacy.laborPerJob).toBe(0)
    expect(legacy.total).toBe(300)
  })
})

describe('markup', () => {
  it('applies the markup percentage to cost', () => {
    const c = computeCosts(job({ packagingCost: 100, marginPercent: 30 }))
    expect(c.unitSubtotal).toBe(100)
    expect(c.unitMargin).toBe(30)
    expect(c.unitPrice).toBe(130)
  })

  it('applies markup to per-job labor as well', () => {
    const c = computeCosts(job({
      laborStages: [{ name: 'Setup', hours: 1, rate: 100, scope: 'per_job' }],
      marginPercent: 50,
    }))
    expect(c.total).toBe(150)
  })
})

describe('IVA', () => {
  it('is not charged when disabled', () => {
    const c = computeCosts(job({ packagingCost: 1000, ivaEnabled: false }))
    expect(c.iva).toBe(0)
    expect(c.total).toBe(1000)
  })

  it('is not charged when the flag is absent (legacy records)', () => {
    const c = computeCosts(job({ packagingCost: 1000 }))
    expect(c.iva).toBe(0)
    expect(c.total).toBe(1000)
  })

  it('adds 16% of the pre-tax sale price when enabled', () => {
    const c = computeCosts(job({ packagingCost: 1000, ivaEnabled: true }))
    expect(c.jobPreTax).toBe(1000)
    expect(c.iva).toBe(160)
    expect(c.total).toBe(1160)
  })

  it('is charged after markup, not before', () => {
    const c = computeCosts(job({ packagingCost: 1000, marginPercent: 30, ivaEnabled: true }))
    // Cost 1000 -> +30% markup = 1300 -> +16% IVA = 1508
    expect(c.jobPreTax).toBe(1300)
    expect(c.iva).toBeCloseTo(208, 10)
    expect(c.total).toBeCloseTo(1508, 10)
    // Guard against the inverted order (IVA first, then markup): 1000*1.16*1.3 = 1508 too.
    // So assert the intermediate instead, which differs: pre-tax must be 1300, not 1160.
    expect(c.jobPreTax).not.toBe(1160)
  })

  it('taxes per-job labor too', () => {
    const c = computeCosts(job({
      laborStages: [{ name: 'Setup', hours: 1, rate: 100, scope: 'per_job' }],
      ivaEnabled: true,
    }))
    expect(c.total).toBeCloseTo(116, 10)
  })

  it('uses the documented rate', () => {
    expect(IVA_RATE).toBe(0.16)
  })
})

describe('quantity', () => {
  it('scales per-unit costs but not per-job costs', () => {
    const c = computeCosts(job({
      jobFilaments: [{ id: 'a', material: 'PLA', color: '', weight: 100, pricePerKg: 400 }],
      laborStages: [
        { name: 'Setup', hours: 1, rate: 120, scope: 'per_job' },
        { name: 'Finish', hours: 0.5, rate: 100, scope: 'per_unit' },
      ],
      quantity: 10,
      marginPercent: 0,
    }))
    // Per unit: 40 material + 50 finishing = 90. Ten units = 900. Plus 120 setup once.
    expect(c.unitSubtotal).toBe(90)
    expect(c.jobSubtotal).toBe(1020)
    expect(c.total).toBe(1020)
  })

  it('treats quantity 0 as 1 rather than zeroing the job', () => {
    const c = computeCosts(job({ packagingCost: 100, quantity: 0 }))
    expect(c.total).toBe(100)
  })
})

describe('formatMXN', () => {
  it('formats pesos with two decimals and a thousands separator', () => {
    // Intl inserts a non-breaking space in some locales; normalise before comparing.
    expect(formatMXN(1234.5).replace(/\u00a0/g, ' ')).toContain('1,234.50')
  })

  it('does not produce NaN for bad input', () => {
    expect(formatMXN(Number.NaN)).toContain('0.00')
  })
})
