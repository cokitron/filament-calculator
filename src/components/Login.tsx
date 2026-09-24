import { useState } from 'react'

/**
 * Password gate for server-backed storage.
 *
 * One shared password, no accounts: everyone who knows it sees the same data.
 * The screen says so plainly, because a login box normally implies a personal
 * account and that assumption would be wrong here.
 */
export default function Login({ onSubmit }: { onSubmit: (password: string) => Promise<void> }) {
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!password || busy) return
    setBusy(true)
    setError(null)
    try {
      await onSubmit(password)
      // On success the parent swaps this screen out; clear the field first so the
      // password is not left sitting in component state.
      setPassword('')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="min-h-screen flex items-center justify-center p-4"
      style={{ background: 'var(--color-background)' }}
    >
      <form
        onSubmit={handleSubmit}
        style={{
          width: '100%',
          maxWidth: 380,
          background: 'var(--color-surface)',
          border: '1px solid var(--color-border)',
          padding: 28,
        }}
      >
        <div className="flex items-center gap-3" style={{ marginBottom: 24 }}>
          <div
            style={{
              width: 40,
              height: 40,
              flexShrink: 0,
              background: 'var(--color-orange)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#000" strokeWidth="3" strokeLinecap="square">
              <path d="M12 2L2 7l10 5 10-5-10-5z" />
              <path d="M2 17l10 5 10-5" />
              <path d="M2 12l10 5 10-5" />
            </svg>
          </div>
          <div>
            <div
              style={{
                fontFamily: 'var(--font-mono)',
                fontWeight: 800,
                fontSize: 20,
                color: 'var(--color-text)',
                letterSpacing: '-0.05em',
                lineHeight: 1,
              }}
            >
              PRINTDESK
            </div>
            <div
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 9,
                color: 'var(--color-text-muted)',
                letterSpacing: '0.15em',
                marginTop: 4,
                fontWeight: 700,
              }}
            >
              ACCESO AL TALLER
            </div>
          </div>
        </div>

        <label
          htmlFor="pd-password"
          style={{
            display: 'block',
            fontFamily: 'var(--font-mono)',
            fontSize: 10,
            color: 'var(--color-text-muted)',
            letterSpacing: '0.08em',
            marginBottom: 6,
          }}
        >
          CONTRASEÑA
        </label>
        <input
          id="pd-password"
          type="password"
          value={password}
          onChange={e => setPassword(e.target.value)}
          autoFocus
          autoComplete="current-password"
          disabled={busy}
          style={{
            width: '100%',
            background: 'var(--color-background)',
            border: `1px solid ${error ? 'var(--color-red)' : 'var(--color-border)'}`,
            padding: '12px 14px',
            color: 'var(--color-text)',
            fontFamily: 'var(--font-mono)',
            fontSize: 16,
            outline: 'none',
          }}
        />

        {error && (
          <div
            role="alert"
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 11,
              color: 'var(--color-red)',
              marginTop: 10,
              lineHeight: 1.5,
            }}
          >
            {error}
          </div>
        )}

        <button
          type="submit"
          disabled={busy || !password}
          style={{
            width: '100%',
            marginTop: 20,
            background: busy || !password ? 'var(--color-surface-2)' : 'var(--color-orange)',
            color: busy || !password ? 'var(--color-text-muted)' : '#000',
            fontFamily: 'var(--font-mono)',
            fontSize: 13,
            fontWeight: 700,
            letterSpacing: '0.1em',
            padding: '14px',
            border: 'none',
            cursor: busy || !password ? 'default' : 'pointer',
          }}
        >
          {busy ? 'VERIFICANDO...' : 'ENTRAR'}
        </button>

        <p
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 9,
            color: 'var(--color-text-dim)',
            marginTop: 18,
            lineHeight: 1.6,
          }}
        >
          Contraseña compartida: todos los que la conocen ven y editan los mismos
          datos. No hay cuentas individuales. Los intentos fallidos se limitan.
        </p>
      </form>
    </div>
  )
}
