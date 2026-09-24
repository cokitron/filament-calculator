import { useState } from 'react'
import { PrintJob } from '../types'
import { computeCosts, formatMXN, IVA_RATE } from '../pricing'

const STATUS_CONFIG = {
  queued:    { label: 'QUEUED',    color: 'var(--color-text)',   bg: 'transparent' },
  printing:  { label: 'PRINTING',  color: '#000',                bg: 'var(--color-orange)' },
  done:      { label: 'DONE',      color: '#000',                bg: 'var(--color-green)' },
  cancelled: { label: 'CANCELLED', color: 'var(--color-text-dim)', bg: 'transparent' },
} as const

function StatusBadge({ status }: { status: PrintJob['status'] }) {
  const cfg = STATUS_CONFIG[status]
  return (
    <span style={{ 
      fontFamily: 'var(--font-mono)', 
      fontSize: 10, 
      fontWeight: 700, 
      letterSpacing: '0.1em', 
      color: cfg.color, 
      background: cfg.bg, 
      padding: '4px 8px',
      border: status === 'queued' || status === 'cancelled' ? `1px solid ${cfg.color}` : '1px solid transparent'
    }}>
      {cfg.label}
    </span>
  )
}

function JobRow({ job, onUpdateStatus, onRemove }: { job: PrintJob; onUpdateStatus: (id: string, s: PrintJob['status']) => void; onRemove: (id: string) => void }) {
  const [expanded, setExpanded] = useState(false)
  const costs = computeCosts(job)
  const age = Math.round((Date.now() - new Date(job.createdAt).getTime()) / 60000)
  const ageStr = age < 60 ? `${age}M AGO` : age < 1440 ? `${Math.floor(age / 60)}H AGO` : `${Math.floor(age / 1440)}D AGO`
  
  const materialsStr = (job.jobFilaments || []).map(f => `${f.material} ${f.color ? `(${f.color})` : ''}`).join(' + ')

  return (
    <div style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', marginBottom: 12 }}>
      {/* Main row */}
      <div className="job-head" onClick={() => setExpanded(e => !e)}>
        {/* Job info */}
        <div className="job-head-main">
          <div className="flex items-center gap-3" style={{ marginBottom: 4 }}>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 14, fontWeight: 700, color: 'var(--color-text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {job.name || 'UNNAMED JOB'}
            </span>
            {job.quantity > 1 && (
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--color-orange)', border: '1px solid var(--color-orange)', padding: '2px 6px', fontWeight: 700, whiteSpace: 'nowrap' }}>{job.quantity} UNITS</span>
            )}
          </div>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--color-text-muted)', letterSpacing: '0.05em', overflowWrap: 'anywhere' }}>
            {job.client || 'NO CLIENT'} // {materialsStr} // {ageStr}
          </div>
        </div>

        {/* Status */}
        <div className="job-status">
          <StatusBadge status={job.status} />
        </div>

        {/* Price */}
        <div className="job-price">
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 18, fontWeight: 700, color: 'var(--color-orange)' }}>
            {formatMXN(costs.total)}
          </div>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--color-text-muted)', marginTop: 2 }}>
            {job.quantity > 1 && `${formatMXN(costs.unitPrice)} EA · `}{job.ivaEnabled ? 'C/ IVA' : 'S/ IVA'}
          </div>
        </div>
      </div>

      {/* Expanded detail */}
      {expanded && (
        <div style={{ borderTop: '1px solid var(--color-border)', padding: '24px', background: 'var(--color-background)' }}>
          <div className="detail-grid">
            {/* Cost breakdown */}
            <div>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, fontWeight: 700, color: 'var(--color-text)', letterSpacing: '0.1em', marginBottom: 12, borderBottom: '1px solid var(--color-border)', paddingBottom: 8 }}>COST BREAKDOWN (PER UNIT)</div>
              
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', padding: '6px 0' }}>
                <div>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--color-text-muted)', fontWeight: 400 }}>MATERIAL</span>
                  <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--color-text-dim)', marginTop: 2 }}>
                    {(job.jobFilaments || []).map(f => <div key={f.id}>{f.weight}g @ {formatMXN(f.pricePerKg)}/kg</div>)}
                  </div>
                </div>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 400, color: 'var(--color-text)', flexShrink: 0 }}>
                  {formatMXN(costs.filament)}
                </span>
              </div>

              <DetailRow label="ENERGY" value={costs.electricity} sub={`${job.printTimeHours}h × ${job.powerWatts}W`} />
              <DetailRow label="LABOR / UNIT" value={costs.laborPerUnit} />
              <DetailRow label="OVERHEAD" value={costs.overhead} />
              <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px dashed var(--color-border)' }}>
                <DetailRow label="UNIT SUBTOTAL" value={costs.unitSubtotal} bold />
                <DetailRow label={`MARKUP (${job.marginPercent}%)`} value={costs.unitMargin} />
                <div className="mt-2 pt-2 flex justify-between" style={{ borderTop: '2px solid var(--color-orange)' }}>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 700, color: 'var(--color-orange)' }}>UNIT PRICE</span>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 16, fontWeight: 700, color: 'var(--color-orange)' }}>{formatMXN(costs.unitPrice)}</span>
                </div>
              </div>

              {/* Whole-job rollup */}
              <div style={{ marginTop: 16, paddingTop: 12, borderTop: '1px solid var(--color-border)' }}>
                {job.quantity > 1 && (
                  <DetailRow label={`× ${job.quantity} UNITS`} value={costs.unitPrice * job.quantity} />
                )}
                {costs.laborPerJob > 0 && (
                  <DetailRow
                    label="SETUP (ONCE / JOB)"
                    value={costs.laborPerJob * (1 + (job.marginPercent || 0) / 100)}
                  />
                )}
                <DetailRow
                  label={job.ivaEnabled ? `IVA (${(IVA_RATE * 100).toFixed(0)}%)` : 'IVA (NOT APPLIED)'}
                  value={costs.iva}
                />
                <div className="mt-2 pt-2 flex justify-between" style={{ borderTop: '2px solid var(--color-text)' }}>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 700, color: 'var(--color-text)' }}>
                    JOB TOTAL {job.ivaEnabled ? 'C/ IVA' : 'S/ IVA'}
                  </span>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 16, fontWeight: 700, color: 'var(--color-text)' }}>{formatMXN(costs.total)}</span>
                </div>
              </div>
            </div>

            {/* Details */}
            <div>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, fontWeight: 700, color: 'var(--color-text)', letterSpacing: '0.1em', marginBottom: 12, borderBottom: '1px solid var(--color-border)', paddingBottom: 8 }}>LABOR LOG</div>
              {!(job.laborStages?.length) && <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--color-text-dim)' }}>No labor logged.</div>}
              {(job.laborStages || []).map((s, i) => (
                <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid var(--color-border)' }}>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--color-text-muted)', textTransform: 'uppercase' }}>
                    {s.name || 'UNNAMED'}
                    <span style={{ color: 'var(--color-text-dim)', marginLeft: 6 }}>
                      {s.scope === 'per_job' ? '(ONCE)' : '(EACH)'}
                    </span>
                  </span>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--color-text)' }}>{s.hours}h × {formatMXN(s.rate)} = {formatMXN(s.hours * s.rate)}</span>
                </div>
              ))}
              {job.notes && (
                <div style={{ marginTop: 16, padding: '12px', background: 'var(--color-surface)', borderLeft: '2px solid var(--color-text-muted)', fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--color-text-muted)' }}>
                  "{job.notes}"
                </div>
              )}
            </div>

            {/* Actions */}
            <div>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, fontWeight: 700, color: 'var(--color-text)', letterSpacing: '0.1em', marginBottom: 12, borderBottom: '1px solid var(--color-border)', paddingBottom: 8 }}>MANAGE</div>
              <div className="flex flex-col gap-2">
                {(['queued', 'printing', 'done', 'cancelled'] as const).map(s => (
                  <button
                    key={s}
                    onClick={e => { e.stopPropagation(); onUpdateStatus(job.id, s) }}
                    title={s === 'done' || s === 'cancelled' ? 'Cierra el trabajo y lo archiva en el historial con el total congelado' : undefined}
                    style={{
                      fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 700, letterSpacing: '0.07em',
                      padding: '8px 12px', cursor: 'pointer', transition: 'all 0.15s', textAlign: 'left',
                      background: job.status === s ? 'var(--color-text)' : 'transparent',
                      color: job.status === s ? '#000' : 'var(--color-text-muted)',
                      border: '1px solid var(--color-border)',
                    }}
                  >
                    {job.status === s ? '▶ ' : '  '}{STATUS_CONFIG[s].label}
                    {(s === 'done' || s === 'cancelled') && (
                      <span style={{ opacity: 0.6, fontSize: 9, marginLeft: 6 }}>→ HISTORIAL</span>
                    )}
                  </button>
                ))}
              </div>
              <button
                onClick={e => { e.stopPropagation(); onRemove(job.id) }}
                style={{ marginTop: 24, width: '100%', fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 700, color: 'var(--color-red)', background: 'none', border: '1px solid var(--color-red)', padding: '10px', cursor: 'pointer', letterSpacing: '0.07em' }}
              >
                DELETE RECORD
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function DetailRow({ label, value, sub, bold }: { label: string; value: number; sub?: string; bold?: boolean }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', padding: '6px 0' }}>
      <div>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: bold ? 'var(--color-text)' : 'var(--color-text-muted)', fontWeight: bold ? 700 : 400 }}>{label}</span>
        {sub && <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--color-text-dim)', marginTop: 2 }}>{sub}</div>}
      </div>
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: bold ? 700 : 400, color: 'var(--color-text)', flexShrink: 0 }}>
        {formatMXN(value)}
      </span>
    </div>
  )
}

type FilterStatus = 'all' | 'queued' | 'printing'

/**
 * Work in progress only. Marking a job DONE or CANCELLED moves it out of here
 * and into the work history, where its totals are frozen.
 */
export default function Queue({ jobs, onUpdateStatus, onRemove }: {
  jobs: PrintJob[]
  onUpdateStatus: (id: string, s: PrintJob['status']) => void
  onRemove: (id: string) => void
}) {
  const [filter, setFilter] = useState<FilterStatus>('all')
  const [search, setSearch] = useState('')

  const filtered = jobs.filter(j => {
    if (filter !== 'all' && j.status !== filter) return false
    if (search && !j.name.toLowerCase().includes(search.toLowerCase()) && !j.client.toLowerCase().includes(search.toLowerCase())) return false
    return true
  })

  const totals = {
    // Revenue excludes IVA: tax collected is owed to SAT, it is not income.
    revenue: jobs.reduce((s, j) => s + computeCosts(j).jobPreTax, 0),
    cost: jobs.reduce((s, j) => s + computeCosts(j).jobSubtotal, 0),
    iva: jobs.reduce((s, j) => s + computeCosts(j).iva, 0),
    printing: jobs.filter(j => j.status === 'printing').length,
    queued: jobs.filter(j => j.status === 'queued').length,
  }

  const filters: { key: FilterStatus; label: string; count: number }[] = [
    { key: 'all', label: 'ALL', count: jobs.length },
    { key: 'queued', label: 'QUEUED', count: totals.queued },
    { key: 'printing', label: 'PRINTING', count: totals.printing },
  ]

  return (
    <div>
      {/* Stats bar */}
      <div className="stat-grid" style={{ marginBottom: 32 }}>
        <StatCard label="INGRESO S/ IVA" value={formatMXN(totals.revenue)} accent />
        <StatCard label="COSTO TOTAL" value={formatMXN(totals.cost)} />
        <StatCard label="MARGIN YIELD" value={totals.revenue > 0 ? `${(((totals.revenue - totals.cost) / totals.revenue) * 100).toFixed(1)}%` : '—'} />
        <StatCard label="IVA POR COBRAR" value={formatMXN(totals.iva)} />
      </div>

      {/* Filters + search */}
      <div className="filter-bar mb-6">
        <div className="filter-group" style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)' }}>
          {filters.map(f => (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              style={{
                fontFamily: 'var(--font-mono)', fontWeight: 700,
                borderTop: 'none', borderBottom: 'none', borderLeft: 'none', borderRight: '1px solid var(--color-border)', cursor: 'pointer', transition: 'all 0.15s',
                background: filter === f.key ? 'var(--color-text)' : 'transparent',
                color: filter === f.key ? '#000' : 'var(--color-text-muted)',
              }}
            >
              {f.label} {f.count > 0 && <span style={{ opacity: filter === f.key ? 1 : 0.5 }}>[{f.count}]</span>}
            </button>
          ))}
        </div>
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="SEARCH LOGS..."
          className="filter-search"
          style={{ background: 'var(--color-background)', border: '1px solid var(--color-border)', padding: '10px 16px', color: 'var(--color-text)', fontFamily: 'var(--font-mono)', fontSize: 12, outline: 'none' }}
        />
      </div>

      {/* Job list */}
      {filtered.length === 0 && (
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 14, fontWeight: 700, color: 'var(--color-text-dim)', padding: '60px 0', textAlign: 'center', border: '1px dashed var(--color-border)' }}>
          NO RECORDS FOUND
        </div>
      )}
      {filtered.map(job => (
        <JobRow key={job.id} job={job} onUpdateStatus={onUpdateStatus} onRemove={onRemove} />
      ))}
    </div>
  )
}

function StatCard({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div style={{ background: accent ? 'var(--color-orange)' : 'var(--color-surface)', border: '1px solid', borderColor: accent ? 'var(--color-orange)' : 'var(--color-border)', padding: '20px' }}>
      <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 700, color: accent ? '#000' : 'var(--color-text-muted)', letterSpacing: '0.1em', marginBottom: 12, borderBottom: `1px solid ${accent ? 'rgba(0,0,0,0.2)' : 'var(--color-border)'}`, paddingBottom: 8 }}>{label}</div>
      <div style={{ fontFamily: 'var(--font-mono)', fontSize: 'clamp(18px, 4.5vw, 28px)', fontWeight: 700, color: accent ? '#000' : 'var(--color-text)', letterSpacing: '-0.02em', overflowWrap: 'anywhere' }}>{value}</div>
    </div>
  )
}