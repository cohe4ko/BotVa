import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'fs'
import { resolve } from 'path'
import { getProjectRoot } from './admin/db-multi.js'

// --- Constants ---

const WORKSPACE_DIR = 'workspace-files'

/** Order in which workspace files are assembled into CLAUDE.md. */
const ASSEMBLY_ORDER = [
  'IDENTITY.md',
  'SOUL.md',       // global (virtual, from roles/_soul.md)
  'BOT_SOUL.md',   // per-bot soul overlay
  'ROLE.md',
  'TOOLS.md',      // global (virtual, from roles/_tools.md)
  'BOT_TOOLS.md',  // per-bot tools overlay
  'USER.md',
  'MEMORY.md',
] as const

const ALL_FILE_NAMES = [...ASSEMBLY_ORDER] as const

export type WorkspaceFileName = typeof ALL_FILE_NAMES[number]

/** Global files: virtual, sourced from roles/, shared across all bots, not on per-bot disk. */
const GLOBAL_FILES = new Set<WorkspaceFileName>(['SOUL.md', 'TOOLS.md'])

/** Map global workspace file → source filename inside roles/ */
const GLOBAL_SOURCE: Record<string, string> = {
  'SOUL.md': '_soul.md',
  'TOOLS.md': '_tools.md',
}

/** Map global file → its per-bot overlay file. Overlay can replace global via marker. */
const OVERLAY_OF_GLOBAL: Record<string, WorkspaceFileName> = {
  'SOUL.md': 'BOT_SOUL.md',
  'TOOLS.md': 'BOT_TOOLS.md',
}

/**
 * Marker that, when present at the start of a per-bot overlay file (BOT_SOUL.md or
 * BOT_TOOLS.md), causes the corresponding global file (SOUL.md or TOOLS.md) to be
 * SKIPPED during CLAUDE.md assembly. The marker line itself is stripped from output.
 */
export const REPLACES_GLOBAL_MARKER = '<!-- REPLACES_GLOBAL -->'

/** Returns true if the given overlay content starts with the replace marker. */
function overlayReplacesGlobal(content: string | null): boolean {
  if (!content) return false
  return content.trimStart().startsWith(REPLACES_GLOBAL_MARKER)
}

/** Strip the REPLACES_GLOBAL marker line (if present) from overlay content. */
function stripReplaceMarker(content: string): string {
  const trimmed = content.trimStart()
  if (!trimmed.startsWith(REPLACES_GLOBAL_MARKER)) return content
  const afterMarker = trimmed.slice(REPLACES_GLOBAL_MARKER.length)
  // Drop one leading newline if present
  return afterMarker.replace(/^\r?\n/, '')
}

// --- Conditional sections (feature flags) ---

/** Known feature flags read from bot's .env file */
export const FEATURE_FLAGS = ['GROUP_CHAT_ENABLED', 'DEV_MODE_ENABLED', 'GIT_ACCESS_ENABLED'] as const
export type FeatureFlag = typeof FEATURE_FLAGS[number]

/**
 * Read enabled feature flags from bot's .env file.
 * Returns set of flags whose value is "1", "true", or "yes" (case-insensitive).
 */
export function readBotFeatures(botDir: string): Set<string> {
  const enabled = new Set<string>()
  const envPath = resolve(botDir, '.env')
  if (!existsSync(envPath)) return enabled
  const content = readFileSync(envPath, 'utf-8')
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq === -1) continue
    const key = line.slice(0, eq).trim()
    let value = line.slice(eq + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    if (!FEATURE_FLAGS.includes(key as FeatureFlag)) continue
    const lowered = value.toLowerCase()
    if (lowered === '1' || lowered === 'true' || lowered === 'yes' || lowered === 'on') {
      enabled.add(key)
    }
  }
  return enabled
}

/**
 * Process `<!-- IF FEATURE -->...<!-- END -->` blocks in content.
 * Removes blocks whose feature is not in `enabled`. Removes IF/END markers from output.
 * Supports nested IF blocks (innermost out).
 */
export function processConditionalBlocks(content: string, enabled: Set<string>): string {
  const ifPattern = /<!--\s*IF\s+([A-Z_][A-Z0-9_]*)\s*-->/
  let result = content
  // Process from innermost out by repeatedly finding the first IF that has its
  // matching END before any nested IF.
  let safety = 0
  while (true) {
    if (++safety > 100) break // safety net against malformed input
    const ifMatch = result.match(ifPattern)
    if (!ifMatch) break
    const ifIdx = ifMatch.index!
    const feature = ifMatch[1]
    const afterIf = ifIdx + ifMatch[0].length
    // Find matching END, accounting for nesting
    let depth = 1
    let cursor = afterIf
    let endIdx = -1
    let endLen = 0
    const tokenRe = /<!--\s*(IF\s+[A-Z_][A-Z0-9_]*|END)\s*-->/g
    tokenRe.lastIndex = cursor
    let m: RegExpExecArray | null
    while ((m = tokenRe.exec(result)) !== null) {
      if (m[1].startsWith('IF')) depth++
      else {
        depth--
        if (depth === 0) {
          endIdx = m.index
          endLen = m[0].length
          break
        }
      }
    }
    if (endIdx === -1) {
      // Unmatched IF — strip just the marker, leave content
      result = result.slice(0, ifIdx) + result.slice(afterIf)
      continue
    }
    const innerStart = afterIf
    const innerEnd = endIdx
    const inner = result.slice(innerStart, innerEnd)
    if (enabled.has(feature)) {
      // Keep inner, drop markers + collapse adjacent newlines
      result = result.slice(0, ifIdx).replace(/\n*$/, '\n') +
               inner.replace(/^\n+/, '').replace(/\n+$/, '') +
               result.slice(endIdx + endLen).replace(/^\n*/, '\n')
    } else {
      // Drop entire block
      result = result.slice(0, ifIdx).replace(/\n*$/, '') +
               result.slice(endIdx + endLen).replace(/^\n*/, '\n')
    }
  }
  return result
}

/** Files the bot agent can write via WriteWorkspaceFile tool */
const BOT_WRITABLE_FILES = new Set<WorkspaceFileName>(['USER.md', 'MEMORY.md'])

const ALL_FILES = new Set<WorkspaceFileName>(ALL_FILE_NAMES)

// --- Roles dir resolution (lazy, avoids circular import with bot-manager) ---

let _rolesDirOverride: string | null = null

/** Test hook: override roles dir. */
export function setRolesDirForTesting(dir: string | null): void {
  _rolesDirOverride = dir
}

function getRolesDirInternal(): string {
  if (_rolesDirOverride) return _rolesDirOverride
  return resolve(getProjectRoot(), 'roles')
}

function readGlobalFile(name: WorkspaceFileName): string | null {
  const sourceName = GLOBAL_SOURCE[name]
  if (!sourceName) return null
  const filePath = resolve(getRolesDirInternal(), sourceName)
  if (!existsSync(filePath)) return null
  return readFileSync(filePath, 'utf-8')
}

// --- Core Functions ---

export function getWorkspaceDir(botDir: string): string {
  return resolve(botDir, WORKSPACE_DIR)
}

export function hasWorkspaceFiles(botDir: string): boolean {
  const wsDir = getWorkspaceDir(botDir)
  if (!existsSync(wsDir)) return false
  // Must have at least IDENTITY.md (per-bot anchor) — globals come from roles/.
  return existsSync(resolve(wsDir, 'IDENTITY.md'))
}

export function readWorkspaceFile(botDir: string, filename: WorkspaceFileName): string | null {
  if (!ALL_FILES.has(filename)) return null
  if (GLOBAL_FILES.has(filename)) {
    return readGlobalFile(filename)
  }
  const filePath = resolve(getWorkspaceDir(botDir), filename)
  if (!existsSync(filePath)) return null
  return readFileSync(filePath, 'utf-8')
}

export function writeWorkspaceFile(botDir: string, filename: WorkspaceFileName, content: string): void {
  if (GLOBAL_FILES.has(filename)) {
    throw new Error(`File "${filename}" is global — edit roles/${GLOBAL_SOURCE[filename]} via git instead.`)
  }
  if (!BOT_WRITABLE_FILES.has(filename)) {
    throw new Error(`File "${filename}" is read-only for the bot. Only ${[...BOT_WRITABLE_FILES].join(', ')} can be written.`)
  }
  const wsDir = getWorkspaceDir(botDir)
  if (!existsSync(wsDir)) {
    mkdirSync(wsDir, { recursive: true })
  }
  writeFileSync(resolve(wsDir, filename), content, 'utf-8')
}

export function isWritableFile(filename: string): filename is WorkspaceFileName {
  return BOT_WRITABLE_FILES.has(filename as WorkspaceFileName)
}

export function isGlobalFile(filename: string): filename is WorkspaceFileName {
  return GLOBAL_FILES.has(filename as WorkspaceFileName)
}

export function isValidWorkspaceFile(filename: string): filename is WorkspaceFileName {
  return ALL_FILES.has(filename as WorkspaceFileName)
}

export interface WorkspaceFileInfo {
  name: WorkspaceFileName
  writable: boolean
  global: boolean
  exists: boolean
  size: number
}

export function listWorkspaceFiles(botDir: string): WorkspaceFileInfo[] {
  const wsDir = getWorkspaceDir(botDir)
  return ALL_FILE_NAMES.map(name => {
    const isGlobal = GLOBAL_FILES.has(name)
    let exists = false
    let size = 0
    if (isGlobal) {
      const sourcePath = resolve(getRolesDirInternal(), GLOBAL_SOURCE[name])
      exists = existsSync(sourcePath)
      size = exists ? statSync(sourcePath).size : 0
    } else {
      const filePath = resolve(wsDir, name)
      exists = existsSync(filePath)
      size = exists ? statSync(filePath).size : 0
    }
    return {
      name,
      writable: BOT_WRITABLE_FILES.has(name),
      global: isGlobal,
      exists,
      size,
    }
  })
}

// --- Assembly ---

/** Assemble all workspace files into a single CLAUDE.md content string. */
export function assembleFromWorkspaceFiles(botDir: string): string {
  const features = readBotFeatures(botDir)
  return assemble(filename => readWorkspaceFile(botDir, filename), features)
}

/** Shared assembly logic — accepts a reader fn so it works for both disk and in-memory maps. */
function assemble(read: (name: WorkspaceFileName) => string | null, features: Set<string>): string {
  // Pre-check overlays for REPLACES_GLOBAL markers
  const replacedGlobals = new Set<WorkspaceFileName>()
  for (const [globalName, overlayName] of Object.entries(OVERLAY_OF_GLOBAL)) {
    if (overlayReplacesGlobal(read(overlayName))) {
      replacedGlobals.add(globalName as WorkspaceFileName)
    }
  }

  const parts: string[] = []
  for (const filename of ASSEMBLY_ORDER) {
    if (replacedGlobals.has(filename)) continue // global skipped — overlay replaces it
    let content = read(filename)
    if (!content) continue
    // Strip marker from overlay output
    if (filename === 'BOT_SOUL.md' || filename === 'BOT_TOOLS.md') {
      content = stripReplaceMarker(content)
    }
    // Process conditional <!-- IF FEATURE -->...<!-- END --> blocks
    content = processConditionalBlocks(content, features)
    const trimmed = content.trim()
    if (!trimmed) continue
    parts.push(trimmed)
  }
  return parts.join('\n\n')
}

/**
 * Assemble CLAUDE.md from an in-memory workspace files map, injecting globals from roles/.
 * Used during bot creation before files are persisted to disk.
 */
export function assembleFromMap(files: Record<WorkspaceFileName, string>, features: Set<string> = new Set()): string {
  return assemble(filename => {
    if (GLOBAL_FILES.has(filename)) return readGlobalFile(filename)
    return files[filename] ?? null
  }, features)
}

/** Reassemble CLAUDE.md from workspace files if they exist. Called before each agent query. */
export function refreshClaudeMd(botDir: string): void {
  if (!hasWorkspaceFiles(botDir)) return
  const content = assembleFromWorkspaceFiles(botDir)
  writeFileSync(resolve(botDir, 'CLAUDE.md'), content, 'utf-8')
}

// --- Building workspace files from role templates ---

/**
 * Build per-bot workspace files from a role template.
 * Returns ONLY on-disk files (6): IDENTITY, BOT_SOUL, ROLE, BOT_TOOLS, USER, MEMORY.
 * Global files (SOUL, TOOLS) are NOT returned — they live in roles/ and are read at runtime.
 */
export function buildWorkspaceFilesFromRole(
  role: string, botName: string, emoji: string, rolesDir: string
): Record<WorkspaceFileName, string> {
  let template = readFileSync(resolve(rolesDir, `${role}.md`), 'utf-8')
  template = template.replaceAll('{{BOT_NAME}}', botName)
  template = template.replaceAll('{{BOT_EMOJI}}', emoji)

  const sections = parseRoleMarkers(template)

  return {
    'IDENTITY.md': sections.IDENTITY.trim(),
    'SOUL.md': '',          // virtual — placeholder, never persisted
    'BOT_SOUL.md': BOT_SOUL_TEMPLATE,
    'ROLE.md': sections.ROLE.trim(),
    'TOOLS.md': '',         // virtual — placeholder, never persisted
    'BOT_TOOLS.md': sections.TOOLS.trim(),
    'USER.md': USER_MD_TEMPLATE,
    'MEMORY.md': MEMORY_MD_TEMPLATE,
  }
}

/** Parse role template by --- SECTION --- markers */
export function parseRoleMarkers(md: string): Record<string, string> {
  const result: Record<string, string> = { IDENTITY: '', ROLE: '', TOOLS: '' }
  let currentSection = ''
  const lines: string[] = []

  for (const line of md.split('\n')) {
    const match = line.match(/^---\s*(IDENTITY|ROLE|TOOLS)\s*---$/)
    if (match) {
      if (currentSection) result[currentSection] = lines.join('\n')
      currentSection = match[1]
      lines.length = 0
    } else {
      lines.push(line)
    }
  }
  if (currentSection) result[currentSection] = lines.join('\n')
  return result
}

// --- Legacy: splitting monolithic CLAUDE.md into workspace files ---

/**
 * @deprecated Use buildWorkspaceFilesFromRole() for new bots.
 * Kept for migrating legacy bots that have monolithic CLAUDE.md.
 */
export function splitRoleIntoWorkspaceFiles(claudeMd: string): Record<WorkspaceFileName, string> {
  const sections = parseMarkdownSections(claudeMd)

  const identityContent = sections.preamble.trim()
  const toolsContent = sections.sections.get('Коли який інструмент') ?? ''

  const roleParts: string[] = []
  for (const [name, content] of sections.sections) {
    if (name === 'Soul' || name === 'Коли який інструмент') continue
    roleParts.push(`## ${name}\n\n${content.trim()}`)
  }
  const roleContent = roleParts.join('\n\n')

  return {
    'IDENTITY.md': identityContent,
    'SOUL.md': '',
    'BOT_SOUL.md': BOT_SOUL_TEMPLATE,
    'ROLE.md': roleContent,
    'TOOLS.md': '',
    'BOT_TOOLS.md': toolsContent ? `## Коли який інструмент\n\n${toolsContent.trim()}` : '',
    'USER.md': USER_MD_TEMPLATE,
    'MEMORY.md': MEMORY_MD_TEMPLATE,
  }
}

/** Split default (non-role) CLAUDE.md into minimal workspace files */
export function splitDefaultIntoWorkspaceFiles(claudeMd: string, botName: string, emoji: string): Record<WorkspaceFileName, string> {
  return {
    'IDENTITY.md': `# ${botName} ${emoji}`,
    'SOUL.md': '',
    'BOT_SOUL.md': claudeMd,
    'ROLE.md': '',
    'TOOLS.md': '',
    'BOT_TOOLS.md': '',
    'USER.md': USER_MD_TEMPLATE,
    'MEMORY.md': MEMORY_MD_TEMPLATE,
  }
}

// --- Markdown section parser ---

interface ParsedSections {
  /** Everything before the first ## heading */
  preamble: string
  /** Map of section name → content (without the ## heading itself) */
  sections: Map<string, string>
}

function parseMarkdownSections(md: string): ParsedSections {
  const lines = md.split('\n')
  let preamble = ''
  const sections = new Map<string, string>()
  let currentSection: string | null = null
  let currentContent: string[] = []

  for (const line of lines) {
    const h2Match = line.match(/^## (.+)$/)
    if (h2Match) {
      if (currentSection !== null) {
        sections.set(currentSection, currentContent.join('\n'))
      } else {
        preamble = currentContent.join('\n')
      }
      currentSection = h2Match[1].trim()
      currentContent = []
    } else {
      currentContent.push(line)
    }
  }

  if (currentSection !== null) {
    sections.set(currentSection, currentContent.join('\n'))
  } else {
    preamble = currentContent.join('\n')
  }

  return { preamble, sections }
}

/**
 * Create workspace files directory and write all per-bot files.
 * Skips global files (SOUL.md, TOOLS.md) — they live in roles/.
 */
export function createWorkspaceFiles(botDir: string, files: Record<WorkspaceFileName, string>): void {
  const wsDir = getWorkspaceDir(botDir)
  mkdirSync(wsDir, { recursive: true })
  for (const [name, content] of Object.entries(files)) {
    if (GLOBAL_FILES.has(name as WorkspaceFileName)) continue
    writeFileSync(resolve(wsDir, name), content, 'utf-8')
  }
}

// --- Seed templates for writable workspace files ---

export const BOT_SOUL_TEMPLATE = `<!--
BOT_SOUL.md -- per-bot soul overlay.
Доповнює глобальний SOUL.md (roles/_soul.md). Додай сюди тільки те,
що відрізняє цього бота від базового характеру: тон, манери,
персональні фразочки, локальні правила поведінки.
Залиш порожнім, якщо нічого не відрізняє.
-->
`

export const USER_MD_TEMPLATE = `# Про користувача

_Дізнавайся про людину якій допомагаєш. Оновлюй цей файл в міру того, як вчишся._

- **Ім'я:**
- **Як звертатись:**
- **Timezone:**
- **Мова:**

## Контекст

_(Чим займається? Які проекти? Що важливо? Що дратує? Що тішить? Будуй це поступово.)_

## Вподобання

_(Стиль спілкування, формат відповідей, що подобається / не подобається. Це формує як ти працюєш.)_

---

_Чим більше знаєш -- тим краще допомагаєш. Але ти вивчаєш людину, а не будуєш досьє. Поважай різницю._
`

export const MEMORY_MD_TEMPLATE = `# Курована пам'ять

_Не сирі логи, а дистильована суть. Записуй одразу -- сесія може обірватись._

## Важливі правила (уроки з досвіду)

_(Помилки, баги, рішення що спрацювали. "Не робити X -- зламало Y", "Для Z завжди використовувати W".)_

## Поточні проекти / контекст

_(Активна робота. Що роблю, на якому етапі, що далі. Оновлюй коли статус змінюється.)_

## Прийняті рішення

_(Рішення з наслідками та reasoning. "Обрали X замість Y, тому що Z". Не записуй рішення без "тому що".)_

## Патерни

_(Коли зрозумів щось про користувача або роботу. "Коли питає A, зазвичай має на увазі B".)_

---

**Коли оновлювати:** помилка з уроком, рішення з "тому що", зрозумів патерн, змінився статус проекту.

**Коли НЕ оновлювати:** одноразові події (diary), атомарні факти (SaveFact), профіль (USER.md).
`

// --- User profile nudge ---

/** Analyze USER.md completeness and return a nudge string for the agent, or null if profile is sufficient. */
export function getUserNudge(botDir: string): string | null {
  const content = readWorkspaceFile(botDir, 'USER.md')

  // No USER.md or empty — strong nudge
  if (!content || content.trim().length < 50) {
    return '[USER.md порожній — ти не знаєш хто ця людина. Спершу виконай запит користувача, а в кінці відповіді запитай як її звати. Потім оновити USER.md.]'
  }

  const hasName = /\*\*Ім'я:\*\*[ \t]*\S/.test(content)
  const hasTimezone = /\*\*Timezone:\*\*[ \t]*\S/.test(content)
  const hasLang = /\*\*Мова:\*\*[ \t]*\S/.test(content)

  // Extract name for personalized nudge
  const nameMatch = content.match(/\*\*Ім'я:\*\*[ \t]*(.+)/)
  const name = nameMatch ? nameMatch[1].trim() : 'користувача'

  // Level 1: no name — ask right away (can't even address them properly)
  if (!hasName) {
    return '[USER.md порожній — ти не знаєш хто ця людина. Спершу виконай запит користувача, а в кінці відповіді запитай як її звати. Потім оновити USER.md.]'
  }

  // Measure richness: content after basic fields (Контекст + Вподобання sections)
  const contextMatch = content.match(/##\s*Контекст\s*\n([\s\S]*?)(?=##|$)/)
  const prefsMatch = content.match(/##\s*Вподобання\s*\n([\s\S]*?)(?=##|$)/)
  const contextLen = (contextMatch?.[1] ?? '').replace(/[_\s()\-]/g, '').length
  const prefsLen = (prefsMatch?.[1] ?? '').replace(/[_\s()\-]/g, '').length
  const richness = contextLen + prefsLen

  // Level 2: has name but thin profile — nudge during pauses
  if (richness < 300 || !hasTimezone || !hasLang) {
    const missing: string[] = []
    if (!hasTimezone) missing.push('timezone')
    if (!hasLang) missing.push('мова')
    if (contextLen < 100) missing.push('контекст (чим займається)')
    if (prefsLen < 50) missing.push('вподобання')
    return `[Профіль ${name} неповний — бракує: ${missing.join(', ')}. НЕ перебивай роботу. Запитай ТІЛЬКИ якщо є природна пауза: задача завершена, легка розмова, або користувач сам торкнувся теми. Одне питання за раз. Потім оновити USER.md.]`
  }

  // Level 3: decent profile but could be richer — passive
  if (richness < 500) {
    return '[Якщо в розмові природно з\'явиться нова інформація про користувача — оновити USER.md. Не питай спеціально.]'
  }

  // Rich profile — no nudge
  return null
}
