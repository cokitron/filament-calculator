import { useState } from 'react'
import { Filament } from '../types'
import { formatMXN } from '../pricing'

export default function Filaments({ filaments, onAdd, onRemove }: {
  filaments: Filament[]
  onAdd: (f: Omit<Filament, 'id'>) => Promise<void>
  onRemove: (id: string) => Promise<void>
}) {
  const [adding, setAdding] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [form, setForm] = useState<Omit<Filament, 'id'>>({ brand: '', type: 'PLA', color: '', hex: '#ffffff', pricePerKg: 400 })

  const set = (k: keyof typeof form, v: unknown) => setForm(f => ({ ...f, [k]: v }))

  const handleAdd = async () => {
    if (!form.brand.trim() || !form.color.trim()) {
      setError('Marca y color son obligatorios')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await onAdd(form)
      setAdding(false)
      setForm({ brand: '', type: 'PLA', color: '', hex: '#ffffff', pricePerKg: 400 })
    } catch (err) {
      // The unique index on brand/type/color rejects duplicates; show why
      // rather than letting the click appear to do nothing.
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const handleRemove = async (id: string) => {
    setBusy(true)
    try {
      await onRemove(id)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="max-w-4xl mx-auto">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between mb-8">
        <div>
          <h2 style={{ fontFamily: 'var(--font-mono)', fontSize: 16, fontWeight: 700, letterSpacing: '0.05em' }}>FILAMENT INVENTORY</h2>
          <p style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--color-text-muted)', marginTop: 4 }}>Manage presets for quick calculator selection</p>
        </div>
        <button
          onClick={() => setAdding(!adding)}
          style={{ fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 700, color: '#000', background: 'var(--color-orange)', padding: '8px 16px', borderRadius: 4, cursor: 'pointer', letterSpacing: '0.05em' }}
        >
          {adding ? 'CANCEL' : '+ ADD FILAMENT'}
        </button>
      </div>

      {adding && (
        <div style={{ background: 'var(--color-surface)', border: '1px solid var(--color-orange)', borderRadius: 6, padding: 24, marginBottom: 24 }}>
          <h3 style={{ fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 700, letterSpacing: '0.1em', marginBottom: 16, color: 'var(--color-orange)' }}>NEW FILAMENT</h3>
          <div className="form-grid-auto">
            <div>
              <label style={{ display: 'block', fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--color-text-muted)', marginBottom: 6 }}>BRAND</label>
              <input value={form.brand} onChange={e => set('brand', e.target.value)} placeholder="e.g. Polymaker" style={inputStyle} />
            </div>
            <div>
              <label style={{ display: 'block', fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--color-text-muted)', marginBottom: 6 }}>TYPE</label>
              <input value={form.type} onChange={e => set('type', e.target.value)} placeholder="e.g. PLA+" style={inputStyle} />
            </div>
            <div>
              <label style={{ display: 'block', fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--color-text-muted)', marginBottom: 6 }}>COLOR NAME</label>
              <input value={form.color} onChange={e => set('color', e.target.value)} placeholder="e.g. Army Green" style={inputStyle} />
            </div>
            <div>
              <label style={{ display: 'block', fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--color-text-muted)', marginBottom: 6 }}>HEX CODE</label>
              <div style={{ display: 'flex', gap: 8 }}>
                <input type="color" value={form.hex} onChange={e => set('hex', e.target.value)} style={{ width: 32, height: 32, padding: 0, border: '1px solid var(--color-border)', borderRadius: 4, cursor: 'pointer', background: 'none' }} />
                <input value={form.hex} onChange={e => set('hex', e.target.value)} style={{ ...inputStyle, flex: 1 }} />
              </div>
            </div>
            <div>
              <label style={{ display: 'block', fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--color-text-muted)', marginBottom: 6 }}>PRECIO (MXN/KG)</label>
              <input type="number" step={0.01} value={form.pricePerKg} onChange={e => set('pricePerKg', +e.target.value)} style={inputStyle} />
            </div>
          </div>
          <div className="flex flex-wrap justify-end mt-6 items-center gap-4">
            {error && (
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--color-red)' }}>{error}</span>
            )}
            <button onClick={handleAdd} disabled={busy} style={{ fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 700, color: '#000', background: 'var(--color-green)', padding: '8px 24px', borderRadius: 4, cursor: busy ? 'wait' : 'pointer', letterSpacing: '0.05em', opacity: busy ? 0.6 : 1 }}>
              {busy ? 'GUARDANDO...' : 'GUARDAR'}
            </button>
          </div>
        </div>
      )}

      <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))' }}>
        {filaments.map(f => (
          <div key={f.id} style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: 6, padding: 20, display: 'flex', flexDirection: 'column' }}>
            <div className="flex justify-between items-start mb-4">
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <div style={{ width: 24, height: 24, borderRadius: '50%', backgroundColor: f.hex, border: '1px solid #333' }} />
                <div>
                  <div style={{ fontFamily: 'var(--font-mono)', fontSize: 14, fontWeight: 700, color: 'var(--color-text)' }}>{f.brand} {f.type}</div>
                  <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--color-text-muted)' }}>{f.color}</div>
                </div>
              </div>
              <button onClick={() => handleRemove(f.id)} style={{ color: 'var(--color-text-dim)', background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'var(--font-mono)', fontSize: 16 }}>×</button>
            </div>
            <div style={{ marginTop: 'auto', paddingTop: 16, borderTop: '1px dashed var(--color-border-bright)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--color-text-muted)' }}>COSTO/KG</span>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 13, fontWeight: 700, color: 'var(--color-orange)' }}>{formatMXN(f.pricePerKg)}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  background: 'var(--color-surface-2)',
  border: '1px solid var(--color-border)',
  borderRadius: 4,
  padding: '8px 10px',
  color: 'var(--color-text)',
  fontFamily: 'var(--font-mono)',
  fontSize: 12,
}
