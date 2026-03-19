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

// --- Splitting role template into workspace files ---

/**
 * Split a fully-assembled CLAUDE.md (with _base.md already inlined) into workspace files.
 *
 * Role template structure:
 *   # BotName Emoji
 *   Description line(s)
 *   ## Soul
 *   <_base.md content>
 *   ## Спеціалізація / ## Правила / ## Ресурси / ## Робочі сценарії / ...
 *   ## Коли який інструмент
 *   <tool table>
 *   ## Формат відповідей / ## Взаємодія з командою
 */
export function splitRoleIntoWorkspaceFiles(claudeMd: string): Record<WorkspaceFileName, string> {
  const sections = parseMarkdownSections(claudeMd)

  // IDENTITY.md: everything before ## Soul (header + description)
  const identityContent = sections.preamble.trim()

  // SOUL.md: the ## Soul section content (which is the inlined _base.md)
  const soulContent = sections.sections.get('Soul') ?? ''

  // TOOLS.md: the tool selection table
  const toolsContent = sections.sections.get('Коли який інструмент') ?? ''

  // ROLE.md: all remaining role-specific sections
  const roleSections = [
    'Спеціалізація',
    'Правила',
    'Ресурси -- прочитай ПЕРЕД відповіддю',
    'Робочі сценарії',
    'Взаємодія з командою',
    'Формат відповідей',
  ]
  const roleParts: string[] = []
  for (const [name, content] of sections.sections) {
    // Skip Soul and Tools (they go to their own files)
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

_Не сирі логи, а дистильована суть. Інсайти, патерни, рішення._

## Як працює ця пам'ять

Кожна сесія починається з нуля. Цей файл -- твоя неперервність між сесіями.

**Що записувати:**
- Прийняті рішення з наслідками ("Вирішили робити X, тому що Y")
- Патерни ("Коли користувач питає A, зазвичай має на увазі B")
- Уроки з помилок ("Не робити X -- минулого разу це зламало Y")
- Важливий контекст що впливає на майбутні розмови

**Що НЕ записувати:**
- Одноразові події (погода, курс валют, новини дня)
- Те що можна нагуглити за 5 секунд
- Implementation details (це є в коді)
- Дублі того, що вже є в USER.md або SaveFact

**Принцип:** записуй тільки те, що буде корисне через 3 місяці.

---

_"Ментальні нотатки" не виживають після перезапуску. Файли -- виживають._
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

