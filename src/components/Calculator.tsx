import { useState } from 'react'
import { PrintJob, LaborStage, JobFilament, Filament } from '../types'
import { computeCosts, formatMXN, formatMXNPrecise, IVA_RATE } from '../pricing'

const defaultJob = (): Omit<PrintJob, 'id' | 'createdAt' | 'status'> => ({
  name: '',
  client: '',
  jobFilaments: [
    { id: crypto.randomUUID(), material: 'PLA', color: '', weight: 50, pricePerKg: 400 }
  ],
  printTimeHours: 2,
  powerWatts: 200,
  electricityRate: 2.8,
  laborStages: [
    { name: 'Slicing & Setup', hours: 0.25, rate: 120, scope: 'per_job' },
  ],
  packagingCost: 0,
  finishingCost: 0,
  marginPercent: 30,
  quantity: 1,
  ivaEnabled: false,
  notes: '',
})

export default function Calculator({ onAddToQueue, filaments }: { onAddToQueue: (job: PrintJob) => void, filaments: Filament[] }) {
  const [form, setForm] = useState(defaultJob())
  const [submitted, setSubmitted] = useState(false)

  const set = (k: keyof typeof form, v: unknown) => setForm(f => ({ ...f, [k]: v }))

  const handleFilamentSelect = (idx: number, filamentId: string) => {
    const f = filaments.find(x => x.id === filamentId)
    const newFilaments = [...form.jobFilaments]
    if (f) {
      newFilaments[idx] = { ...newFilaments[idx], filamentId, material: `${f.brand} ${f.type}`, color: f.color, pricePerKg: f.pricePerKg }
    } else {
      newFilaments[idx] = { ...newFilaments[idx], filamentId: '', material: '', color: '', pricePerKg: 0 }
    }
    set('jobFilaments', newFilaments)
  }
  
  const addFilament = () => set('jobFilaments', [...form.jobFilaments, { id: crypto.randomUUID(), material: '', color: '', weight: 0, pricePerKg: 0 }])
  const removeFilament = (i: number) => set('jobFilaments', form.jobFilaments.filter((_, idx) => idx !== i))
  const updateFilament = (i: number, k: keyof JobFilament, v: string | number) => {
    const newF = [...form.jobFilaments]
    newF[i] = { ...newF[i], [k]: v, filamentId: (k === 'material' || k === 'color' || k === 'pricePerKg') ? '' : newF[i].filamentId }
    set('jobFilaments', newF)
  }

  const addStage = () => set('laborStages', [...form.laborStages, { name: '', hours: 1, rate: 100, scope: 'per_unit' as const }])
  const removeStage = (i: number) => set('laborStages', form.laborStages.filter((_, idx) => idx !== i))
  const updateStage = (i: number, k: keyof LaborStage, v: string | number) =>
    set('laborStages', form.laborStages.map((s, idx) => idx === i ? { ...s, [k]: v } : s))

  const mockJob: PrintJob = { ...form, id: '', status: 'queued', createdAt: '' }
  const costs = computeCosts(mockJob)

  const handleSubmit = () => {
    if (!form.name.trim()) { setSubmitted(true); return }
    const job: PrintJob = {
      ...form,
      id: crypto.randomUUID(),
      status: 'queued',
      createdAt: new Date().toISOString(),
    }
    onAddToQueue(job)
    setForm(defaultJob())
    setSubmitted(false)
  }

  const error = submitted && !form.name.trim()

  return (
    <>
    <div className="calc-layout">
      {/* Left: Data Entry */}
      <div className="flex flex-col gap-6">
        
        {/* Section: IDENTIFICATION */}
        <div style={blockStyle}>
          <div style={blockHeaderStyle}>01 // IDENTIFICATION</div>
          <div className="ident-grid">
            <Field label="JOB NAME" error={error}>
              <Input value={form.name} onChange={e => set('name', e.target.value)} placeholder="e.g. Mechanical Enclosure" />
            </Field>
            <Field label="CLIENT">
              <Input value={form.client} onChange={e => set('client', e.target.value)} placeholder="Internal / Name" />
            </Field>
            <Field label="QTY">
              <Input type="number" min={1} value={form.quantity} onChange={e => set('quantity', Math.max(1, +e.target.value))} />
            </Field>
          </div>
        </div>

        {/* Section: FILAMENT & MATERIAL */}
        <div style={blockStyle}>
          <div style={{ ...blockHeaderStyle, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span>02 // MATERIAL SOURCE</span>
            <button onClick={addFilament} style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--color-text)', background: 'var(--color-surface-2)', border: '1px solid var(--color-border)', borderRadius: 2, padding: '4px 8px', cursor: 'pointer' }}>+ ADD MATERIAL</button>
          </div>
          
          <div className="flex flex-col gap-4">
            {(form.jobFilaments || []).map((f, i) => (
              <div key={f.id} style={{ background: 'var(--color-surface-2)', border: '1px solid var(--color-border)', padding: 16 }}>
                <div className="flex justify-between items-center mb-4">
                  <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 700, color: 'var(--color-text-dim)' }}>MATERIAL {i+1}</div>
                  {(form.jobFilaments || []).length > 1 && <button onClick={() => removeFilament(i)} style={{ fontFamily: 'var(--font-mono)', fontSize: 16, color: 'var(--color-red)', background: 'none', border: 'none', cursor: 'pointer' }}>×</button>}
                </div>
                
                <div className="mb-4">
                  <select 
                    value={f.filamentId || ''} 
                    onChange={e => handleFilamentSelect(i, e.target.value)}
                    style={{ ...inputStyle, padding: '8px', cursor: 'pointer' }}
                  >
                    <option value="">CUSTOM ENTRY</option>
                    {filaments.map(inv => (
                      <option key={inv.id} value={inv.id}>{inv.brand} {inv.type} - {inv.color} ({formatMXN(inv.pricePerKg)}/kg)</option>
                    ))}
                  </select>
                </div>

                <div className="mat-grid">
                  <Field label="MATERIAL">
                    <Input value={f.material} onChange={e => updateFilament(i, 'material', e.target.value)} placeholder="PLA, PETG..." disabled={!!f.filamentId} style={{ opacity: f.filamentId ? 0.5 : 1, padding: '8px' }} />
                  </Field>
                  <Field label="COLOR">
                    <Input value={f.color} onChange={e => updateFilament(i, 'color', e.target.value)} placeholder="Black" disabled={!!f.filamentId} style={{ opacity: f.filamentId ? 0.5 : 1, padding: '8px' }} />
                  </Field>
                  <Field label="MXN/KG">
                    <Input type="number" step={0.01} value={f.pricePerKg} onChange={e => updateFilament(i, 'pricePerKg', +e.target.value)} disabled={!!f.filamentId} style={{ opacity: f.filamentId ? 0.5 : 1, padding: '8px' }} />
                  </Field>
                  <Field label="WEIGHT (G)">
                    <Input type="number" min={0} step={0.1} value={f.weight} onChange={e => updateFilament(i, 'weight', +e.target.value)} style={{ padding: '8px', borderColor: 'var(--color-orange)' }} />
                  </Field>
                </div>
              </div>
            ))}
          </div>

          <div className="mt-4 p-4 flex justify-between items-center" style={{ background: 'var(--color-orange-bg)', border: '1px solid var(--color-orange-dim)' }}>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--color-orange)', letterSpacing: '0.1em' }}>TOTAL MATERIAL (PER UNIT)</div>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 24, fontWeight: 700, color: 'var(--color-orange)' }}>{formatMXNPrecise(costs.filament)}</div>
          </div>
        </div>

        {/* Section: ENERGY */}
        <div style={blockStyle}>
          <div style={blockHeaderStyle}>03 // ENERGY CONSUMPTION</div>
          <div className="field-grid-3">
            <Field label="PRINT TIME (HOURS)">
              <Input type="number" min={0} step={0.25} value={form.printTimeHours} onChange={e => set('printTimeHours', +e.target.value)} />
            </Field>
            <Field label="AVG POWER (WATTS)">
              <Input type="number" min={0} step={10} value={form.powerWatts} onChange={e => set('powerWatts', +e.target.value)} />
            </Field>
            <Field label="RATE (MXN/KWH)">
              <Input type="number" min={0} step={0.01} value={form.electricityRate} onChange={e => set('electricityRate', +e.target.value)} />
            </Field>
          </div>
        </div>

        {/* Section: LABOR & OVERHEAD */}
        <div style={blockStyle}>
          <div style={{ ...blockHeaderStyle, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span>04 // LABOR & OVERHEAD</span>
            <button onClick={addStage} style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--color-text)', background: 'var(--color-surface-2)', border: '1px solid var(--color-border)', borderRadius: 2, padding: '4px 8px', cursor: 'pointer' }}>+ ADD LABOR STAGE</button>
          </div>
          
          <div className="field-grid-2 mb-6">
             <Field label="PACKAGING (MXN / UNIT)">
              <Input type="number" min={0} step={0.1} value={form.packagingCost} onChange={e => set('packagingCost', +e.target.value)} />
            </Field>
            <Field label="MISC FINISHING (MXN / UNIT)">
              <Input type="number" min={0} step={0.1} value={form.finishingCost} onChange={e => set('finishingCost', +e.target.value)} />
            </Field>
          </div>

          <div className="flex flex-col gap-2">
            {(form.laborStages || []).map((stage, i) => (
              <div key={i} className="labor-row" style={{ background: 'var(--color-surface-2)', padding: 8, border: '1px solid var(--color-border)' }}>
                <span className="labor-index" style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--color-text-dim)', padding: '0 8px' }}>{i+1}</span>
                <input className="labor-name" value={stage.name} onChange={e => updateStage(i, 'name', e.target.value)} placeholder="Stage Name" style={inlineInput} />
                <input className="labor-num" type="number" min={0} step={0.25} value={stage.hours} onChange={e => updateStage(i, 'hours', +e.target.value)} style={inlineInput} aria-label="Horas" />
                <span className="labor-unit" style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--color-text-muted)' }}>hrs @</span>
                <input className="labor-num" type="number" min={0} step={1} value={stage.rate} onChange={e => updateStage(i, 'rate', +e.target.value)} style={inlineInput} aria-label="Tarifa por hora" />
                <select
                  className="labor-scope"
                  value={stage.scope || 'per_unit'}
                  onChange={e => updateStage(i, 'scope', e.target.value)}
                  title="Per job = charged once (setup, slicing). Per unit = charged for every part."
                  style={inlineInput}
                >
                  <option value="per_job">ONCE / JOB</option>
                  <option value="per_unit">EACH UNIT</option>
                </select>
                <button className="labor-del" onClick={() => removeStage(i)} aria-label="Quitar etapa" style={{ padding: '0 12px', color: 'var(--color-red)', background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'var(--font-mono)' }}>×</button>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Right: Summary Panel */}
      <div className="calc-summary" style={{ background: '#fff', color: '#000', padding: 24, border: '2px solid #fff' }}>
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 700, letterSpacing: '0.1em', marginBottom: 24, borderBottom: '2px solid #000', paddingBottom: 8 }}>
          PER UNIT ESTIMATE
        </div>
        
        <div className="flex flex-col gap-3 mb-6">
          <CostRow label="MATERIAL" value={costs.filament} />
          <CostRow label="ENERGY" value={costs.electricity} />
          <CostRow label="LABOR / UNIT" value={costs.laborPerUnit} />
          <CostRow label="OVERHEAD" value={costs.overhead} />
        </div>

        <div style={{ borderTop: '2px solid #e5e5e5', paddingTop: 16, marginBottom: 24 }}>
          <div className="flex justify-between items-end mb-1">
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, fontWeight: 700 }}>UNIT SUBTOTAL</span>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 14, fontWeight: 700 }}>{formatMXN(costs.unitSubtotal)}</span>
          </div>
          <div className="flex justify-between items-center">
            <div className="flex items-center gap-2">
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, fontWeight: 700 }}>MARKUP %</span>
              <input type="number" value={form.marginPercent} onChange={e => set('marginPercent', +e.target.value)} style={{ width: 60, background: '#f5f5f5', border: '1px solid #ccc', padding: '2px 6px', fontFamily: 'var(--font-mono)', fontSize: 12, color: '#000' }} />
            </div>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: '#666' }}>+{formatMXN(costs.unitMargin)}</span>
          </div>
        </div>

        <div style={{ background: 'var(--color-orange)', padding: '16px', margin: '0 -24px 24px -24px' }}>
          <div className="flex justify-between items-baseline mb-1">
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 700, color: '#000' }}>UNIT PRICE</span>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 28, fontWeight: 700, color: '#000', letterSpacing: '-0.02em' }}>{formatMXN(costs.unitPrice)}</span>
          </div>

          <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid rgba(0,0,0,0.2)' }}>
            {form.quantity > 1 && (
              <div className="flex justify-between items-baseline" style={{ marginBottom: 4 }}>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: '#000', opacity: 0.8 }}>× {form.quantity} UNITS</span>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: '#000' }}>{formatMXN(costs.unitPrice * form.quantity)}</span>
              </div>
            )}
            {costs.laborPerJob > 0 && (
              <div className="flex justify-between items-baseline" style={{ marginBottom: 4 }}>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: '#000', opacity: 0.8 }}>SETUP (ONCE)</span>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: '#000' }}>
                  +{formatMXN(costs.laborPerJob * (1 + (form.marginPercent || 0) / 100))}
                </span>
              </div>
            )}

            {/* IVA toggle */}
            <div className="flex justify-between items-center" style={{ marginTop: 8, paddingTop: 8, borderTop: '1px dashed rgba(0,0,0,0.25)' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={!!form.ivaEnabled}
                  onChange={e => set('ivaEnabled', e.target.checked)}
                  style={{ cursor: 'pointer', width: 14, height: 14, accentColor: '#000' }}
                />
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, fontWeight: 700, color: '#000' }}>
                  IVA {(IVA_RATE * 100).toFixed(0)}%
                </span>
              </label>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: '#000', opacity: form.ivaEnabled ? 1 : 0.45 }}>
                +{formatMXN(costs.iva)}
              </span>
            </div>

            <div className="flex justify-between items-baseline" style={{ marginTop: 8, paddingTop: 8, borderTop: '2px solid #000' }}>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 700, color: '#000' }}>
                TOTAL {form.ivaEnabled ? 'C/ IVA' : 'S/ IVA'}
              </span>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 18, fontWeight: 700, color: '#000' }}>{formatMXN(costs.total)}</span>
            </div>
          </div>
        </div>

        <button
          onClick={handleSubmit}
          style={{ width: '100%', background: '#000', color: '#fff', fontFamily: 'var(--font-mono)', fontSize: 14, fontWeight: 700, letterSpacing: '0.1em', padding: '16px', border: 'none', cursor: 'pointer', transition: 'transform 0.1s' }}
          onMouseDown={e => (e.currentTarget.style.transform = 'scale(0.98)')}
          onMouseUp={e => (e.currentTarget.style.transform = 'scale(1)')}
          onMouseLeave={e => (e.currentTarget.style.transform = 'scale(1)')}
        >
          CONFIRM & QUEUE
        </button>
      </div>
    </div>

    {/*
      Phone/tablet only. With the summary panel stacked below a long form, the
      price would otherwise be off-screen for the whole of data entry — which is
      the one number being entered for.
    */}
    <div className="calc-mobile-bar">
      <div style={{ minWidth: 0 }}>
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9, fontWeight: 700, color: 'var(--color-text-muted)', letterSpacing: '0.1em' }}>
          TOTAL {form.ivaEnabled ? 'C/ IVA' : 'S/ IVA'}
          {form.quantity > 1 && ` · ${form.quantity} U`}
        </div>
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 20, fontWeight: 700, color: 'var(--color-orange)', lineHeight: 1.2 }}>
          {formatMXN(costs.total)}
        </div>
      </div>
      <button
        onClick={handleSubmit}
        style={{ flexShrink: 0, background: 'var(--color-text)', color: '#000', fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 700, letterSpacing: '0.08em', padding: '12px 16px', border: 'none', cursor: 'pointer' }}
      >
        QUEUE
      </button>
    </div>
    </>
  )
}

function Field({ label, children, error }: { label: string; children: React.ReactNode; error?: boolean }) {
  return (
    <div>
      <label style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: error ? 'var(--color-red)' : 'var(--color-text-muted)', letterSpacing: '0.08em', display: 'block', marginBottom: 6 }}>
        {label} {error && '*'}
      </label>
      {children}
    </div>
  )
}

const Input = (props: React.InputHTMLAttributes<HTMLInputElement>) => (
  <input {...props} style={{ ...inputStyle, ...props.style }} />
)

function CostRow({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex justify-between items-center">
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: '#666' }}>{label}</span>
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 13, fontWeight: 700, color: '#000' }}>{formatMXN(value)}</span>
    </div>
  )
}

const blockStyle: React.CSSProperties = {
  background: 'var(--color-surface)', 
  border: '1px solid var(--color-border)', 
  padding: 24 
}

const blockHeaderStyle: React.CSSProperties = {
  fontFamily: 'var(--font-mono)', 
  fontSize: 12, 
  fontWeight: 700, 
  color: 'var(--color-text)', 
  letterSpacing: '0.1em', 
  marginBottom: 20, 
  borderBottom: '1px solid var(--color-border)', 
  paddingBottom: 12 
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  background: 'var(--color-background)',
  border: '1px solid var(--color-border)',
  padding: '10px 12px',
  color: 'var(--color-text)',
  fontFamily: 'var(--font-mono)',
  fontSize: 13,
  outline: 'none',
}

const inlineInput: React.CSSProperties = {
  background: 'var(--color-background)',
  border: '1px solid var(--color-border)',
  padding: '6px 8px',
  color: 'var(--color-text)',
  fontFamily: 'var(--font-mono)',
  fontSize: 12,
  outline: 'none',
}
