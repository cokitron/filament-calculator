import { useState } from 'react'
import { Printer, PrinterStatus } from '../types'
import { Settings } from '../db/repository'
import { formatMXN, machineRate } from '../pricing'

type PrinterForm = {
  name: string
  model: string
  purchaseCost: number
  amortizationHours: number
  maintenanceCostPerHour: number
  powerWatts: number
}

const emptyPrinterForm: PrinterForm = {
  name: '',
  model: '',
  purchaseCost: 0,
  amortizationHours: 3000,
  maintenanceCostPerHour: 0,
  powerWatts: 200,
}

function toPrinterForm(p: Printer): PrinterForm {
  return {
    name: p.name,
    model: p.model ?? '',
    purchaseCost: p.purchaseCost,
    amortizationHours: p.amortizationHours,
    maintenanceCostPerHour: p.maintenanceCostPerHour,
    powerWatts: p.powerWatts,
  }
}

/**
 * Shop-wide settings screen: global failure rate / minimum order, plus the
 * printer fleet (add / edit / deactivate). Modeled on Filaments.tsx -- a list
 * + inline add/edit form + status toggle, no modal, no router.
 *
 * Props follow the same convention App.tsx already uses for Filaments: the
 * parent owns the data (`printers`, `settings`) and passes down callbacks that
 * call `db.*` and then `refresh()`. This component never imports `db/client`
 * directly.
 */
export default function ShopSettings({
  printers,
  settings,
  onAddPrinter,
  onUpdatePrinter,
  onSetPrinterStatus,
  onUpdateSettings,
}: {
  printers: Printer[]
  settings: Settings
  onAddPrinter: (p: Omit<Printer, 'id' | 'status'>) => Promise<void>
  onUpdatePrinter: (id: string, patch: Partial<Omit<Printer, 'id' | 'status'>>) => Promise<void>
  onSetPrinterStatus: (id: string, status: PrinterStatus) => Promise<void>
  onUpdateSettings: (patch: Partial<Settings>) => Promise<void>
}) {
  // --- Global settings ------------------------------------------------------

  const [failureRateInput, setFailureRateInput] = useState(String(settings.failureRatePercent ?? 8))
  const [minimumOrderInput, setMinimumOrderInput] = useState(String(settings.minimumOrder ?? 0))
  const [settingsBusy, setSettingsBusy] = useState(false)
  const [settingsError, setSettingsError] = useState<string | null>(null)

  const handleFailureRateBlur = async () => {
    const value = Number(failureRateInput)
    if (!Number.isFinite(value) || value < 0 || value >= 100) {
      setSettingsError('La tasa de fallo debe estar entre 0 y 99')
      setFailureRateInput(String(settings.failureRatePercent ?? 8))
      return
    }
    setSettingsError(null)
    setSettingsBusy(true)
    try {
      await onUpdateSettings({ failureRatePercent: value })
    } catch (err) {
      setSettingsError(err instanceof Error ? err.message : String(err))
      setFailureRateInput(String(settings.failureRatePercent ?? 8))
    } finally {
      setSettingsBusy(false)
    }
  }

  const handleMinimumOrderBlur = async () => {
    const value = Number(minimumOrderInput)
    if (!Number.isFinite(value) || value < 0) {
      setSettingsError('El pedido mínimo no puede ser negativo')
      setMinimumOrderInput(String(settings.minimumOrder ?? 0))
      return
    }
    setSettingsError(null)
    setSettingsBusy(true)
    try {
      await onUpdateSettings({ minimumOrder: value })
    } catch (err) {
      setSettingsError(err instanceof Error ? err.message : String(err))
      setMinimumOrderInput(String(settings.minimumOrder ?? 0))
    } finally {
      setSettingsBusy(false)
    }
  }

  // --- Printer fleet ---------------------------------------------------------

  const [adding, setAdding] = useState(false)
  const [addForm, setAddForm] = useState<PrinterForm>(emptyPrinterForm)
  const [addBusy, setAddBusy] = useState(false)
  const [addError, setAddError] = useState<string | null>(null)

  const [editingId, setEditingId] = useState<string | null>(null)
  const [editForm, setEditForm] = useState<PrinterForm>(emptyPrinterForm)
  const [editBusy, setEditBusy] = useState(false)
  const [editError, setEditError] = useState<string | null>(null)

  const [statusBusyId, setStatusBusyId] = useState<string | null>(null)

  const setAddField = (k: keyof PrinterForm, v: unknown) => setAddForm(f => ({ ...f, [k]: v }))
  const setEditField = (k: keyof PrinterForm, v: unknown) => setEditForm(f => ({ ...f, [k]: v }))

  const handleAddPrinter = async () => {
    if (!addForm.name.trim()) {
      setAddError('El nombre es obligatorio')
      return
    }
    setAddBusy(true)
    setAddError(null)
    try {
      await onAddPrinter({
        name: addForm.name.trim(),
        model: addForm.model.trim() || null,
        purchaseCost: addForm.purchaseCost,
        amortizationHours: addForm.amortizationHours,
        maintenanceCostPerHour: addForm.maintenanceCostPerHour,
        powerWatts: addForm.powerWatts,
      })
      setAdding(false)
      setAddForm(emptyPrinterForm)
    } catch (err) {
      setAddError(err instanceof Error ? err.message : String(err))
    } finally {
      setAddBusy(false)
    }
  }

  const startEdit = (p: Printer) => {
    setEditingId(p.id)
    setEditForm(toPrinterForm(p))
    setEditError(null)
  }

  const cancelEdit = () => {
    setEditingId(null)
    setEditError(null)
  }

  const handleSaveEdit = async (id: string) => {
    if (!editForm.name.trim()) {
      setEditError('El nombre es obligatorio')
      return
    }
    setEditBusy(true)
    setEditError(null)
    try {
      await onUpdatePrinter(id, {
        name: editForm.name.trim(),
        model: editForm.model.trim() || null,
        purchaseCost: editForm.purchaseCost,
        amortizationHours: editForm.amortizationHours,
        maintenanceCostPerHour: editForm.maintenanceCostPerHour,
        powerWatts: editForm.powerWatts,
      })
      setEditingId(null)
    } catch (err) {
      setEditError(err instanceof Error ? err.message : String(err))
    } finally {
      setEditBusy(false)
    }
  }

  const handleToggleStatus = async (p: Printer) => {
    const nextStatus: PrinterStatus = p.status === 'active' ? 'retired' : 'active'
    setStatusBusyId(p.id)
    try {
      await onSetPrinterStatus(p.id, nextStatus)
    } catch (err) {
      setAddError(err instanceof Error ? err.message : String(err))
    } finally {
      setStatusBusyId(null)
    }
  }

  const previewRate = machineRate({
    purchaseCost: addForm.purchaseCost,
    amortizationHours: addForm.amortizationHours || 1,
    maintenanceCostPerHour: addForm.maintenanceCostPerHour,
  })

  return (
    <div className="max-w-4xl mx-auto">
      {/* --- Global settings ---------------------------------------------- */}
      <div className="mb-8">
        <h2 style={{ fontFamily: 'var(--font-mono)', fontSize: 16, fontWeight: 700, letterSpacing: '0.05em' }}>SHOP SETTINGS</h2>
        <p style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--color-text-muted)', marginTop: 4 }}>Global pricing assumptions and printer fleet</p>
      </div>

      <div style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: 6, padding: 24, marginBottom: 24 }}>
        <h3 style={{ fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 700, letterSpacing: '0.1em', marginBottom: 16, color: 'var(--color-text)' }}>GLOBAL</h3>
        <div className="form-grid-auto">
          <div>
            <label style={{ display: 'block', fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--color-text-muted)', marginBottom: 6 }}>FAILURE RATE %</label>
            <input
              type="number"
              step={1}
              min={0}
              max={99}
              value={failureRateInput}
              onChange={e => setFailureRateInput(e.target.value)}
              onBlur={handleFailureRateBlur}
              disabled={settingsBusy}
              style={inputStyle}
            />
          </div>
          <div>
            <label style={{ display: 'block', fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--color-text-muted)', marginBottom: 6 }}>MINIMUM ORDER (MXN)</label>
            <input
              type="number"
              step={0.01}
              min={0}
              value={minimumOrderInput}
              onChange={e => setMinimumOrderInput(e.target.value)}
              onBlur={handleMinimumOrderBlur}
              disabled={settingsBusy}
              style={inputStyle}
            />
          </div>
        </div>
        {settingsError && (
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--color-red)', marginTop: 12 }}>{settingsError}</div>
        )}
      </div>

      {/* --- Printer fleet -------------------------------------------------- */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between mb-4">
        <h3 style={{ fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 700, letterSpacing: '0.1em', color: 'var(--color-text)' }}>PRINTER FLEET</h3>
        <button
          onClick={() => setAdding(!adding)}
          style={{ fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 700, color: '#000', background: 'var(--color-orange)', padding: '8px 16px', borderRadius: 4, cursor: 'pointer', letterSpacing: '0.05em' }}
        >
          {adding ? 'CANCEL' : '+ ADD PRINTER'}
        </button>
      </div>

      {adding && (
        <div style={{ background: 'var(--color-surface)', border: '1px solid var(--color-orange)', borderRadius: 6, padding: 24, marginBottom: 24 }}>
          <h4 style={{ fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 700, letterSpacing: '0.1em', marginBottom: 16, color: 'var(--color-orange)' }}>NEW PRINTER</h4>
          <div className="form-grid-auto">
            <div>
              <label style={{ display: 'block', fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--color-text-muted)', marginBottom: 6 }}>NAME</label>
              <input value={addForm.name} onChange={e => setAddField('name', e.target.value)} placeholder="e.g. Bambu Lab X1C" style={inputStyle} />
            </div>
            <div>
              <label style={{ display: 'block', fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--color-text-muted)', marginBottom: 6 }}>MODEL</label>
              <input value={addForm.model} onChange={e => setAddField('model', e.target.value)} placeholder="e.g. X1 Carbon" style={inputStyle} />
            </div>
            <div>
              <label style={{ display: 'block', fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--color-text-muted)', marginBottom: 6 }}>PURCHASE COST (MXN)</label>
              <input type="number" step={0.01} min={0} value={addForm.purchaseCost} onChange={e => setAddField('purchaseCost', +e.target.value)} style={inputStyle} />
            </div>
            <div>
              <label style={{ display: 'block', fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--color-text-muted)', marginBottom: 6 }}>AMORTIZATION HOURS</label>
              <input type="number" step={1} min={1} value={addForm.amortizationHours} onChange={e => setAddField('amortizationHours', +e.target.value)} style={inputStyle} />
            </div>
            <div>
              <label style={{ display: 'block', fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--color-text-muted)', marginBottom: 6 }}>MAINTENANCE/HOUR (MXN)</label>
              <input type="number" step={0.01} min={0} value={addForm.maintenanceCostPerHour} onChange={e => setAddField('maintenanceCostPerHour', +e.target.value)} style={inputStyle} />
            </div>
            <div>
              <label style={{ display: 'block', fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--color-text-muted)', marginBottom: 6 }}>WATTS</label>
              <input type="number" step={1} min={0} value={addForm.powerWatts} onChange={e => setAddField('powerWatts', +e.target.value)} style={inputStyle} />
            </div>
          </div>
          <div className="flex flex-wrap justify-between mt-6 items-center gap-4">
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--color-text-muted)' }}>
              MACHINE RATE PREVIEW: <span style={{ color: 'var(--color-orange)', fontWeight: 700 }}>{formatMXN(previewRate)}/h</span>
            </span>
            <div className="flex items-center gap-4">
              {addError && (
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--color-red)' }}>{addError}</span>
              )}
              <button onClick={handleAddPrinter} disabled={addBusy} style={{ fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 700, color: '#000', background: 'var(--color-green)', padding: '8px 24px', borderRadius: 4, cursor: addBusy ? 'wait' : 'pointer', letterSpacing: '0.05em', opacity: addBusy ? 0.6 : 1 }}>
                {addBusy ? 'GUARDANDO...' : 'GUARDAR'}
              </button>
            </div>
          </div>
        </div>
      )}

      <div style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: 6, overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--color-border)' }}>
              {['NAME', 'MODEL', 'PURCHASE COST', 'AMORT. HOURS', 'MAINT./H', 'WATTS', 'MACHINE RATE', 'STATUS', ''].map(h => (
                <th key={h} style={{ textAlign: 'left', padding: '10px 12px', fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--color-text-muted)', letterSpacing: '0.05em' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {printers.map(p => {
              const isEditing = editingId === p.id
              const isSeededK2 = p.name === 'Creality K2 SE'
              const rate = isEditing
                ? machineRate({
                    purchaseCost: editForm.purchaseCost,
                    amortizationHours: editForm.amortizationHours || 1,
                    maintenanceCostPerHour: editForm.maintenanceCostPerHour,
                  })
                : machineRate(p)

              return (
                <tr key={p.id} style={{ borderBottom: '1px dashed var(--color-border-bright)' }}>
                  {isEditing ? (
                    <>
                      <td style={{ padding: '10px 12px' }}>
                        <input value={editForm.name} onChange={e => setEditField('name', e.target.value)} style={inputStyle} />
                      </td>
                      <td style={{ padding: '10px 12px' }}>
                        <input value={editForm.model} onChange={e => setEditField('model', e.target.value)} style={inputStyle} />
                      </td>
                      <td style={{ padding: '10px 12px' }}>
                        <input type="number" step={0.01} min={0} value={editForm.purchaseCost} onChange={e => setEditField('purchaseCost', +e.target.value)} style={inputStyle} />
                      </td>
                      <td style={{ padding: '10px 12px' }}>
                        <input type="number" step={1} min={1} value={editForm.amortizationHours} onChange={e => setEditField('amortizationHours', +e.target.value)} style={inputStyle} />
                      </td>
                      <td style={{ padding: '10px 12px' }}>
                        <input type="number" step={0.01} min={0} value={editForm.maintenanceCostPerHour} onChange={e => setEditField('maintenanceCostPerHour', +e.target.value)} style={inputStyle} />
                      </td>
                      <td style={{ padding: '10px 12px' }}>
                        <input type="number" step={1} min={0} value={editForm.powerWatts} onChange={e => setEditField('powerWatts', +e.target.value)} style={inputStyle} />
                      </td>
                      <td style={{ padding: '10px 12px', fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--color-orange)', fontWeight: 700, whiteSpace: 'nowrap' }}>
                        {formatMXN(rate)}/h
                      </td>
                      <td style={{ padding: '10px 12px', fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--color-text-muted)' }}>{p.status}</td>
                      <td style={{ padding: '10px 12px', whiteSpace: 'nowrap' }}>
                        <div className="flex items-center gap-2">
                          {editError && (
                            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--color-red)' }}>{editError}</span>
                          )}
                          <button onClick={() => handleSaveEdit(p.id)} disabled={editBusy} style={{ fontFamily: 'var(--font-mono)', fontSize: 10, fontWeight: 700, color: '#000', background: 'var(--color-green)', padding: '6px 10px', borderRadius: 4, cursor: editBusy ? 'wait' : 'pointer' }}>
                            {editBusy ? '...' : 'SAVE'}
                          </button>
                          <button onClick={cancelEdit} style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--color-text-muted)', background: 'none', border: '1px solid var(--color-border)', padding: '6px 10px', borderRadius: 4, cursor: 'pointer' }}>
                            CANCEL
                          </button>
                        </div>
                      </td>
                    </>
                  ) : (
                    <>
                      <td style={{ padding: '10px 12px', fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 700, color: 'var(--color-text)' }}>
                        {p.name}
                        {isSeededK2 && (
                          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--color-text-muted)', marginTop: 4, maxWidth: 220, fontWeight: 400 }}>
                            Default values are approximate figures from a public price listing and unit conversion. Adjust to your actual purchase price and usage.
                          </div>
                        )}
                      </td>
                      <td style={{ padding: '10px 12px', fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--color-text-muted)' }}>{p.model ?? '—'}</td>
                      <td style={{ padding: '10px 12px', fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--color-text)' }}>{formatMXN(p.purchaseCost)}</td>
                      <td style={{ padding: '10px 12px', fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--color-text)' }}>{p.amortizationHours}</td>
                      <td style={{ padding: '10px 12px', fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--color-text)' }}>{formatMXN(p.maintenanceCostPerHour)}</td>
                      <td style={{ padding: '10px 12px', fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--color-text)' }}>{p.powerWatts}W</td>
                      <td style={{ padding: '10px 12px', fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--color-orange)', fontWeight: 700, whiteSpace: 'nowrap' }}>
                        {formatMXN(rate)}/h
                      </td>
                      <td style={{ padding: '10px 12px' }}>
                        <span
                          style={{
                            fontFamily: 'var(--font-mono)',
                            fontSize: 10,
                            fontWeight: 700,
                            letterSpacing: '0.05em',
                            padding: '3px 8px',
                            borderRadius: 4,
                            color: p.status === 'active' ? 'var(--color-green)' : 'var(--color-text-dim)',
                            background: p.status === 'active' ? 'rgba(34, 197, 94, 0.12)' : 'rgba(255,255,255,0.06)',
                            textTransform: 'uppercase',
                          }}
                        >
                          {p.status}
                        </span>
                      </td>
                      <td style={{ padding: '10px 12px', whiteSpace: 'nowrap' }}>
                        <div className="flex items-center gap-2">
                          <button onClick={() => startEdit(p)} style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--color-text-muted)', background: 'none', border: '1px solid var(--color-border)', padding: '6px 10px', borderRadius: 4, cursor: 'pointer' }}>
                            EDIT
                          </button>
                          <button
                            onClick={() => handleToggleStatus(p)}
                            disabled={statusBusyId === p.id}
                            style={{
                              fontFamily: 'var(--font-mono)',
                              fontSize: 10,
                              fontWeight: 700,
                              color: p.status === 'active' ? 'var(--color-red)' : 'var(--color-green)',
                              background: 'none',
                              border: `1px solid ${p.status === 'active' ? 'var(--color-red)' : 'var(--color-green)'}`,
                              padding: '6px 10px',
                              borderRadius: 4,
                              cursor: statusBusyId === p.id ? 'wait' : 'pointer',
                              opacity: statusBusyId === p.id ? 0.6 : 1,
                            }}
                          >
                            {p.status === 'active' ? 'DEACTIVATE' : 'REACTIVATE'}
                          </button>
                        </div>
                      </td>
                    </>
                  )}
                </tr>
              )
            })}
          </tbody>
        </table>
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
