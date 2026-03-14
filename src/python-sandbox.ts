import { spawn, type ChildProcess } from 'child_process'
import { mkdirSync, readdirSync } from 'fs'
import { resolve } from 'path'
import { logger } from './logger.js'

const BOOTSTRAP = `
import sys, os, json, io, traceback

output_dir = None
fd_out = os.fdopen(3, 'w')

while True:
    line = sys.stdin.readline()
    if not line:
        break
    try:
        req = json.loads(line)
    except Exception:
        continue

    code = req.get('code', '')
    output_dir = req.get('output_dir', output_dir)

    stdout_buf = io.StringIO()
    stderr_buf = io.StringIO()
    error = None
    files_before = set(os.listdir(output_dir)) if output_dir and os.path.isdir(output_dir) else set()

    old_stdout, old_stderr = sys.stdout, sys.stderr
    sys.stdout, sys.stderr = stdout_buf, stderr_buf
    try:
        exec(compile(code, '<sandbox>', 'exec'), globals())
    except Exception:
        error = traceback.format_exc()
    finally:
        sys.stdout, sys.stderr = old_stdout, old_stderr

    # auto-save matplotlib figures
    try:
        import matplotlib.pyplot as plt
        figs = [plt.figure(n) for n in plt.get_fignums()]
        for i, fig in enumerate(figs):
            path = os.path.join(output_dir, f'figure_{i+1}.png')
            fig.savefig(path, dpi=150, bbox_inches='tight')
        if figs:
            plt.close('all')
    except ImportError:
        pass
    except Exception as e:
        stderr_buf.write(f'matplotlib save error: {e}\\n')

    files_after = set(os.listdir(output_dir)) if output_dir and os.path.isdir(output_dir) else set()
    new_files = sorted(files_after - files_before)

    result = {
        'stdout': stdout_buf.getvalue()[:10000],
        'stderr': stderr_buf.getvalue()[:2000],
        'error': error,
        'files': [os.path.join(output_dir, f) for f in new_files],
    }
    fd_out.write(json.dumps(result) + '\\n<<<SANDBOX_RESULT>>>\\n')
    fd_out.flush()
`

export interface SandboxResult {
  stdout: string
  stderr: string
  error: string | null
  files: string[]
}

export class PythonSandbox {
  private proc: ChildProcess | null = null
  private outputDir: string
  private timeoutMs: number

  constructor(outputDir: string, timeoutMs = 30_000) {
    this.outputDir = resolve(outputDir)
    this.timeoutMs = timeoutMs
    mkdirSync(this.outputDir, { recursive: true })
  }

  private ensureProc(): ChildProcess {
    if (this.proc && this.proc.exitCode === null) return this.proc

    this.proc = spawn('python3', ['-u', '-c', BOOTSTRAP], {
      stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
      env: { ...process.env, MPLBACKEND: 'Agg', PYTHONUNBUFFERED: '1' },
      cwd: this.outputDir,
    })

    this.proc.on('error', (err) => {
      logger.error({ err }, 'Python sandbox process error')
    })

    return this.proc
  }

  async execute(code: string): Promise<SandboxResult> {
    const proc = this.ensureProc()

    return new Promise<SandboxResult>((resolvePromise, reject) => {
      let buffer = ''
      let settled = false

      const cleanup = () => {
        clearTimeout(timer)
        fdOut?.removeListener('data', onData)
        proc.stderr?.removeListener('data', onStderr)
      }

      const settle = (result: SandboxResult) => {
        if (settled) return
        settled = true
        cleanup()
        resolvePromise(result)
      }

      const fail = (error: string) => {
        if (settled) return
        settled = true
        cleanup()
        resolvePromise({ stdout: '', stderr: '', error, files: [] })
      }

      // fd 3 for reading results
      const fdOut = proc.stdio[3] as import('stream').Readable | null
      if (!fdOut) {
        fail('Failed to open fd 3 for Python sandbox')
        return
      }

      let stderrBuf = ''
      const onStderr = (chunk: Buffer) => { stderrBuf += chunk.toString() }
      proc.stderr?.on('data', onStderr)

      const onData = (chunk: Buffer) => {
        buffer += chunk.toString()
        const marker = '<<<SANDBOX_RESULT>>>'
        const idx = buffer.indexOf(marker)
        if (idx !== -1) {
          const jsonStr = buffer.slice(0, idx).trim()
          buffer = buffer.slice(idx + marker.length)
          try {
            const result = JSON.parse(jsonStr) as SandboxResult
            // Append any stderr from process itself
            if (stderrBuf && !result.stderr) result.stderr = stderrBuf.slice(0, 2000)
            settle(result)
          } catch {
            fail(`Failed to parse sandbox result: ${jsonStr.slice(0, 200)}`)
          }
        }
      }

      fdOut.on('data', onData)

      const timer = setTimeout(() => {
        if (settled) return
        logger.warn('Python sandbox timeout, killing process')
        proc.kill('SIGTERM')
        setTimeout(() => {
          if (proc.exitCode === null) proc.kill('SIGKILL')
        }, 1000)
        this.proc = null
        fail(`Timeout: code execution exceeded ${this.timeoutMs / 1000}s limit`)
      }, this.timeoutMs)

      proc.on('exit', () => {
        if (!settled) {
          fail('Python process exited unexpectedly')
          this.proc = null
        }
      })

      // Send code
      const request = JSON.stringify({ code, output_dir: this.outputDir }) + '\n'
      proc.stdin?.write(request)
    })
  }

  kill(): void {
    if (this.proc && this.proc.exitCode === null) {
      this.proc.kill('SIGTERM')
      setTimeout(() => {
        if (this.proc?.exitCode === null) this.proc?.kill('SIGKILL')
      }, 500)
    }
    this.proc = null
  }
}
