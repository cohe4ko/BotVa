import { Hono } from 'hono'
import { html, raw } from 'hono/html'
import type { HtmlEscapedString } from 'hono/utils/html'
import { layout, icon } from '../views/layout.js'
import type { TFunc, Lang, I18nEnv } from '../i18n.js'
import { readFileSync, readdirSync, existsSync } from 'fs'
import { resolve, basename } from 'path'
import { marked } from 'marked'
import { getProjectRoot } from '../db-multi.js'

const app = new Hono<I18nEnv>()

/** Safely read a file, return null if missing */
function readFile(path: string): string | null {
  try { return readFileSync(path, 'utf-8') } catch { return null }
}

/** Render markdown to HTML string */
function renderMd(md: string): string {
  // Strip YAML frontmatter
  const cleaned = md.replace(/^---[\s\S]*?---\n*/m, '')
  return marked.parse(cleaned, { async: false }) as string
}

/** List .md files in a directory (non-recursive), excluding _ prefixed */
function listMdFiles(dir: string): { name: string; filename: string }[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter(f => f.endsWith('.md'))
    .sort()
    .map(f => ({ name: f.replace(/\.md$/, ''), filename: f }))
}

// --- Doc sections config ---
interface DocFile { name: string; path: string; desc?: string }
interface DocSection {
  id: string
  icon: string
  titleKey: string
  descKey: string
  files: DocFile[]
}

function getOverviewFiles(root: string): DocFile[] {
  const files: DocFile[] = []
  if (existsSync(resolve(root, 'README.md'))) {
    files.push({ name: 'README', path: resolve(root, 'README.md') })
  }
  if (existsSync(resolve(root, 'MANUAL.md'))) {
    files.push({ name: 'MANUAL', path: resolve(root, 'MANUAL.md') })
  }
  if (existsSync(resolve(root, 'DEPLOY.md'))) {
    files.push({ name: 'DEPLOY', path: resolve(root, 'DEPLOY.md') })
  }
  if (existsSync(resolve(root, 'CONTRIBUTING.md'))) {
    files.push({ name: 'CONTRIBUTING', path: resolve(root, 'CONTRIBUTING.md') })
  }
  return files
}

function getMcpFiles(root: string): DocFile[] {
  const mcpDir = resolve(root, 'mcp-servers')
  if (!existsSync(mcpDir)) return []
  return readdirSync(mcpDir, { withFileTypes: true })
    .filter(d => d.isDirectory() && !d.name.startsWith('.') && d.name !== 'node_modules')
    .filter(d => existsSync(resolve(mcpDir, d.name, 'README.md')))
    .map(d => ({ name: d.name, path: resolve(mcpDir, d.name, 'README.md') }))
}

function getRoleFiles(root: string): DocFile[] {
  const rolesDir = resolve(root, 'roles')
  return listMdFiles(rolesDir).map(f => ({
    name: f.name,
    path: resolve(rolesDir, f.filename),
  }))
}

function getSkillFiles(root: string): DocFile[] {
  const skillsDir = resolve(root, '.claude/skills')
  if (!existsSync(skillsDir)) return []
  return readdirSync(skillsDir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .filter(d => existsSync(resolve(skillsDir, d.name, 'SKILL.md')))
    .map(d => {
      const content = readFile(resolve(skillsDir, d.name, 'SKILL.md'))
      const descMatch = content ? content.match(/^---[\s\S]*?description:\s*(.+)/m) : null
      const desc = descMatch && descMatch[1] ? descMatch[1].slice(0, 100) : undefined
      return { name: d.name, path: resolve(skillsDir, d.name, 'SKILL.md'), desc }
    })
}

function getDocSections(root: string): DocSection[] {
  return [
    { id: 'overview', icon: 'rocket', titleKey: 'docs.overview', descKey: 'docs.overviewDesc', files: getOverviewFiles(root) },
    { id: 'mcp', icon: 'plug', titleKey: 'docs.mcpServers', descKey: 'docs.mcpDesc', files: getMcpFiles(root) },
    { id: 'roles', icon: 'user-circle', titleKey: 'docs.roles', descKey: 'docs.rolesDesc', files: getRoleFiles(root) },
    { id: 'skills', icon: 'wand-2', titleKey: 'docs.skills', descKey: 'docs.skillsDesc', files: getSkillFiles(root) },
  ]
}

// --- Hub page ---
app.get('/docs', (c) => {
  const t: TFunc = c.get('t')
  const lang: Lang = c.get('lang')
  const root = getProjectRoot()
  const sections = getDocSections(root)

  const content = html`
    <h2>${icon('book-open', 18)} ${t('docs.title')}</h2>

    <div class="bot-grid">
      ${sections.map(sec => {
        const files = sec.files
        if (files.length === 0) return ''
        return html`
          <div class="card">
            <header>
              ${icon(sec.icon, 16)}
              <strong>${t(sec.titleKey)}</strong>
              <span class="badge badge-active" style="margin-left:auto">${files.length}</span>
            </header>
            <p style="font-size:0.82rem;margin-bottom:0.5rem">${t(sec.descKey)}</p>
            <div class="card-links">
              ${files.map(f => html`
                <a href="/docs/${sec.id}/${f.name}">${f.name}</a>
              `)}
            </div>
          </div>
        `
      })}
    </div>
  `

  return c.html(layout(t('docs.title'), content, '/docs', t, lang))
})

// --- Individual doc page ---
app.get('/docs/:section/:name', (c) => {
  const t: TFunc = c.get('t')
  const lang: Lang = c.get('lang')
  const root = getProjectRoot()
  const sectionId = c.req.param('section')
  const name = c.req.param('name')

  // Validate: no path traversal
  if (name.includes('..') || name.includes('/') || sectionId.includes('..')) {
    return c.text('Invalid path', 400)
  }

  const sections = getDocSections(root)
  const section = sections.find(s => s.id === sectionId)
  if (!section) return c.text('Section not found', 404)

  const files = section.files
  const file = files.find((f: DocFile) => f.name === name)
  if (!file) return c.text('File not found', 404)

  const md = readFile(file.path)
  if (!md) return c.text('File not readable', 404)

  const rendered = renderMd(md)

  const content = html`
    <div class="breadcrumb">
      <a href="/docs">${t('docs.title')}</a>
      <span class="sep">/</span>
      <a href="/docs#${sectionId}">${t(section.titleKey)}</a>
      <span class="sep">/</span>
      <span>${name}</span>
    </div>

    <div class="card doc-content">
      ${raw(rendered)}
    </div>
  `

  return c.html(layout(`${name} — ${t('docs.title')}`, content, '/docs', t, lang))
})

export default app
