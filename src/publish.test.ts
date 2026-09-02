import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { fileURLToPath } from 'url'

// Regression: src/publish.ts used `__dirname` without an ESM shim,
// which crashed at module load with:
//   "ReferenceError: __dirname is not defined in ES module scope"
// Importing the module is enough to catch the bug — evaluation itself
// throws if the shim is missing.
describe('publish module loads in ESM', () => {
  it('imports without ReferenceError on __dirname', async () => {
    const mod = await import('./publish.js')
    expect(typeof mod.publishFile).toBe('function')
  })
})

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'publish.sh')

describe('publish.sh', () => {
  let work: string
  let target: string

  // PUBLISH_REMOTE_DIR in the environment makes the script skip .env loading,
  // and an empty PUBLISH_SSH_HOST keeps everything on the local filesystem.
  const run = (arg: string, subfolder = 'test') =>
    execFileSync(SCRIPT, [arg, subfolder], {
      encoding: 'utf-8',
      env: {
        ...process.env,
        PUBLISH_REMOTE_DIR: target,
        PUBLISH_BASE_URL: 'https://example.test/pub',
        PUBLISH_SSH_HOST: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()

  // The URL path after the base, e.g. "test/site-abc123/index.html"
  const relOf = (url: string) => url.replace('https://example.test/pub/', '')

  beforeAll(() => {
    work = mkdtempSync(path.join(tmpdir(), 'publish-test-'))
    target = path.join(work, 'remote')
  })

  afterAll(() => rmSync(work, { recursive: true, force: true }))

  it('publishes a single file with a hashed name', () => {
    const file = path.join(work, 'report.html')
    writeFileSync(file, '<h1>hi</h1>')

    const url = run(file)

    expect(url).toMatch(/^https:\/\/example\.test\/pub\/test\/report-[a-f0-9]{10}\.html$/)
    expect(readFileSync(path.join(target, relOf(url)), 'utf-8')).toBe('<h1>hi</h1>')
  })

  it('transliterates Cyrillic file names', () => {
    const file = path.join(work, 'звіт.html')
    writeFileSync(file, 'x')

    expect(run(file)).toMatch(/\/zvit-[a-f0-9]{10}\.html$/)
  })

  it('publishes a directory as a tree and points at index.html', () => {
    const site = path.join(work, 'site')
    mkdirSync(path.join(site, 'assets'), { recursive: true })
    writeFileSync(path.join(site, 'index.html'), '<img src="assets/pic.png">')
    writeFileSync(path.join(site, 'assets', 'pic.png'), 'PNGDATA')

    const url = run(site)

    expect(url).toMatch(/\/site-[a-f0-9]{10}\/index\.html$/)
    const deployed = path.dirname(path.join(target, relOf(url)))
    expect(readFileSync(path.join(deployed, 'index.html'), 'utf-8')).toContain('assets/pic.png')
    expect(readFileSync(path.join(deployed, 'assets', 'pic.png'), 'utf-8')).toBe('PNGDATA')
  })

  it('unpacks a .tar.gz and flattens its wrapper directory', () => {
    const src = path.join(work, 'packme')
    mkdirSync(path.join(src, 'bundle', 'css'), { recursive: true })
    writeFileSync(path.join(src, 'bundle', 'index.html'), '<link href="css/app.css">')
    writeFileSync(path.join(src, 'bundle', 'css', 'app.css'), 'body{}')
    const archive = path.join(work, 'mysite.tar.gz')
    execFileSync('tar', ['-czf', archive, '-C', src, 'bundle'])

    const url = run(archive)

    expect(url).toMatch(/\/mysite-[a-f0-9]{10}\/index\.html$/)
    const deployed = path.dirname(path.join(target, relOf(url)))
    expect(existsSync(path.join(deployed, 'css', 'app.css'))).toBe(true)
    expect(existsSync(path.join(deployed, 'bundle'))).toBe(false)
  })

  it('falls back to the only html file when index.html is missing', () => {
    const site = path.join(work, 'noindex')
    mkdirSync(site, { recursive: true })
    writeFileSync(path.join(site, 'page.html'), 'x')
    writeFileSync(path.join(site, 'style.css'), 'y')

    expect(run(site)).toMatch(/\/noindex-[a-f0-9]{10}\/page\.html$/)
  })

  it('refuses archives with path traversal', () => {
    const src = path.join(work, 'evil-src')
    mkdirSync(src, { recursive: true })
    writeFileSync(path.join(src, 'index.html'), 'x')
    const archive = path.join(work, 'evil.tar.gz')
    // tar itself refuses to store "../" paths, so write the entry directly
    execFileSync('python3', ['-c', [
      'import tarfile,sys',
      'a,f=sys.argv[1],sys.argv[2]',
      't=tarfile.open(a,"w:gz")',
      't.add(f,arcname="../escaped.html")',
      't.close()',
    ].join('\n'), archive, path.join(src, 'index.html')])

    expect(() => run(archive)).toThrow(/traversing paths|Command failed/)
    expect(existsSync(path.join(work, 'escaped.html'))).toBe(false)
  })

  it('rejects a payload above PUBLISH_MAX_MB', () => {
    const big = path.join(work, 'big')
    mkdirSync(big, { recursive: true })
    writeFileSync(path.join(big, 'index.html'), 'x'.repeat(3 * 1024 * 1024))

    expect(() =>
      execFileSync(SCRIPT, [big, 'test'], {
        encoding: 'utf-8',
        env: {
          ...process.env,
          PUBLISH_REMOTE_DIR: target,
          PUBLISH_BASE_URL: 'https://example.test/pub',
          PUBLISH_SSH_HOST: '',
          PUBLISH_MAX_MB: '1',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    ).toThrow()
  })

  it('errors on a missing path', () => {
    expect(() => run(path.join(work, 'nope.html'))).toThrow()
  })
})
