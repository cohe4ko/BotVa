import type { Bot, Context } from 'grammy'
import { getChatSetting, setChatSetting, deleteChatSetting, getSession, setSession, clearSession, logAudit } from './db.js'
import { chatT, getChatLang, setChatLang, type BotT } from './bot-i18n.js'
import { getModel, setModel, MODELS, getModelLabel } from './model.js'
import { listDiskSessionsByKey, listClaudeProjects, getSessionDetail } from './disk-sessions.js'
import { escapeHtml } from './message-format.js'
import { BOT_DIR } from './config.js'
import { logger } from './logger.js'

// --- Settings option constants ---

export const STYLE_OPTIONS = [
  { id: 'brunette', labelKey: 'style.brunette.label' },
  { id: 'blonde', labelKey: 'style.blonde.label' },
]
export const DELAY_OPTIONS = [
  { id: '0', label: '0с' },
  { id: '15', label: '15с' },
  { id: '30', label: '30с' },
  { id: '60', label: '60с' },
  { id: 'inf', label: '∞' },
]
export const TEAM_OPTIONS = [
  { id: 'all', labelKey: 'teamwork.all.label' },
  { id: 'result', labelKey: 'teamwork.result.label' },
  { id: 'none', labelKey: 'teamwork.none.label' },
]
export const AGENT_MODE_OPTIONS = [
  { id: 'full', labelKey: 'agent.full' },
  { id: 'ask', labelKey: 'agent.ask' },
  { id: 'plan', labelKey: 'agent.plan' },
]

// --- Settings message builder ---

export function buildSettingsMessage(chatId: string) {
  const t = chatT(chatId)
  const voiceOn = getChatSetting(chatId, 'voice') === '1'
  const voiceConfirmOn = getChatSetting(chatId, 'voice_confirm') === '1'
  const statsOn = getChatSetting(chatId, 'stats') === '1'
  const factsOn = getChatSetting(chatId, 'fact_notify') !== '0' // ON by default
  const lang = getChatLang(chatId)
  const style = getChatSetting(chatId, 'progress_style') ?? 'brunette'
  const delay = getChatSetting(chatId, 'progress_delay') ?? '0'
  const team = getChatSetting(chatId, 'show_team_work') ?? 'none'

  const styleLabel = t(STYLE_OPTIONS.find(o => o.id === style)?.labelKey ?? 'style.brunette.label')
  const delayLabel = DELAY_OPTIONS.find(o => o.id === delay)?.label ?? DELAY_OPTIONS[0].label
  const teamLabel = t(TEAM_OPTIONS.find(o => o.id === team)?.labelKey ?? 'teamwork.none.label')
  const agentMode = getChatSetting(chatId, 'agent_mode') ?? 'full'
  const agentLabel = t(AGENT_MODE_OPTIONS.find(o => o.id === agentMode)?.labelKey ?? 'agent.full')
  const langLabel = t(`lang.${lang}`)

  const keyboard = [
    [
      { text: t(voiceOn ? 'settings.voice.on' : 'settings.voice.off'), callback_data: 'settings:voice' },
      { text: t(voiceConfirmOn ? 'settings.voice_confirm.on' : 'settings.voice_confirm.off'), callback_data: 'settings:voice_confirm' },
    ],
    [
      { text: t(statsOn ? 'settings.stats.on' : 'settings.stats.off'), callback_data: 'settings:stats' },
      { text: t(factsOn ? 'settings.facts.on' : 'settings.facts.off'), callback_data: 'settings:facts' },
    ],
    [
      { text: t('settings.agent', { label: agentLabel }), callback_data: 'settings:agent_mode' },
      { text: t('settings.lang', { label: langLabel }), callback_data: 'settings:lang' },
    ],
    [
      { text: t('settings.style', { label: styleLabel }), callback_data: 'settings:style' },
      { text: t('settings.delay', { label: delayLabel }), callback_data: 'settings:delay' },
    ],
    [
      { text: t('settings.team', { label: teamLabel }), callback_data: 'settings:team' },
      { text: '❌ ' + t('settings.close'), callback_data: 'settings:close' },
    ],
  ]

  const lines = [
    `⚙️ <b>${t('cmd.settings.title')}</b>`,
    '',
    `🗣 <b>${voiceOn ? 'ON' : 'OFF'}</b> — ${t('settings.desc.voice')}`,
    `🎤 <b>${voiceConfirmOn ? 'ON' : 'OFF'}</b> — ${t('settings.desc.voice_confirm')}`,
    `📊 <b>${statsOn ? 'ON' : 'OFF'}</b> — ${t('settings.desc.stats')}`,
    `🧠 <b>${factsOn ? 'ON' : 'OFF'}</b> — ${t('settings.desc.facts')}`,
    `🤖 <b>${agentLabel}</b> — ${t('settings.desc.agent')}`,
    `🌐 <b>${langLabel}</b> — ${t('settings.desc.lang')}`,
    `🎨 <b>${styleLabel}</b> — ${t('settings.desc.style')}`,
    `⏱ <b>${delayLabel}</b> — ${t('settings.desc.delay')}`,
    `👥 <b>${teamLabel}</b> — ${t('settings.desc.team')}`,
  ]

  return { text: lines.join('\n'), reply_markup: { inline_keyboard: keyboard } }
}

// --- Session helpers ---

const SESSIONS_PER_PAGE = 5
const PROJECTS_PER_PAGE = 8

function timeAgo(ts: number, t: BotT): string {
  const diff = Math.floor(Date.now() / 1000) - ts
  if (diff < 60) return t('cmd.session.ago.now')
  if (diff < 3600) return t('cmd.session.ago.min', { n: Math.floor(diff / 60) })
  if (diff < 86400) return t('cmd.session.ago.hour', { n: Math.floor(diff / 3600) })
  return t('cmd.session.ago.day', { n: Math.floor(diff / 86400) })
}

function formatSessionDate(ts: number): string {
  const d = new Date(ts * 1000)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  const mon = String(d.getMonth() + 1).padStart(2, '0')
  return `${dd}.${mon} ${hh}:${mm}`
}

/** Build projects list view (level 1) */
export function buildProjectsMessage(chatId: string, page = 0) {
  const t = chatT(chatId)
  const currentSessionId = getSession(chatId)
  const projects = listClaudeProjects()
  const totalPages = Math.max(1, Math.ceil(projects.length / PROJECTS_PER_PAGE))
  const safePage = Math.max(0, Math.min(page, totalPages - 1))
  const pageProjects = projects.slice(safePage * PROJECTS_PER_PAGE, (safePage + 1) * PROJECTS_PER_PAGE)

  const lines: string[] = [
    `📋 <b>${t('cmd.session.title')}</b>`,
    '',
  ]

  if (currentSessionId) {
    const shortId = currentSessionId.slice(0, 8)
    lines.push(`▸ <b>${t('cmd.session.active')}</b>: <code>${shortId}…</code>`)
    lines.push(`<code>claude --resume ${currentSessionId}</code>`)
  } else {
    lines.push(`▸ ${t('cmd.session.none')}`)
  }

  lines.push('')
  for (const p of pageProjects) {
    lines.push(`📁 <b>${escapeHtml(p.label)}</b> — ${p.sessionCount} ses, ${timeAgo(p.lastUpdated, t)}`)
  }

  if (totalPages > 1) {
    lines.push('', `📄 ${safePage + 1} / ${totalPages}`)
  }

  const keyboard: Array<Array<{ text: string; callback_data: string }>> = []
  // Project buttons — 2 per row
  for (let i = 0; i < pageProjects.length; i += 2) {
    const row: Array<{ text: string; callback_data: string }> = []
    row.push({ text: `📁 ${pageProjects[i].label}`, callback_data: `ses:proj:${pageProjects[i].key}:0` })
    if (i + 1 < pageProjects.length) {
      row.push({ text: `📁 ${pageProjects[i + 1].label}`, callback_data: `ses:proj:${pageProjects[i + 1].key}:0` })
    }
    keyboard.push(row)
  }

  // Navigation
  const navRow: Array<{ text: string; callback_data: string }> = []
  if (safePage > 0) navRow.push({ text: '◀️', callback_data: `ses:ppage:${safePage - 1}` })
  navRow.push({ text: t('cmd.session.btn.new'), callback_data: 'ses:new' })
  if (safePage < totalPages - 1) navRow.push({ text: '▶️', callback_data: `ses:ppage:${safePage + 1}` })
  keyboard.push(navRow)

  return { text: lines.join('\n'), reply_markup: { inline_keyboard: keyboard } }
}

/** Build sessions list for a specific project (level 2) */
export function buildSessionMessage(chatId: string, projectKey: string, page = 0) {
  const t = chatT(chatId)
  const currentSessionId = getSession(chatId)
  const allSessions = listDiskSessionsByKey(projectKey)
  const totalPages = Math.max(1, Math.ceil(allSessions.length / SESSIONS_PER_PAGE))
  const safePage = Math.max(0, Math.min(page, totalPages - 1))
  const pageSessions = allSessions.slice(safePage * SESSIONS_PER_PAGE, (safePage + 1) * SESSIONS_PER_PAGE)

  // Find project label
  const projects = listClaudeProjects()
  const proj = projects.find(p => p.key === projectKey)
  const projLabel = proj?.label ?? projectKey

  const lines: string[] = [
    `📁 <b>${escapeHtml(projLabel)}</b> — ${allSessions.length} sessions`,
    '',
  ]

  if (allSessions.length > 0) {
    for (const s of pageSessions) {
      const active = currentSessionId === s.sessionId ? ' ✓' : ''
      const date = formatSessionDate(s.updatedAt)
      const ago = timeAgo(s.updatedAt, t)
      lines.push(`<code>${s.sessionId.slice(0, 8)}</code>${active}`)
      lines.push(`  ${escapeHtml(s.title || s.preview)}`)
      lines.push(`  <i>${date} (${ago})</i>`)
      lines.push('')
    }
    if (totalPages > 1) {
      lines.push(`📄 ${safePage + 1} / ${totalPages}`)
    }
  } else {
    lines.push(t('cmd.session.empty'))
  }

  const keyboard: Array<Array<{ text: string; callback_data: string }>> = []

  for (const s of pageSessions) {
    const active = currentSessionId === s.sessionId ? '✓ ' : ''
    const label = s.title || s.preview.slice(0, 35) || s.sessionId.slice(0, 8)
    keyboard.push([
      { text: `${active}${label}`, callback_data: `ses:load:${s.sessionId}` },
    ])
  }

  // Navigation
  const navRow: Array<{ text: string; callback_data: string }> = []
  if (safePage > 0) navRow.push({ text: '◀️', callback_data: `ses:proj:${projectKey}:${safePage - 1}` })
  navRow.push({ text: '← back', callback_data: 'ses:projects:0' })
  if (safePage < totalPages - 1) navRow.push({ text: '▶️', callback_data: `ses:proj:${projectKey}:${safePage + 1}` })
  keyboard.push(navRow)

  return { text: lines.join('\n'), reply_markup: { inline_keyboard: keyboard } }
}

// --- Callback handlers ---

/** Handle settings:* callback queries. Returns true if handled. */
export async function handleSettingsCallback(
  ctx: Context,
  chatIdStr: string,
  key: string,
  clearPlanState: (chatId: string) => void,
): Promise<void> {
  switch (key) {
    case 'voice':
      if (getChatSetting(chatIdStr, 'voice') === '1') deleteChatSetting(chatIdStr, 'voice')
      else setChatSetting(chatIdStr, 'voice', '1')
      break
    case 'voice_confirm':
      if (getChatSetting(chatIdStr, 'voice_confirm') === '1') deleteChatSetting(chatIdStr, 'voice_confirm')
      else setChatSetting(chatIdStr, 'voice_confirm', '1')
      break
    case 'stats':
      if (getChatSetting(chatIdStr, 'stats') === '1') deleteChatSetting(chatIdStr, 'stats')
      else setChatSetting(chatIdStr, 'stats', '1')
      break
    case 'facts':
      if (getChatSetting(chatIdStr, 'fact_notify') === '0') deleteChatSetting(chatIdStr, 'fact_notify')
      else setChatSetting(chatIdStr, 'fact_notify', '0')
      break
    case 'lang': {
      const cur = getChatLang(chatIdStr)
      setChatLang(chatIdStr, cur === 'uk' ? 'en' : 'uk')
      break
    }
    case 'style': {
      const cur = getChatSetting(chatIdStr, 'progress_style') ?? 'brunette'
      const ids = STYLE_OPTIONS.map(o => o.id)
      const next = ids[(ids.indexOf(cur) + 1) % ids.length]
      if (next === 'brunette') deleteChatSetting(chatIdStr, 'progress_style')
      else setChatSetting(chatIdStr, 'progress_style', next)
      break
    }
    case 'delay': {
      const cur = getChatSetting(chatIdStr, 'progress_delay') ?? '0'
      const ids = DELAY_OPTIONS.map(o => o.id)
      const next = ids[(ids.indexOf(cur) + 1) % ids.length]
      setChatSetting(chatIdStr, 'progress_delay', next)
      break
    }
    case 'team': {
      const cur = getChatSetting(chatIdStr, 'show_team_work') ?? 'none'
      const ids = TEAM_OPTIONS.map(o => o.id)
      const next = ids[(ids.indexOf(cur) + 1) % ids.length]
      if (next === 'none') deleteChatSetting(chatIdStr, 'show_team_work')
      else setChatSetting(chatIdStr, 'show_team_work', next)
      break
    }
    case 'agent_mode': {
      const cur = getChatSetting(chatIdStr, 'agent_mode') ?? 'full'
      const ids = AGENT_MODE_OPTIONS.map(o => o.id)
      const next = ids[(ids.indexOf(cur) + 1) % ids.length]
      if (next === 'full') deleteChatSetting(chatIdStr, 'agent_mode')
      else setChatSetting(chatIdStr, 'agent_mode', next)
      clearPlanState(chatIdStr)  // Reset plan phase on mode switch
      break
    }
    case 'close': {
      await ctx.answerCallbackQuery()
      try { await ctx.deleteMessage() } catch { /* ignore */ }
      return
    }
  }

  const { text, reply_markup } = buildSettingsMessage(chatIdStr)
  await ctx.answerCallbackQuery()
  await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup })
}

/** Handle model:* callback queries */
export async function handleModelCallback(ctx: Context, chatIdStr: string, modelId: string): Promise<void> {
  const _t = chatT(chatIdStr)

  if (modelId === 'close') {
    await ctx.answerCallbackQuery()
    try { await ctx.deleteMessage() } catch { /* ignore */ }
    return
  }

  const validIds = MODELS.map(m => m.id)
  if (!validIds.includes(modelId)) {
    await ctx.answerCallbackQuery({ text: _t('cb.unknownModel') })
    return
  }
  setModel(chatIdStr, modelId)
  const label = getModelLabel(modelId)
  await ctx.answerCallbackQuery({ text: _t('cmd.model.set', { label }) })

  // Update the message with new selection — 2 columns + close
  const lines = MODELS.map(m => {
    const marker = m.id === modelId ? '→' : '  '
    return `${marker} <b>${m.label}</b> — ${_t(`model.${m.id}`)}`
  })
  const buttons = MODELS.map(m => {
    const btnLabel = m.id === modelId ? `✓ ${m.label}` : m.label
    return { text: btnLabel, callback_data: `model:${m.id}` }
  })
  const keyboard: { text: string; callback_data: string }[][] = []
  for (let i = 0; i < buttons.length; i += 2) {
    keyboard.push(buttons.slice(i, i + 2))
  }
  keyboard.push([{ text: `❌ ${_t('settings.close')}`, callback_data: 'model:close' }])
  await ctx.editMessageText(
    `${_t('cmd.model.title', { label })}\n\n${lines.join('\n')}`,
    { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } }
  )
}

/** Handle ses:* callback queries */
export async function handleSessionCallback(ctx: Context, chatIdStr: string, action: string): Promise<void> {
  const _t = chatT(chatIdStr)

  if (action === 'new') {
    clearSession(chatIdStr)
    logAudit(chatIdStr, 'session_clear')
    await ctx.answerCallbackQuery({ text: _t('cmd.newchat') })
    const { text, reply_markup } = buildProjectsMessage(chatIdStr)
    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup })
    return
  }

  // Projects list pagination
  if (action.startsWith('projects:') || action.startsWith('ppage:')) {
    const page = parseInt(action.split(':')[1], 10)
    await ctx.answerCallbackQuery()
    const { text, reply_markup } = buildProjectsMessage(chatIdStr, page)
    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup })
    return
  }

  // Open project sessions: ses:proj:<key>:<page>
  if (action.startsWith('proj:')) {
    const parts = action.slice(5) // remove 'proj:'
    const lastColon = parts.lastIndexOf(':')
    const projectKey = parts.slice(0, lastColon)
    const page = parseInt(parts.slice(lastColon + 1), 10) || 0
    await ctx.answerCallbackQuery()
    const { text, reply_markup } = buildSessionMessage(chatIdStr, projectKey, page)
    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup })
    return
  }

  if (action.startsWith('load:')) {
    const sessionId = action.slice(5)
    setSession(chatIdStr, sessionId)
    const shortId = sessionId.slice(0, 8)
    await ctx.answerCallbackQuery({ text: _t('cmd.session.loaded', { name: shortId }) })

    // Show session info instead of menu
    const detail = getSessionDetail(sessionId)
    const lines: string[] = [
      `✅ <b>${_t('cmd.session.loaded', { name: shortId })}</b>`,
      '',
      `<code>claude --resume ${sessionId}</code>`,
    ]
    if (detail) {
      lines.push('', `📝 <b>${_t('cmd.session.first')}:</b>`)
      lines.push(escapeHtml(detail.firstMessage))
      if (detail.lastUserMessage) {
        lines.push('', `💬 <b>${_t('cmd.session.last')}:</b>`)
        lines.push(escapeHtml(detail.lastUserMessage))
      }
    }
    await ctx.editMessageText(lines.join('\n'), { parse_mode: 'HTML' })
    return
  }
}

/** Register settings-related commands on the bot */
export function registerSettingsCommands(
  bot: Bot,
  isAuthorised: (chatId: number) => boolean,
): void {
  // /settings (unified settings menu)
  const openSettingsHandler = async (ctx: Context) => {
    if (!isAuthorised(ctx.chat!.id)) return
    const { text, reply_markup } = buildSettingsMessage(String(ctx.chat!.id))
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup })
  }
  bot.command('settings', openSettingsHandler)
  // Hidden aliases — old individual settings commands open /settings
  bot.command('voice', openSettingsHandler)
  bot.command('stats', openSettingsHandler)
  bot.command('lang', openSettingsHandler)
  bot.command('style', openSettingsHandler)
  bot.command('delay', openSettingsHandler)
  bot.command('show_team_work', openSettingsHandler)

  // /model
  bot.command('model', async (ctx) => {
    if (!isAuthorised(ctx.chat.id)) return
    const chatIdStr = String(ctx.chat.id)
    const t = chatT(chatIdStr)
    const text = ctx.message?.text ?? ''
    const args = text.split(' ').slice(1).join(' ').trim().toLowerCase()

    const currentModel = getModel(chatIdStr)
    const validIds = MODELS.map(m => m.id)

    // Direct: /model sonnet
    if (args) {
      if (!validIds.includes(args)) {
        await ctx.reply(t('cmd.model.unknown', { args, models: validIds.join(', ') }))
        return
      }
      setModel(chatIdStr, args)
      await ctx.reply(t('cmd.model.set', { label: getModelLabel(args) }))
      return
    }

    // Interactive keyboard — 2 columns, close button
    const buttons = MODELS.map(m => {
      const label = m.id === currentModel ? `✓ ${m.label}` : m.label
      return { text: label, callback_data: `model:${m.id}` }
    })
    const keyboard: { text: string; callback_data: string }[][] = []
    for (let i = 0; i < buttons.length; i += 2) {
      keyboard.push(buttons.slice(i, i + 2))
    }
    keyboard.push([{ text: `❌ ${t('settings.close')}`, callback_data: 'model:close' }])

    const lines = MODELS.map(m => {
      const marker = m.id === currentModel ? '→' : '  '
      return `${marker} <b>${m.label}</b> — ${t(`model.${m.id}`)}`
    })

    await ctx.reply(
      `${t('cmd.model.title', { label: getModelLabel(currentModel) })}\n\n${lines.join('\n')}`,
      { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } }
    )
  })

  // /session
  bot.command('session', async (ctx) => {
    if (!isAuthorised(ctx.chat.id)) return
    const chatIdStr = String(ctx.chat.id)
    const t = chatT(chatIdStr)
    const text = ctx.message?.text ?? ''
    const args = text.replace(/^\/session\s*/, '').trim()

    // /session import <session_id> — resume a CLI session in Telegram
    if (args.startsWith('import ')) {
      const sessionId = args.slice(7).trim()
      if (!sessionId) {
        await ctx.reply(t('cmd.session.import_usage'))
        return
      }
      setSession(chatIdStr, sessionId)
      await ctx.reply(t('cmd.session.imported'))
      return
    }

    // Default: show projects list
    const { text: msgText, reply_markup } = buildProjectsMessage(chatIdStr)
    await ctx.reply(msgText, { parse_mode: 'HTML', reply_markup })
  })
}
