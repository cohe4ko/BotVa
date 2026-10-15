import { spawn, spawnSync, type ChildProcess } from 'child_process'
import { existsSync, mkdirSync, realpathSync } from 'fs'
import { homedir } from 'os'
import { resolve, join } from 'path'
import { PROJECT_ROOT } from './config.js'
import { logger } from './logger.js'

const BOOTSTRAP = `
import sys, os, json, io, traceback

# Hard ceilings, so a runaway snippet cannot take the machine down with it.
# The process is long-lived, so CPU time adds up across calls: the ceiling is
# generous, and hitting it only costs a respawn.
try:
    import resource
    for lim, val in ((resource.RLIMIT_CPU, 600), (resource.RLIMIT_FSIZE, 200 * 1024 * 1024)):
        try:
            resource.setrlimit(lim, (val, val))
        except Exception:
            pass
except ImportError:
    pass

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

/**
 * The environment RunPython runs with — and nothing else.
 *
 * The bot process carries every API key and bot token in its environment;
 * spreading process.env into the child would hand all of them to whatever
 * code the model writes. Only what Python itself needs goes through, and HOME
 * points into the sandbox so nothing reaches for the owner's dotfiles.
 */
export function sandboxEnv(dir: string): Record<string, string> {
  return {
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    LANG: process.env.LANG ?? 'en_US.UTF-8',
    LC_ALL: process.env.LC_ALL ?? process.env.LANG ?? 'en_US.UTF-8',
    HOME: dir,
    TMPDIR: join(dir, '.tmp'),
    MPLCONFIGDIR: join(dir, '.matplotlib'),
    MPLBACKEND: 'Agg',
    PYTHONUNBUFFERED: '1',
    PYTHONDONTWRITEBYTECODE: '1',
  }
}

/** Quote a path for a Seatbelt (sandbox-exec) profile string literal. */
function sbplString(path: string): string {
  return '"' + path.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'
}

/**
 * macOS Seatbelt profile: no network at all, writes only inside the sandbox
 * directory, and nothing readable under the owner's home or the project
 * (where .env files and databases live) except the sandbox itself and the
 * Python package directories listed in `readable`.
 *
 * Seatbelt applies the last matching rule, so the allows after a deny carve
 * exceptions out of it.
 */
export function macProfile(dir: string, opts: { home: string; projectRoot: string; readable?: string[] }): string {
  const readable = [dir, ...(opts.readable ?? [])].map(p => `(subpath ${sbplString(p)})`).join(' ')
  return [
    '(version 1)',
    '(allow default)',
    '(deny network*)',
    '(deny file-write*)',
    `(allow file-write* (subpath ${sbplString(dir)}) (literal "/dev/null") (regex #"^/dev/fd/"))`,
    `(deny file-read* (subpath ${sbplString(opts.home)}) (subpath ${sbplString(opts.projectRoot)}))`,
    // Existence and size of a path leak nothing secret, and Python's start-up
    // stats parents of its own directories.
    '(allow file-read-metadata)',
    `(allow file-read* ${readable})`,
  ].join('\n')
}

/**
 * Linux bubblewrap arguments: the root filesystem read-only, home directories
 * and the project hidden behind empty tmpfs mounts, the sandbox directory the
 * only writable place, and every namespace unshared — network included.
 */
export function bwrapArgs(dir: string, hidden: string[], readOnly: string[] = []): string[] {
  return [
    '--ro-bind', '/', '/',
    '--dev', '/dev',
    '--proc', '/proc',
    '--tmpfs', '/tmp',
    ...hidden.flatMap(p => ['--tmpfs', p]),
    ...readOnly.flatMap(p => ['--ro-bind', p, p]),
    '--bind', dir, dir,
    '--chdir', dir,
    '--unshare-all',
    '--die-with-parent',
    '--new-session',
  ]
}

/** Drop paths already covered by another one in the list (a tmpfs on a parent hides its children too). */
export function hiddenRoots(paths: string[]): string[] {
  return paths.filter(p => !paths.some(q => q !== p && p.startsWith(q + '/')))
}

export type IsolationKind = 'seatbelt' | 'bwrap' | 'env-only'

export interface Launcher {
  isolation: IsolationKind
  command: string
  args: string[]
}

/** Python directories that must stay readable when the owner's home is hidden. */
function pythonReadablePaths(): string[] {
  const r = spawnSync('python3', ['-c', 'import site,sys; print("\\n".join([site.getusersitepackages(), sys.prefix]))'], { encoding: 'utf8', timeout: 5000 })
  if (r.status !== 0) return []
  return r.stdout.split('\n').map(s => s.trim()).filter(Boolean)
}

function real(p: string): string {
  try { return realpathSync(p) } catch { return p }
}

/** Whether a wrapped python3 actually starts — a sandbox tool can exist and still be unusable. */
function probe(command: string, args: string[], env: Record<string, string>): boolean {
  const r = spawnSync(command, [...args, 'python3', '-c', 'pass'], { env, timeout: 10_000 })
  return r.status === 0
}

/**
 * The strongest isolation this host offers, checked by actually starting
 * Python under it. Falls back to a clean environment alone, loudly.
 */
export function chooseLauncher(dir: string, readOnly: string[] = [], platform: NodeJS.Platform = process.platform): Launcher {
  const env = sandboxEnv(dir)
  const python: Launcher = { isolation: 'env-only', command: 'python3', args: [] }

  if (platform === 'darwin' && existsSync('/usr/bin/sandbox-exec')) {
    // Seatbelt matches resolved paths: /tmp is /private/tmp, and a rule on the
    // symlinked spelling silently matches nothing.
    const profile = macProfile(real(dir), { home: real(homedir()), projectRoot: real(PROJECT_ROOT), readable: [...readOnly, ...pythonReadablePaths()].map(real) })
    const args = ['-p', profile]
    if (probe('/usr/bin/sandbox-exec', args, env)) return { isolation: 'seatbelt', command: '/usr/bin/sandbox-exec', args: [...args, 'python3'] }
  }

  if (platform === 'linux') {
    const args = bwrapArgs(dir, hiddenRoots(['/home', '/root', PROJECT_ROOT].filter(existsSync)), readOnly.filter(existsSync))
    if (probe('bwrap', args, env)) return { isolation: 'bwrap', command: 'bwrap', args: [...args, 'python3'] }
  }

  logger.warn({ platform }, 'RunPython: no working sandbox (sandbox-exec / bwrap) — running with a clean environment only')
  return python
}

const launcherCache = new Map<string, Launcher>()

function launcherFor(dir: string, readOnly: string[]): Launcher {
  const key = [dir, ...readOnly].join('\0')
  let l = launcherCache.get(key)
  if (!l) {
    l = chooseLauncher(dir, readOnly)
    launcherCache.set(key, l)
    logger.info({ isolation: l.isolation }, 'RunPython isolation')
  }
  return l
}

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
  private readOnlyDirs: string[]

  /**
   * @param readOnlyDirs directories the code may read but not change — the
   *   chat's uploads, so a file the user sent can be analysed.
   */
  constructor(outputDir: string, timeoutMs = 30_000, readOnlyDirs: string[] = []) {
    this.outputDir = resolve(outputDir)
    this.timeoutMs = timeoutMs
    this.readOnlyDirs = readOnlyDirs.map(d => resolve(d))
    mkdirSync(this.outputDir, { recursive: true })
    for (const sub of ['.tmp', '.matplotlib']) mkdirSync(join(this.outputDir, sub), { recursive: true })
  }

  private ensureProc(): ChildProcess {
    if (this.proc && this.proc.exitCode === null) return this.proc

    const launcher = launcherFor(this.outputDir, this.readOnlyDirs)
    this.proc = spawn(launcher.command, [...launcher.args, '-u', '-c', BOOTSTRAP], {
      stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
      env: sandboxEnv(this.outputDir),
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
