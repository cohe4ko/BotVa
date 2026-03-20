import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync, statSync, readdirSync } from 'fs'
import { resolve, basename } from 'path'

// --- Constants ---

const WORKSPACE_DIR = 'workspace-files'

/** Order in which workspace files are assembled into CLAUDE.md. */
const ASSEMBLY_ORDER = ['IDENTITY.md', 'SOUL.md', 'ROLE.md', 'TOOLS.md', 'USER.md', 'MEMORY.md'] as const

const ALL_FILE_NAMES = [...ASSEMBLY_ORDER] as const

export type WorkspaceFileName = typeof ALL_FILE_NAMES[number]

/** Files the bot agent can write via WriteWorkspaceFile tool */
const BOT_WRITABLE_FILES = new Set<WorkspaceFileName>(['USER.md', 'MEMORY.md'])


const ALL_FILES = new Set<WorkspaceFileName>(ALL_FILE_NAMES)

// --- Core Functions ---

export function getWorkspaceDir(botDir: string): string {
  return resolve(botDir, WORKSPACE_DIR)
}

export function hasWorkspaceFiles(botDir: string): boolean {
  const wsDir = getWorkspaceDir(botDir)
  if (!existsSync(wsDir)) return false
  // Must have at least SOUL.md and IDENTITY.md
  return existsSync(resolve(wsDir, 'SOUL.md')) && existsSync(resolve(wsDir, 'IDENTITY.md'))
}

export function readWorkspaceFile(botDir: string, filename: WorkspaceFileName): string | null {
  if (!ALL_FILES.has(filename)) return null
  const filePath = resolve(getWorkspaceDir(botDir), filename)
  if (!existsSync(filePath)) return null
  return readFileSync(filePath, 'utf-8')
}

export function writeWorkspaceFile(botDir: string, filename: WorkspaceFileName, content: string): void {
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


export function isValidWorkspaceFile(filename: string): filename is WorkspaceFileName {
  return ALL_FILES.has(filename as WorkspaceFileName)
}

export interface WorkspaceFileInfo {
  name: WorkspaceFileName
  writable: boolean
  exists: boolean
  size: number
}

export function listWorkspaceFiles(botDir: string): WorkspaceFileInfo[] {
  const wsDir = getWorkspaceDir(botDir)
  return ALL_FILE_NAMES.map(name => {
    const filePath = resolve(wsDir, name)
    const exists = existsSync(filePath)
    return {
      name,
      writable: BOT_WRITABLE_FILES.has(name),
      exists,
      size: exists ? statSync(filePath).size : 0,
    }
  })
}

// --- Assembly ---

/** Assemble all workspace files into a single CLAUDE.md content string. */
export function assembleFromWorkspaceFiles(botDir: string): string {
  const wsDir = getWorkspaceDir(botDir)
  const parts: string[] = []

  for (const filename of ASSEMBLY_ORDER) {
    const filePath = resolve(wsDir, filename)
    if (!existsSync(filePath)) continue
    const content = readFileSync(filePath, 'utf-8').trim()
    if (!content) continue
    parts.push(content)
  }

  return parts.join('\n\n')
}

/** Reassemble CLAUDE.md from workspace files if they exist. Called before each agent query. */
export function refreshClaudeMd(botDir: string): void {
  if (!hasWorkspaceFiles(botDir)) return
  const content = assembleFromWorkspaceFiles(botDir)
  writeFileSync(resolve(botDir, 'CLAUDE.md'), content, 'utf-8')
}

// --- Building workspace files from role templates ---

/**
 * Build workspace files directly from role template + base files.
 * Role templates use --- IDENTITY/ROLE/TOOLS --- markers.
 * Base files: _soul.md → SOUL.md, _tools.md → merged into TOOLS.md.
 */
export function buildWorkspaceFilesFromRole(
  role: string, botName: string, emoji: string, rolesDir: string
): Record<WorkspaceFileName, string> {
  const soul = readFileSync(resolve(rolesDir, '_soul.md'), 'utf-8')
  const baseTools = readFileSync(resolve(rolesDir, '_tools.md'), 'utf-8')

  let template = readFileSync(resolve(rolesDir, `${role}.md`), 'utf-8')
  template = template.replaceAll('{{BOT_NAME}}', botName)
  template = template.replaceAll('{{BOT_EMOJI}}', emoji)

  const sections = parseRoleMarkers(template)

  const toolsParts = [baseTools.trim(), sections.TOOLS.trim()].filter(Boolean)

  return {
    'IDENTITY.md': sections.IDENTITY.trim(),
    'SOUL.md': soul.trim(),
    'ROLE.md': sections.ROLE.trim(),
    'TOOLS.md': toolsParts.join('\n\n'),
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
  const soulContent = sections.sections.get('Soul') ?? ''
  const toolsContent = sections.sections.get('Коли який інструмент') ?? ''

  const roleParts: string[] = []
  for (const [name, content] of sections.sections) {
    if (name === 'Soul' || name === 'Коли який інструмент') continue
    roleParts.push(`## ${name}\n\n${content.trim()}`)
  }
  const roleContent = roleParts.join('\n\n')

  return {
    'IDENTITY.md': identityContent,
    'SOUL.md': soulContent.trim(),
    'ROLE.md': roleContent,
    'TOOLS.md': toolsContent ? `## Коли який інструмент\n\n${toolsContent.trim()}` : '',
    'USER.md': USER_MD_TEMPLATE,
    'MEMORY.md': MEMORY_MD_TEMPLATE,
  }
}

/** Split default (non-role) CLAUDE.md into minimal workspace files */
export function splitDefaultIntoWorkspaceFiles(claudeMd: string, botName: string, emoji: string): Record<WorkspaceFileName, string> {
  return {
    'IDENTITY.md': `# ${botName} ${emoji}`,
    'SOUL.md': claudeMd,
    'ROLE.md': '',
    'TOOLS.md': '',
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
      // Save previous section
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

  // Save last section
  if (currentSection !== null) {
    sections.set(currentSection, currentContent.join('\n'))
  } else {
    preamble = currentContent.join('\n')
  }

  return { preamble, sections }
}

/** Create workspace files directory and write all files */
export function createWorkspaceFiles(botDir: string, files: Record<WorkspaceFileName, string>): void {
  const wsDir = getWorkspaceDir(botDir)
  mkdirSync(wsDir, { recursive: true })
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(resolve(wsDir, name), content, 'utf-8')
  }
}

// --- Seed templates for writable workspace files ---

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

