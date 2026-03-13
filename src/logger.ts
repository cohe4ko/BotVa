import pino from 'pino'
import { isatty } from 'tty'

const isTTY = isatty(1) // stdout is a terminal

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  transport: process.env.NODE_ENV !== 'production'
    ? { target: 'pino-pretty', options: { colorize: isTTY } }
    : undefined,
})
