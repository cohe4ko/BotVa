import type { Context, Next } from 'hono'
import { getBotNames } from './db-multi.js'

/** Middleware that validates :name param is a known bot */
export async function validateBot(c: Context, next: Next): Promise<Response | void> {
  const name = c.req.param('name')
  if (!name || !getBotNames().includes(name)) {
    return c.text(`Bot not found: ${name}`, 404)
  }
  return next()
}

/** Get validated bot name from param (use after validateBot middleware) */
export function botName(c: Context): string {
  return c.req.param('name')!
}
