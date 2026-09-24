/**
 * Remote transport: SQLite on the server, behind the shared password.
 *
 * Every op name and payload is identical to the local (Worker) transport, so the
 * repository layer and the calling components are unchanged — only the wire
 * between them differs.
 */

/**
 * Thrown when the server says the session is not valid.
 *
 * Distinct from a generic failure so the UI can return to the login screen
 * instead of showing "something went wrong" for an expired cookie.
 */
export class UnauthorizedError extends Error {
  constructor(message = 'La sesión expiró. Vuelve a entrar.') {
    super(message)
    this.name = 'UnauthorizedError'
  }
}

interface RpcResponse {
  ok?: boolean
  result?: unknown
  error?: string
}

async function parseError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as RpcResponse
    return body.error ?? `HTTP ${res.status}`
  } catch {
    return `HTTP ${res.status}`
  }
}

export async function callRemote<T>(payload: Record<string, unknown>): Promise<T> {
  const res = await fetch('/api/rpc', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // The session cookie is HttpOnly, so it has to ride along as a credential
    // rather than be read and attached by hand.
    credentials: 'same-origin',
    body: JSON.stringify(payload),
  })

  if (res.status === 401) throw new UnauthorizedError()
  if (!res.ok) throw new Error(await parseError(res))

  const body = (await res.json()) as RpcResponse
  if (body.ok === false) throw new Error(body.error ?? 'Error del servidor')
  return body.result as T
}

// --- Session ----------------------------------------------------------------

export interface SessionState {
  authenticated: boolean
}

export async function fetchSession(): Promise<SessionState> {
  const res = await fetch('/api/session', { credentials: 'same-origin' })
  if (!res.ok) throw new Error(`No se pudo consultar la sesión (HTTP ${res.status})`)
  return (await res.json()) as SessionState
}

export async function loginRemote(password: string): Promise<void> {
  const res = await fetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ password }),
  })
  if (res.status === 429) {
    const retryAfter = res.headers.get('retry-after')
    throw new Error(
      retryAfter
        ? `Demasiados intentos. Espera ${Math.ceil(Number(retryAfter) / 60)} minuto(s).`
        : 'Demasiados intentos. Espera unos minutos.',
    )
  }
  if (!res.ok) throw new Error(await parseError(res))
}

export async function logoutRemote(): Promise<void> {
  await fetch('/api/logout', { method: 'POST', credentials: 'same-origin' })
}

// --- Backup -----------------------------------------------------------------

/** Download the server's database file through the browser. */
export async function downloadBackupRemote(): Promise<string> {
  const res = await fetch('/api/backup', { credentials: 'same-origin' })
  if (res.status === 401) throw new UnauthorizedError()
  if (!res.ok) throw new Error(await parseError(res))

  const blob = await res.blob()
  // Prefer the server's filename, which carries its own timestamp.
  const disposition = res.headers.get('content-disposition') ?? ''
  const match = /filename="([^"]+)"/.exec(disposition)
  const filename = match?.[1] ?? `printdesk-${new Date().toISOString().slice(0, 10)}.sqlite3`

  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
  return filename
}

/** Replace the server's database with an uploaded file. */
export async function restoreBackupRemote(file: File): Promise<void> {
  const res = await fetch('/api/restore', {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    credentials: 'same-origin',
    body: file,
  })
  if (res.status === 401) throw new UnauthorizedError()
  if (!res.ok) throw new Error(await parseError(res))
}
