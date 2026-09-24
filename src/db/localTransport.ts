/**
 * Local transport: SQLite in this browser, via a Worker, stored in OPFS.
 *
 * The data never leaves the device. This is the mode the static build uses
 * (including the Figma Make preview, which has no server behind it), and it is
 * the only mode that works offline.
 */

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void }

let worker: Worker | null = null
let nextId = 1
const pending = new Map<number, Pending>()

function ensureWorker(): Worker {
  if (worker) return worker

  worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })

  worker.onmessage = (
    event: MessageEvent<{ id: number; ok: boolean; result?: unknown; error?: string }>,
  ) => {
    const { id, ok, result, error } = event.data
    const entry = pending.get(id)
    if (!entry) return
    pending.delete(id)
    if (ok) entry.resolve(result)
    else entry.reject(new Error(error ?? 'unknown database error'))
  }

  worker.onerror = event => {
    // A worker-level failure (module load, WASM fetch) never resolves individual
    // requests, so fail everything in flight rather than hanging the UI forever.
    const err = new Error(`Database worker failed: ${event.message}`)
    for (const [, entry] of pending) entry.reject(err)
    pending.clear()
  }

  return worker
}

export function callLocal<T>(payload: Record<string, unknown>): Promise<T> {
  const w = ensureWorker()
  const id = nextId++
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
    w.postMessage({ id, ...payload })
  })
}
