import { useMemo, useState } from 'react'
import type { JobHistoryEntry } from '../db/client'
import { computeCosts, formatMXN } from '../pricing'

/**
 * The work log: every job that finished, kept permanently.
 *
 * Distinct from the Queue, which only ever shows work in progress. Two rules
 * make this a record rather than another editable list:
 *   - money comes from the totals frozen when the job finished, not from a live
 *     recomputation, so today's filament price cannot rewrite last month;
 *   - nothing here can be edited, and deleting takes a typed confirmation.
 *
 * The useful action is REPETIR: re-quote a past job from what was actually
 * charged last time.
 */

type Filter = 'all' | 'done' | 'cancelled'

/** What the job billed, preferring the frozen figures over a recomputation. */
function billed(entry: JobHistoryEntry): { preTax: number; iva: number; total: number; frozen: boolean } {
  if (entry.frozen) {
    return {
      preTax: entry.frozen.totalPreTax,
      iva: entry.frozen.totalIva,
      total: entry.frozen.total,
      frozen: true,
    }
  }
  // Only reached by rows saved before totals were frozen on completion. The
  // inputs are still snapshotted on the job, so this is stable too — it just
  // was not stamped.
  const c = computeCosts(entry.job)
  return { preTax: c.jobPreTax, iva: c.iva, total: c.total, frozen: false }
}

const monthFmt = new Intl.DateTimeFormat('es-MX', { month: 'long', year: 'numeric' })
const dayFmt = new Intl.DateTimeFormat('es-MX', { day: '2-digit', month: 'short' })

function entryDate(entry: JobHistoryEntry): Date {
  return new Date(entry.completedAt ?? entry.job.createdAt)
}

export default function History({
  entries,
  onDuplicate,
  onDelete,
}: {
  entries: JobHistoryEntry[]
  onDuplicate: (jobId: string) => void
  onDelete: (jobId: string) => void
}) {
  const [filter, setFilter] = useState<Filter>('done')
  const [search, setSearch] = useState('')

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return entries.filter(e => {
      if (filter !== 'all' && e.job.status !== filter) return false
      if (!q) return true
      return (
        e.job.name.toLowerCase().includes(q) ||
        e.job.client.toLowerCase().includes(q) ||
        String(e.folio).includes(q) ||
        (e.job.jobFilaments ?? []).some(f => `${f.material} ${f.color}`.toLowerCase().includes(q))
      )
    })
  }, [entries, filter, search])

  // Delivered work only. Cancelled jobs never earned anything, so folding them
  // into revenue would overstate what the shop actually made.
  const delivered = filtered.filter(e => e.job.status === 'done')
  const totals = useMemo(() => {
    let revenue = 0
    let cost = 0
    let iva = 0
    let units = 0
    let hours = 0
    let grams = 0
    for (const e of delivered) {
      const b = billed(e)
      revenue += b.preTax // IVA excluded: it is owed to SAT, not income
      iva += b.iva
      cost += computeCosts(e.job).jobSubtotal
      units += e.job.quantity
      hours += (e.job.printTimeHours || 0) * e.job.quantity
      grams +=
        (e.job.jobFilaments ?? []).reduce((s, f) => s + (f.weight || 0), 0) * e.job.quantity
    }
    return { revenue, cost, iva, units, hours, grams, jobs: delivered.length }
  }, [delivered])

  const groups = useMemo(() => {
    const byMonth = new Map<string, JobHistoryEntry[]>()
    for (const e of filtered) {
      const d = entryDate(e)
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
      const list = byMonth.get(key) ?? []
      list.push(e)
      byMonth.set(key, list)
    }
    return [...byMonth.entries()].sort((a, b) => b[0].localeCompare(a[0]))
  }, [filtered])

  const counts = {
    all: entries.length,
    done: entries.filter(e => e.job.status === 'done').length,
    cancelled: entries.filter(e => e.job.status === 'cancelled').length,
  }

  const margin = totals.revenue > 0 ? ((totals.revenue - totals.cost) / totals.revenue) * 100 : 0

  return (
    <div>
      {/* Lifetime-of-selection stats */}
      <div className="stat-grid" style={{ marginBottom: 16 }}>
        <StatCard label="TRABAJOS ENTREGADOS" value={String(totals.jobs)} />
        <StatCard label="FACTURADO S/ IVA" value={formatMXN(totals.revenue)} accent />
        <StatCard label="COSTO REAL" value={formatMXN(totals.cost)} />
        <StatCard label="MARGEN OBTENIDO" value={totals.revenue > 0 ? `${margin.toFixed(1)}%` : '—'} />
      </div>
      <div className="stat-grid" style={{ marginBottom: 32 }}>
        <StatCard label="GANANCIA" value={formatMXN(totals.revenue - totals.cost)} small />
        <StatCard label="PIEZAS PRODUCIDAS" value={String(totals.units)} small />
        <StatCard label="HORAS DE IMPRESIÓN" value={`${totals.hours.toFixed(1)} h`} small />
        <StatCard label="MATERIAL USADO" value={`${(totals.grams / 1000).toFixed(2)} kg`} small />
      </div>

      {/* Filters + search */}
      <div className="filter-bar mb-6">
        <div className="filter-group" style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)' }}>
          {([
            { key: 'done', label: 'ENTREGADOS', count: counts.done },
            { key: 'cancelled', label: 'CANCELADOS', count: counts.cancelled },
            { key: 'all', label: 'TODO', count: counts.all },
          ] as { key: Filter; label: string; count: number }[]).map(f => (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              style={{
                fontFamily: 'var(--font-mono)', fontWeight: 700,
                borderTop: 'none', borderBottom: 'none', borderLeft: 'none',
                borderRight: '1px solid var(--color-border)', cursor: 'pointer', transition: 'all 0.15s',
                background: filter === f.key ? 'var(--color-text)' : 'transparent',
                color: filter === f.key ? '#000' : 'var(--color-text-muted)',
              }}
            >
              {f.label} <span style={{ opacity: filter === f.key ? 1 : 0.5 }}>[{f.count}]</span>
            </button>
          ))}
        </div>
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="BUSCAR POR TRABAJO, CLIENTE, FOLIO O MATERIAL..."
          className="filter-search"
          style={{ background: 'var(--color-background)', border: '1px solid var(--color-border)', padding: '10px 16px', color: 'var(--color-text)', fontFamily: 'var(--font-mono)', fontSize: 12, outline: 'none' }}
        />
      </div>

      {filtered.length === 0 && (
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 13, fontWeight: 700, color: 'var(--color-text-dim)', padding: '60px 0', textAlign: 'center', border: '1px dashed var(--color-border)', lineHeight: 1.8 }}>
          SIN TRABAJOS EN EL HISTORIAL
          <div style={{ fontSize: 11, fontWeight: 400, marginTop: 8 }}>
            Un trabajo llega aquí cuando lo marcas DONE o CANCELLED en la cola.
          </div>
        </div>
      )}

      {groups.map(([key, monthEntries]) => {
        const monthRevenue = monthEntries
          .filter(e => e.job.status === 'done')
          .reduce((s, e) => s + billed(e).preTax, 0)
        return (
          <div key={key} style={{ marginBottom: 32 }}>
            <div
              className="flex items-center justify-between"
              style={{ borderBottom: '2px solid var(--color-border)', paddingBottom: 8, marginBottom: 12 }}
            >
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 700, color: 'var(--color-text)', letterSpacing: '0.12em', textTransform: 'uppercase' }}>
                {monthFmt.format(entryDate(monthEntries[0]))}
              </span>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--color-text-muted)' }}>
                {monthEntries.length} TRABAJO{monthEntries.length === 1 ? '' : 'S'} · {formatMXN(monthRevenue)}
              </span>
            </div>
            {monthEntries.map(entry => (
              <HistoryRow
                key={entry.job.id}
                entry={entry}
                onDuplicate={onDuplicate}
                onDelete={onDelete}
              />
            ))}
          </div>
        )
      })}
    </div>
  )
}

function HistoryRow({
  entry,
  onDuplicate,
  onDelete,
}: {
  entry: JobHistoryEntry
  onDuplicate: (jobId: string) => void
  onDelete: (jobId: string) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const { job } = entry
  const b = billed(entry)
  const costs = computeCosts(job)
  const profit = b.preTax - costs.jobSubtotal
  const cancelled = job.status === 'cancelled'

  const materialsStr = (job.jobFilaments ?? [])
    .map(f => `${f.material}${f.color ? ` (${f.color})` : ''}`)
    .join(' + ')

  const turnaround =
    entry.startedAt && entry.completedAt
      ? (new Date(entry.completedAt).getTime() - new Date(entry.startedAt).getTime()) / 3_600_000
      : null

  return (
    <div
      style={{
        background: 'var(--color-surface)',
        border: '1px solid var(--color-border)',
        borderLeft: `3px solid ${cancelled ? 'var(--color-text-dim)' : 'var(--color-green)'}`,
        marginBottom: 8,
        opacity: cancelled ? 0.6 : 1,
      }}
    >
      <div className="job-head" onClick={() => setExpanded(e => !e)}>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 700, color: 'var(--color-text-dim)', minWidth: 48, flexShrink: 0 }}>
          #{String(entry.folio).padStart(4, '0')}
        </span>

        <div className="job-head-main">
          <div className="flex items-center gap-3" style={{ marginBottom: 3, flexWrap: 'wrap' }}>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 13, fontWeight: 700, color: 'var(--color-text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {job.name || 'SIN NOMBRE'}
            </span>
            {job.quantity > 1 && (
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--color-text-muted)', border: '1px solid var(--color-border)', padding: '1px 5px' }}>
                ×{job.quantity}
              </span>
            )}
            {cancelled && (
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, fontWeight: 700, color: 'var(--color-text-dim)', border: '1px solid var(--color-text-dim)', padding: '2px 5px', letterSpacing: '0.1em' }}>
                CANCELADO
              </span>
            )}
          </div>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--color-text-muted)', letterSpacing: '0.04em', overflowWrap: 'anywhere' }}>
            {job.client || 'SIN CLIENTE'} // {materialsStr || 'SIN MATERIAL'} //{' '}
            {entry.completedAt ? dayFmt.format(new Date(entry.completedAt)).toUpperCase() : 'SIN FECHA'}
          </div>
        </div>

        <div className="job-price">
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 16, fontWeight: 700, color: cancelled ? 'var(--color-text-dim)' : 'var(--color-text)' }}>
            {formatMXN(b.total)}
          </div>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: profit >= 0 ? 'var(--color-green)' : 'var(--color-red)', marginTop: 2 }}>
            {b.frozen ? '' : '~'}
            {profit >= 0 ? '+' : ''}
            {formatMXN(profit)} GANANCIA
          </div>
        </div>
      </div>

      {expanded && (
        <div style={{ borderTop: '1px solid var(--color-border)', padding: 20, background: 'var(--color-background)' }}>
          <div className="detail-grid">
            {/* What was charged */}
            <div>
              <SectionHeader>CIFRAS {b.frozen ? 'CONGELADAS' : 'RECALCULADAS'}</SectionHeader>
              <Row label="COSTO DEL TRABAJO" value={formatMXN(costs.jobSubtotal)} />
              <Row label="PRECIO S/ IVA" value={formatMXN(b.preTax)} />
              <Row label={job.ivaEnabled ? 'IVA COBRADO' : 'IVA (NO APLICADO)'} value={formatMXN(b.iva)} />
              <Row label="TOTAL COBRADO" value={formatMXN(b.total)} bold />
              <Row
                label="MARGEN REAL"
                value={b.preTax > 0 ? `${((profit / b.preTax) * 100).toFixed(1)}%` : '—'}
              />
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--color-text-dim)', marginTop: 10, lineHeight: 1.6 }}>
                {b.frozen
                  ? `Congeladas al cerrar el trabajo (${new Date(entry.frozen!.frozenAt).toLocaleString('es-MX')}). Los cambios de precio posteriores no las afectan.`
                  : 'Este registro es anterior al congelado de totales; las cifras se recalculan desde los insumos guardados del trabajo.'}
              </div>
            </div>

            {/* How it was built */}
            <div>
              <SectionHeader>INSUMOS REGISTRADOS</SectionHeader>
              {(job.jobFilaments ?? []).map(f => (
                <Row
                  key={f.id}
                  label={`${f.material || 'MATERIAL'}${f.color ? ` · ${f.color}` : ''}`}
                  value={`${f.weight}g @ ${formatMXN(f.pricePerKg)}/kg`}
                />
              ))}
              <Row label="IMPRESIÓN" value={`${job.printTimeHours}h × ${job.powerWatts}W`} />
              {(job.laborStages ?? []).map((s, i) => (
                <Row
                  key={i}
                  label={`${s.name || 'MANO DE OBRA'} ${s.scope === 'per_job' ? '(ÚNICA)' : '(C/PIEZA)'}`}
                  value={`${s.hours}h × ${formatMXN(s.rate)}`}
                />
              ))}
              {turnaround !== null && (
                <Row label="TIEMPO EN TALLER" value={`${turnaround.toFixed(1)} h`} />
              )}
              {job.notes && (
                <div style={{ marginTop: 12, padding: 10, background: 'var(--color-surface)', borderLeft: '2px solid var(--color-text-muted)', fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--color-text-muted)' }}>
                  "{job.notes}"
                </div>
              )}
            </div>

            {/* Reference actions */}
            <div>
              <SectionHeader>USAR</SectionHeader>
              <button
                onClick={e => {
                  e.stopPropagation()
                  onDuplicate(job.id)
                }}
                title="Crea un trabajo nuevo en la cola con los mismos materiales, mano de obra y margen"
                style={{
                  width: '100%', fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 700,
                  letterSpacing: '0.07em', padding: '10px', cursor: 'pointer',
                  background: 'var(--color-orange)', color: '#000', border: 'none',
                }}
              >
                REPETIR TRABAJO
              </button>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--color-text-dim)', marginTop: 8, lineHeight: 1.5 }}>
                Copia este trabajo a la cola para volver a cotizarlo con los mismos datos.
              </div>
              <button
                onClick={e => {
                  e.stopPropagation()
                  onDelete(job.id)
                }}
                style={{
                  marginTop: 20, width: '100%', fontFamily: 'var(--font-mono)', fontSize: 10,
                  fontWeight: 700, color: 'var(--color-red)', background: 'none',
                  border: '1px solid var(--color-red)', padding: '8px', cursor: 'pointer',
                  letterSpacing: '0.07em',
                }}
              >
                BORRAR DEL HISTORIAL
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, fontWeight: 700, color: 'var(--color-text)', letterSpacing: '0.1em', marginBottom: 10, borderBottom: '1px solid var(--color-border)', paddingBottom: 6 }}>
      {children}
    </div>
  )
}

function Row({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <div className="flex justify-between items-baseline" style={{ padding: '5px 0' }}>
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: bold ? 'var(--color-text)' : 'var(--color-text-muted)', fontWeight: bold ? 700 : 400, textTransform: 'uppercase' }}>
        {label}
      </span>
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: bold ? 700 : 400, color: 'var(--color-text)', flexShrink: 0, marginLeft: 12 }}>
        {value}
      </span>
    </div>
  )
}

function StatCard({ label, value, accent, small }: { label: string; value: string; accent?: boolean; small?: boolean }) {
  return (
    <div style={{ background: accent ? 'var(--color-orange)' : 'var(--color-surface)', border: '1px solid', borderColor: accent ? 'var(--color-orange)' : 'var(--color-border)', padding: small ? '14px 16px' : '20px' }}>
      <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, fontWeight: 700, color: accent ? '#000' : 'var(--color-text-muted)', letterSpacing: '0.1em', marginBottom: small ? 8 : 12, borderBottom: `1px solid ${accent ? 'rgba(0,0,0,0.2)' : 'var(--color-border)'}`, paddingBottom: small ? 6 : 8 }}>
        {label}
      </div>
      <div style={{ fontFamily: 'var(--font-mono)', fontSize: small ? 'clamp(15px, 3.5vw, 18px)' : 'clamp(17px, 4.2vw, 26px)', fontWeight: 700, color: accent ? '#000' : 'var(--color-text)', letterSpacing: '-0.02em', overflowWrap: 'anywhere' }}>
        {value}
      </div>
    </div>
  )
}
