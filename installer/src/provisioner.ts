import { Client, type ClientChannel } from 'ssh2'
import { getSteps, type ProvisionParams, type Step } from './steps.js'

export type OutputCallback = (data: string) => void
export type StepCallback = (index: number, total: number, name: string, status: 'start' | 'done' | 'error' | 'interactive') => void

interface ProvisionCallbacks {
  onOutput: OutputCallback
  onStep: StepCallback
  onInteractive: (step: Step, channel: ClientChannel) => Promise<void>
  onDone: (success: boolean, message: string) => void
}

function execCommand(conn: Client, command: string, onOutput: OutputCallback): Promise<number> {
  return new Promise((resolve, reject) => {
    conn.exec(command, { pty: true }, (err, stream) => {
      if (err) return reject(err)

      stream.on('data', (data: Buffer) => {
        onOutput(data.toString())
      })

      stream.stderr.on('data', (data: Buffer) => {
        onOutput(data.toString())
      })

      stream.on('close', (code: number) => {
        resolve(code ?? 0)
      })
    })
  })
}

function execInteractive(conn: Client, command: string): Promise<ClientChannel> {
  return new Promise((resolve, reject) => {
    conn.exec(command, { pty: { cols: 120, rows: 30, term: 'xterm-256color' } }, (err, stream) => {
      if (err) return reject(err)
      resolve(stream)
    })
  })
}

export async function provision(params: ProvisionParams, callbacks: ProvisionCallbacks): Promise<void> {
  const { onOutput, onStep, onInteractive, onDone } = callbacks
  const steps = getSteps(params)
  const total = steps.length
  const conn = new Client()

  try {
    await new Promise<void>((resolve, reject) => {
      conn.on('ready', resolve)
      conn.on('error', reject)
      conn.connect({
        host: params.ip,
        port: 22,
        username: 'root',
        password: params.password,
        readyTimeout: 15000,
        keepaliveInterval: 10000,
      })
    })

    onOutput('\x1b[32m✓ SSH підключення встановлено\x1b[0m\r\n\r\n')

    let adminToken = ''

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i]
      const stepNum = i + 1

      onOutput(`\x1b[1;36m[${stepNum}/${total}] ${step.name}\x1b[0m\r\n`)
      onStep(stepNum, total, step.name, step.interactive ? 'interactive' : 'start')

      if (step.interactive) {
        // Interactive step: open PTY channel and let user interact
        const channel = await execInteractive(conn, step.command)
        await onInteractive(step, channel)
        onStep(stepNum, total, step.name, 'done')
        onOutput(`\x1b[32m✓ ${step.name}\x1b[0m\r\n\r\n`)
      } else {
        const exitCode = await execCommand(conn, step.command, (data) => {
          // Capture admin token from output
          const tokenMatch = data.match(/Admin token: ([a-f0-9]+)/)
          if (tokenMatch) adminToken = tokenMatch[1]
          onOutput(data)
        })
        if (exitCode !== 0) {
          onOutput(`\r\n\x1b[31m✗ ${step.name} (exit code: ${exitCode})\x1b[0m\r\n`)
          onStep(stepNum, total, step.name, 'error')
          onDone(false, `Крок "${step.name}" завершився з помилкою (код ${exitCode})`)
          conn.end()
          return
        }
        onOutput(`\x1b[32m✓ ${step.name}\x1b[0m\r\n\r\n`)
        onStep(stepNum, total, step.name, 'done')
      }
    }

    conn.end()
    const baseUrl = params.domain
      ? `https://${params.domain}`
      : `http://${params.ip}:${params.adminPort}`
    const adminUrl = adminToken ? `${baseUrl}/?token=${adminToken}` : baseUrl
    onDone(true, adminUrl)
  } catch (err: any) {
    const message = err.level === 'client-authentication'
      ? 'Невірний пароль або користувач root'
      : err.level === 'client-timeout'
        ? 'Не вдалось підключитись — перевірте IP адресу'
        : err.message || 'Невідома помилка'

    onOutput(`\r\n\x1b[31m✗ Помилка: ${message}\x1b[0m\r\n`)
    onDone(false, message)

    try { conn.end() } catch {}
  }
}
