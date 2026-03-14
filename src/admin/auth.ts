import { html } from 'hono/html'
import { getCookie, setCookie } from 'hono/cookie'
import type { Context, Next } from 'hono'
import type { HtmlEscapedString } from 'hono/utils/html'
import type { TFunc } from './i18n.js'
import { createT, getLang } from './i18n.js'

const TOKEN = process.env.ADMIN_TOKEN ?? ''
if (!TOKEN) console.warn('[admin] WARNING: ADMIN_TOKEN is not set — admin panel has no auth protection')

// Dynamic session token for on-demand mode
let sessionToken: string | null = null

export function setSessionToken(token: string | null): void {
  sessionToken = token
}

export function loginPage(error?: string, t?: TFunc): HtmlEscapedString {
  const _t = t ?? createT('uk')
  return html`<!DOCTYPE html>
<html lang="uk">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Login — ${_t('auth.title')}</title>
  <link rel="stylesheet" href="/static/app.css">
  <style>
    .login-page {
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      background: var(--mc-bg);
      padding: 1rem;
    }
    .login-card {
      width: 100%;
      max-width: 380px;
      background: var(--mc-white);
      border: 1px solid var(--mc-border);
      border-radius: var(--radius);
      box-shadow: var(--shadow-md);
      padding: 2rem;
    }
    .login-header {
      text-align: center;
      margin-bottom: 1.75rem;
    }
    .login-logo {
      width: 48px;
      height: 48px;
      background: var(--mc-accent);
      border-radius: 12px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-size: 22px;
      color: #fff;
      font-weight: 700;
      margin-bottom: 0.75rem;
    }
    .login-header h2 {
      font-size: 1.25rem;
      font-weight: 700;
      color: var(--mc-text);
      margin: 0 0 0.25rem;
    }
    .login-header p {
      color: var(--mc-text-dim);
      font-size: 0.82rem;
      margin: 0;
    }
    .login-form label {
      display: block;
      color: var(--mc-text-secondary);
      font-size: 0.8rem;
      font-weight: 500;
      margin-bottom: 0.35rem;
    }
    .login-form input[type="password"] {
      width: 100%;
      padding: 0.6rem 0.75rem;
      font-size: 0.9rem;
      border: 1px solid var(--mc-border);
      border-radius: var(--radius-sm);
      background: var(--mc-white);
      color: var(--mc-text);
      transition: border-color 0.15s, box-shadow 0.15s;
    }
    .login-form input[type="password"]:focus {
      border-color: var(--mc-accent);
      box-shadow: 0 0 0 3px var(--mc-accent-light);
      outline: none;
    }
    .login-form button[type="submit"] {
      width: 100%;
      margin-top: 1rem;
      padding: 0.6rem;
      font-size: 0.85rem;
      font-weight: 600;
      background: var(--mc-accent);
      color: #fff;
      border: none;
      border-radius: var(--radius-sm);
      cursor: pointer;
      transition: background 0.15s;
    }
    .login-form button[type="submit"]:hover {
      background: var(--mc-accent-hover);
    }
    .login-error {
      background: var(--mc-red-light);
      color: #991b1b;
      border: 1px solid #fecaca;
      padding: 0.5rem 0.75rem;
      border-radius: var(--radius-sm);
      font-size: 0.8rem;
      margin-bottom: 1rem;
      display: flex;
      align-items: center;
      gap: 0.35rem;
    }
    @media (prefers-color-scheme: dark) {
      .login-error { background: rgba(248,113,113,0.1); color: #fca5a5; border-color: rgba(248,113,113,0.2); }
    }
  </style>
  <script>
    (function() {
      var saved = localStorage.getItem('theme');
      if (saved) document.documentElement.setAttribute('data-theme', saved);
    })();
  </script>
</head>
<body>
  <div class="login-page">
    <div class="login-card">
      <div class="login-header">
        <div class="login-logo">B</div>
        <h2>${_t('auth.title')}</h2>
        <p>${_t('auth.subtitle')}</p>
      </div>
      ${error ? html`<div class="login-error">${error}</div>` : ''}
      <form method="POST" action="/login" class="login-form">
        <label for="token">${_t('auth.token')}</label>
        <input type="password" id="token" name="token" placeholder="${_t('auth.placeholder')}" autofocus required>
        <button type="submit">${_t('auth.login')}</button>
      </form>
    </div>
  </div>
</body>
</html>` as HtmlEscapedString
}

export async function authMiddleware(c: Context, next: Next): Promise<Response | void> {
  const path = c.req.path
  if (path === '/login' || path.startsWith('/static/')) {
    return next()
  }

  // 1. On-demand mode: check session cookie
  if (sessionToken) {
    const sessionCookie = getCookie(c, 'admin_session')
    if (sessionCookie === sessionToken) return next()

    // 2. Check ?token= in URL (first visit)
    const urlToken = c.req.query('token')
    if (urlToken === sessionToken) {
      setCookie(c, 'admin_session', sessionToken, {
        path: '/',
        httpOnly: true,
        sameSite: 'Lax',
        maxAge: 60 * 60 * 24, // 24h
      })
      return c.redirect('/')
    }
  }

  // 3. Static token cookie (standalone mode / backward compat)
  const token = getCookie(c, 'admin_token')
  if (TOKEN && token === TOKEN) return next()

  // 4. Standalone mode — accept ?token= in URL and set cookie
  if (TOKEN) {
    const urlToken = c.req.query('token')
    if (urlToken === TOKEN) {
      setCookie(c, 'admin_token', TOKEN, {
        path: '/',
        httpOnly: true,
        sameSite: 'Lax',
        maxAge: 60 * 60 * 24 * 30, // 30 days
      })
      return c.redirect('/')
    }
  }

  const t = createT(getLang(c))

  // 5. On-demand mode — no login form, use Telegram link
  if (sessionToken) {
    return c.text(t('auth.unauthorized'), 401)
  }

  // 6. Standalone mode — login form (requires ADMIN_TOKEN)
  if (!TOKEN) {
    return c.text(t('auth.noToken'), 500)
  }
  return c.html(loginPage(undefined, t))
}

export function setAuthCookie(c: Context, token: string): boolean {
  if (token !== TOKEN) return false
  setCookie(c, 'admin_token', token, {
    path: '/',
    httpOnly: true,
    sameSite: 'Lax',
    maxAge: 60 * 60 * 24 * 30, // 30 days
  })
  return true
}
