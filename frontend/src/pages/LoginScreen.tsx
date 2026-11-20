import { useState, type FormEvent } from 'react'
import { api, setToken, setPermissions } from '../services/api'

type LoginScreenProps = {
  onLoggedIn: () => void
}

// Phase 4, ems mode only. Username + password, the same auth endpoint and
// identifier ems-frontend uses (POST /auth/login, { username, password }).
//
// claude_prompt.txt ("v189 -- Unified EMS & Quotation Authentication /
// Shared Login Session"), §2: previously sent `{ email, password }` here
// (see api.ts's own history) -- confirmed live against ems-backend that
// this was always rejected with a 400 ("property email should not
// exist") before the credential check even ran, since
// auth/dto/login.dto.ts only ever declared `username`. Not merely a label
// mismatch: this app's manual login had never actually worked. Field
// renamed end to end (state, input, label, autoComplete, api.ts's
// login() signature) to match EMS's own identifier, not just its text.
//
// claude_prompt.txt ("v187 -- Quotation Login UI Alignment with EMS"):
// visual structure still matches ems-frontend/src/pages/auth/
// LoginPage.tsx (full-viewport centered card, icon, title/subtitle,
// full-width submit button) -- unchanged this round.
function LoginScreen({ onLoggedIn }: LoginScreenProps) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault()
    setError('')
    setSubmitting(true)

    try {
      const result = await api.login(username.trim(), password)
      setToken(result.accessToken)
      setPermissions(result.permissions)
      onLoggedIn()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to log in')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="login-page">
      <div className="login-card">
        <div className="login-card-header">
          <div className="login-card-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M17.5 19H9a5 5 0 0 1-1-9.9A6 6 0 0 1 19 9.5a4.5 4.5 0 0 1-1.5 9.5Z" />
            </svg>
          </div>

          <h1 className="login-card-title">
            Cirrus<span className="login-card-accent"> Quotation</span>
          </h1>

          <p className="login-card-subtitle">Sign in to continue</p>
        </div>

        <form className="login-card-form" onSubmit={(event) => void handleSubmit(event)}>
          <div className="form-group">
            <label htmlFor="login-username">Username</label>
            <input
              id="login-username"
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              autoFocus
              required
            />
          </div>

          <div className="form-group">
            <label htmlFor="login-password">Password</label>
            <input
              id="login-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
            />
          </div>

          {error && <p className="login-error" role="alert">{error}</p>}

          <button
            type="submit"
            className="btn btn-primary login-submit"
            disabled={submitting}
          >
            {submitting ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </div>
    </div>
  )
}

export default LoginScreen
