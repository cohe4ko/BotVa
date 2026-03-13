import { spawn, ChildProcess } from 'child_process'
import { logger } from './logger.js'

let caffeinateProcess: ChildProcess | null = null

export function preventSleep(): void {
  if (process.platform !== 'darwin') {
    logger.debug('Not on macOS, skipping sleep prevention')
    return
  }

  if (caffeinateProcess) return

  try {
    caffeinateProcess = spawn('caffeinate', ['-di'], {
      stdio: 'ignore',
      detached: true,
    })

    caffeinateProcess.unref()

    caffeinateProcess.on('error', (err) => {
      logger.error({ err }, 'Caffeinate error')
      caffeinateProcess = null
    })

    caffeinateProcess.on('exit', (code) => {
      if (code !== null && code !== 0) {
        logger.warn({ code }, 'Caffeinate exited')
      }
      caffeinateProcess = null
    })

    logger.info('Sleep prevention enabled')
  } catch (error) {
    logger.error({ error }, 'Failed to start caffeinate')
  }
}

export function allowSleep(): void {
  if (caffeinateProcess) {
    try {
      caffeinateProcess.kill()
    } catch {
      // ignore
    }
    caffeinateProcess = null
    logger.info('Sleep prevention disabled')
  }
}
