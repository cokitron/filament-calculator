import * as repo from '../src/db/repository'
import type { SqlExecutor } from '../src/db/types'
import type { PrintJob, Filament } from '../src/types'

/**
 * The data API.
 *
 * Op names deliberately match src/db/worker.ts exactly. The browser build talks
 * to a Worker over postMessage and the server build talks to this over fetch,
 * but both send `{ op, ...args }` and both end up in the same repository
 * functions — so there is one place where a query lives, not two.
 *
 * This is RPC rather than REST on purpose: it is a private interface for one
 * client, and mirroring the existing protocol is what makes the server a thin
 * addition instead of a parallel implementation.
 */

export type RpcRequest = { op: string } & Record<string, unknown>

/** Ops that only read, used to reject writes on a read-only request path. */
const READ_OPS = new Set([
  'listJobs',
  'listActiveJobs',
  'listJobHistory',
  'getQuoteTotals',
  'listFilaments',
  'listCustomers',
  'getSettings',
])

export function isReadOp(op: string): boolean {
  return READ_OPS.has(op)
}

export class UnknownOpError extends Error {}

export function handleRpc(db: SqlExecutor, msg: RpcRequest): unknown {
  switch (msg.op) {
    // --- Jobs ---------------------------------------------------------------
    case 'listJobs':
      return repo.listJobs(db)
    case 'listActiveJobs':
      return repo.listActiveJobs(db)
    case 'listJobHistory':
      return repo.listJobHistory(db)
    case 'saveJob':
      return repo.saveJob(db, msg.job as PrintJob)
    case 'updateJobStatus':
      return repo.updateJobStatus(db, msg.jobId as string, msg.status as PrintJob['status'])
    case 'deleteJob':
      return repo.deleteJob(db, msg.jobId as string, { force: msg.force === true })
    case 'duplicateJob':
      return repo.duplicateJob(db, msg.jobId as string, msg.name as string | undefined)
    case 'issueQuote':
      return repo.issueQuote(db, msg.jobId as string, msg.status as 'sent' | 'accepted' | 'rejected')
    case 'getQuoteTotals':
      return repo.getQuoteTotals(db, msg.jobId as string)

    // --- Filaments and customers -------------------------------------------
    case 'listFilaments':
      return repo.listFilaments(db)
    case 'createFilament':
      return repo.createFilament(db, msg.filament as Omit<Filament, 'id'>)
    case 'deactivateFilament':
      return repo.deactivateFilament(db, msg.filamentId as string)
    case 'listCustomers':
      return repo.listCustomers(db)

    // --- Settings -----------------------------------------------------------
    case 'getSettings':
      return repo.getSettings(db)
    case 'updateSettings':
      return repo.updateSettings(db, msg.patch as Partial<repo.Settings>)

    default:
      // Never echo the op back into the response body; it is attacker-controlled
      // input. The caller logs it server-side instead.
      throw new UnknownOpError(`unknown op`)
  }
}
