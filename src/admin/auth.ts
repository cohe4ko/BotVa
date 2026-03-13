import { html } from 'hono/html'
import { getCookie, setCookie } from 'hono/cookie'
import type { Context, Next } from 'hono'
import type { HtmlEscapedString } from 'hono/utils/html'

const TOKEN = process.env.ADMIN_TOKEN ?? ''

// Dynamic session token for on-demand mode
let sessionToken: string | null = null

export function setSessionToken(token: string | null): void {
  sessionToken = token
}

export function loginPage(error?: string): HtmlEscapedString {
  return html`<!DOCTYPE html>
<html lang="uk" data-theme="light">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Login — BotVa Admin</title>
  <link rel="stylesheet" href="/static/pico.min.css">
</head>
<body>
  <main class="container" style="max-width:400px;margin-top:10vh">
    <h2>BotVa Admin</h2>
    ${error ? html`<p style="color:red">${error}</p>` : ''}
    <form method="POST" action="/login">
      <label>Token
        <input type="password" name="token" placeholder="Enter admin token" autofocus required>
      </label>
      <button type="submit">Login</button>
    </form>
  </main>
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
        maxAge: 60 * 60 * 24 * 30, // 30 days
      })
      return c.redirect('/')
    }
  }

  // 5. On-demand mode — no login form, use Telegram link
  if (sessionToken) {
    return c.text('Unauthorized. Use the link from Telegram.', 401)
  }

  // 6. Standalone mode — login form (requires ADMIN_TOKEN)
  if (!TOKEN) {
    return c.text('ADMIN_TOKEN not configured. Set it in .env', 500)
  }
  return c.html(loginPage())
}

export function setAuthCookie(c: Context, token: string): boolean {
  if (token !== TOKEN) return false
  setCookie(c, 'admin_token', token, {
    path: '/',
    httpOnly: true,
    maxAge: 60 * 60 * 24 * 30, // 30 days
  })
  return true
}
