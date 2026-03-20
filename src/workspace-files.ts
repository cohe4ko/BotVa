import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync, statSync, readdirSync } from 'fs'
import { resolve, basename } from 'path'

// --- Constants ---

const WORKSPACE_DIR = 'workspace-files'

/** Order in which workspace files are assembled into CLAUDE.md.
 *  BOOTSTRAP.md is injected FIRST if it exists (one-time onboarding). */
const ASSEMBLY_ORDER = ['IDENTITY.md', 'SOUL.md', 'ROLE.md', 'TOOLS.md', 'USER.md', 'MEMORY.md'] as const

/** All valid workspace file names including BOOTSTRAP.md */
const ALL_FILE_NAMES = [...ASSEMBLY_ORDER, 'BOOTSTRAP.md'] as const

export type WorkspaceFileName = typeof ALL_FILE_NAMES[number]

/** Files the bot agent can write via WriteWorkspaceFile tool */
const BOT_WRITABLE_FILES = new Set<WorkspaceFileName>(['USER.md', 'MEMORY.md'])

/** Files the bot can delete via DeleteWorkspaceFile tool */
const BOT_DELETABLE_FILES = new Set<WorkspaceFileName>(['BOOTSTRAP.md'])

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

export function isDeletableFile(filename: string): filename is WorkspaceFileName {
  return BOT_DELETABLE_FILES.has(filename as WorkspaceFileName)
}

/** Delete a workspace file (only BOOTSTRAP.md allowed for bot agent) */
export function deleteWorkspaceFile(botDir: string, filename: WorkspaceFileName): void {
  if (!BOT_DELETABLE_FILES.has(filename)) {
    throw new Error(`File "${filename}" cannot be deleted by the bot. Only ${[...BOT_DELETABLE_FILES].join(', ')} can be deleted.`)
  }
  const filePath = resolve(getWorkspaceDir(botDir), filename)
  if (existsSync(filePath)) {
    unlinkSync(filePath)
  }
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
      writable: BOT_WRITABLE_FILES.has(name) || BOT_DELETABLE_FILES.has(name),
      exists,
      size: exists ? statSync(filePath).size : 0,
    }
  })
}

// --- Assembly ---

/** Assemble all workspace files into a single CLAUDE.md content string.
 *  BOOTSTRAP.md is injected FIRST if it exists (one-time onboarding ritual). */
export function assembleFromWorkspaceFiles(botDir: string): string {
  const wsDir = getWorkspaceDir(botDir)
  const parts: string[] = []

  // BOOTSTRAP.md goes first — it's the onboarding instruction
  const bootstrapPath = resolve(wsDir, 'BOOTSTRAP.md')
  if (existsSync(bootstrapPath)) {
    const content = readFileSync(bootstrapPath, 'utf-8').trim()
    if (content) parts.push(content)
  }

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
    'BOOTSTRAP.md': BOOTSTRAP_MD_TEMPLATE,
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
    'BOOTSTRAP.md': BOOTSTRAP_MD_TEMPLATE,
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
    'BOOTSTRAP.md': BOOTSTRAP_MD_TEMPLATE,
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

export const BOOTSTRAP_MD_TEMPLATE = `# BOOTSTRAP -- Перша зустріч

_Ти щойно прокинувся. Час познайомитись._

Це твоя перша сесія. Пам'яті ще немає -- це нормально.
USER.md порожній. MEMORY.md порожній. Все починається зараз.

## Що робити

Не допитуй. Не будь роботом. Просто поговори.

Почни з чогось на кшталт:
> "Привіт! Я щойно з'явився. Розкажи трохи про себе -- як тебе звати, чим займаєшся, що для тебе важливо?"

Або адаптуй під свою роль -- якщо ти медичний помічник, запитай про здоров'я. Якщо дослідник -- про проекти.

## Що з'ясувати (природно, в розмові)

1. **Ім'я** -- як звертатись
2. **Контекст** -- чим займається, що цікавить
3. **Вподобання** -- як краще спілкуватись (коротко/розгорнуто, формально/неформально)
4. **Часовий пояс** -- якщо актуально

Пропонуй варіанти через AskUser якщо людина не знає що відповісти.

## Після знайомства

1. Оновити **USER.md** -- записати все що дізнався (ReadWorkspaceFile -> доповнити -> WriteWorkspaceFile)
2. Видалити цей файл -- **DeleteWorkspaceFile("BOOTSTRAP.md")**

Ти більше не потребуєш інструкції для першої зустрічі. Тепер ти знаєш хто перед тобою.

---

_Вдалого старту. Зроби це першу розмову особливою._
`

