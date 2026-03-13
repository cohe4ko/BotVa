import { getChatSetting, setChatSetting } from './db.js'

export type BotLang = 'en' | 'uk'
export type BotT = (key: string, params?: Record<string, string | number>) => string

const translations: Record<BotLang, Record<string, string>> = {
  en: {
    // Auth
    'auth.denied': 'Access denied. Your chat ID: {chatId}',
    'auth.noReply': '(no reply)',

    // Start / Help
    'cmd.start': "BotVa online.\n\nYour chat ID: <code>{chatId}</code>\n\n/new -- new session\n/cancel -- cancel current request\n/model -- switch AI model\n/memory -- recent memories\n/usage -- usage stats\n/settings -- voice, language, style & more\n/admin -- admin panel",
    'cmd.chatid': 'Your chat ID: <code>{chatId}</code>',

    // Session
    'cmd.newchat': 'Session cleared. Starting fresh.',

    // Cancel
    'cancel.request': 'request cancelled',
    'cancel.queue': '{n} in queue cleared',
    'cancel.nothing': 'Nothing to cancel.',

    // Memory
    'cmd.memory.empty': 'No memories yet.',
    'cmd.memory.title': 'Recent memories:',

    // Voice
    'cmd.voice.noTts': 'TTS not configured. Voice replies unavailable.',
    'cmd.voice.off': 'Voice replies OFF.',
    'cmd.voice.on': 'Voice replies ON.',
    'cmd.voice.noStt': 'Voice transcription not configured. Add GROQ_API_KEY to .env',
    'cmd.voice.fail': 'Failed to process voice message.',

    // Usage
    'cmd.usage.title': '<b>BotVa Usage</b>',
    'cmd.usage.hour': '<b>Last hour:</b> {requests} requests | {tokens} tokens | {cost}',
    'cmd.usage.day': '<b>Last day:</b> {requests} requests | {tokens} tokens | {cost}',
    'cmd.usage.week': '<b>Last week:</b> {requests} requests | {tokens} tokens | {cost}',
    'cmd.usage.details': 'Week details:',

    // Stats
    'cmd.stats.off': 'Stats footer under messages OFF.',
    'cmd.stats.on': 'Stats footer under messages ON.',

    // Edit (photo caption)
    'cmd.edit.usage': 'Add description of changes: /edit <description>',
    'cmd.edit.fail': 'Failed to edit image.',
    'cmd.edit.error': 'Editing error: {err}',

    // Model
    'cmd.model.unknown': 'Unknown model: {args}\nAvailable: {models}',
    'cmd.model.set': 'Model: {label}',
    'cmd.model.title': 'Model: <b>{label}</b>',
    'model.opus': 'Most capable',
    'model.sonnet': 'Balanced',
    'model.haiku': 'Fast & light',

    // Lang
    'cmd.lang.set': 'Language set to English.',
    'cmd.lang.title': 'Language: <b>{label}</b>',
    'lang.en': 'English',
    'lang.uk': 'Українська',

    // Delay
    'delay.title': 'Progress cleanup delay: <b>{label}</b>',
    'delay.feedback': 'Delay: {label}',
    'delay.0': 'immediately',
    'delay.15': '15 seconds',
    'delay.30': '30 seconds',
    'delay.60': '1 minute',
    'delay.inf': 'never delete',
    'delay.default': 'default (~18s)',

    // Style
    'style.title': 'Progress style: <b>{label}</b>',
    'style.feedback': 'Style: {label}',
    'style.brunette': 'technical style',
    'style.brunette.label': '👩‍💻 Brunette',
    'style.blonde': 'cute style',
    'style.blonde.label': '👱‍♀️ Blonde',

    // Team work
    'teamwork.title': 'Team work visibility: <b>{label}</b>',
    'teamwork.feedback': 'Visibility: {label}',
    'teamwork.all': 'request, response, typing',
    'teamwork.all.label': '📢 All',
    'teamwork.result': 'result only',
    'teamwork.result.label': '📋 Request and response',
    'teamwork.none': 'don\'t show',
    'teamwork.none.label': '🔇 Nothing',

    // Admin
    'admin.running': 'Admin panel is running:',
    'admin.started': 'Admin panel started:',
    'admin.stopped': 'Admin panel stopped.',
    'admin.idle': 'Admin panel stopped (20 min inactivity).',
    'admin.notRunning': 'Admin panel not running',
    'admin.open': '🔧 Open',
    'admin.stop': '🛑 Stop',
    'admin.stoppedShort': 'Stopped',

    // Callbacks
    'cb.questionExpired': 'Question no longer relevant',
    'cb.stopping': 'Stopping...',
    'cb.nothingToStop': 'Nothing to stop',
    'cb.unknownModel': 'Unknown model',
    'cb.askSkip': '✏️ Other (skip)',
    'cb.userSkipped': 'User skipped the question',

    // Media
    'media.photoFail': 'Failed to process photo.',
    'media.docFail': 'Failed to process document.',
    'media.videoFail': 'Failed to process video.',

    // Followup
    'followup.prefix': '[User added message during your work]: {text}\n\nConsider this message and continue your previous task.',

    // Progress reporter
    'progress.stop': '⏹ Stop',
    'progress.stopCute': '🛑 Stop!',
    'progress.rateLimit': '⏳ Rate limit, waiting...',
    'progress.billing': '💳 Billing error',
    'progress.authError': '🔑 Auth error',
    'progress.serverError': '🔥 Server error',
    'progress.compacting': '📦 <i>compacting context...</i>',
    'progress.compacted': '📦 <i>context compacted (was {k} tokens)</i>',
    'progress.auth': 'authorizing...',
    'progress.doneIn': '✨ done in {duration}',
    'progress.done': '✨ done!',

    // Progress cute mode
    'progress.cute.read': '📖 reading a file',
    'progress.cute.write': '✏️ writing a file',
    'progress.cute.edit': '💅 tweaking some bits',
    'progress.cute.glob': '🔍 looking for files',
    'progress.cute.grep': '👀 browsing folders',
    'progress.cute.bash': '⚡ running a command',
    'progress.cute.websearch': '🌐 googling',
    'progress.cute.webfetch': '📥 downloading a page',
    'progress.cute.agent': '🤖 helper is thinking',
    'progress.cute.todowrite': '📝 writing a task',
    'progress.cute.todoread': '📋 checking tasks',
    'progress.cute.notebookedit': '📓 editing notebook',
    'progress.cute.skill': '✨ using a skill',
    'progress.cute.default': '🔮 doing magic',
    'progress.cute.compacting': '🧹 tidying up thoughts...',
    'progress.cute.compacted': '🧹 thoughts tidied up',
    'progress.cute.auth': '🔑 authorizing...',
    'progress.cute.authFail': '🔑 oops, not allowed',
    'progress.cute.hookFail': '⚙️ oops, something broke',
    'progress.cute.rateLimit': '⏳ waiting a bit...',
    'progress.cute.billing': '💳 oops, payment issue',
    'progress.cute.authError': '🔑 couldn\'t log in',
    'progress.cute.serverError': '🔥 server feels bad',
    'progress.cute.working': '⏳ working',
    'progress.cute.done': '✅ done!',
    'progress.cute.stop': '🛑 Stop!',
    'progress.cute.bitrix24': '📋 checking CRM',
    'progress.cute.homeassistant': '🏠 controlling home',
    'progress.cute.stagehand': '🎭 controlling browser',
    'progress.cute.playwright': '🎭 controlling browser',
    'progress.cute.macoscontrol': '🖥️ controlling Mac',
    'progress.cute.googleworkspace': '📧 checking email',

    // Consolidation
    'consolidate.done': '🧠 Memory consolidation for {date} complete.',

    // Settings
    'cmd.settings.title': 'Settings',
    'settings.voice.on': '🗣 Voice: ON',
    'settings.voice.off': '🗣 Voice: OFF',
    'settings.stats.on': '📊 Stats: ON',
    'settings.stats.off': '📊 Stats: OFF',
    'settings.lang': '🌐 {label}',
    'settings.style': '🎨 {label}',
    'settings.delay': '⏱ {label}',
    'settings.team': '👥 {label}',

    // Bot commands menu
    'menu.start': 'Start',
    'menu.new': 'New session (clear context)',
    'menu.cancel': 'Cancel current request',
    'menu.model': 'Switch AI model',
    'menu.memory': 'Show recent memories',
    'menu.usage': 'Usage stats',
    'menu.settings': 'Settings',
    'menu.admin': 'Start/stop admin panel',
  },

  uk: {
    // Auth
    'auth.denied': 'Немає доступу. Твій chat ID: {chatId}',
    'auth.noReply': '(без відповіді)',

    // Start / Help
    'cmd.start': "BotVa на зв'язку.\n\nТвій chat ID: <code>{chatId}</code>\n\n/new -- нова сесія\n/cancel -- скасувати поточний запит\n/model -- змінити модель AI\n/memory -- останні спогади\n/usage -- статистика використання\n/settings -- голос, мова, стиль та інше\n/admin -- адмін панель",
    'cmd.chatid': 'Твій chat ID: <code>{chatId}</code>',

    // Session
    'cmd.newchat': 'Сесію очищено. Починаємо з нуля.',

    // Cancel
    'cancel.request': 'запит скасовано',
    'cancel.queue': '{n} в черзі очищено',
    'cancel.nothing': 'Нічого скасовувати.',

    // Memory
    'cmd.memory.empty': 'Спогадів поки немає.',
    'cmd.memory.title': 'Останні спогади:',

    // Voice
    'cmd.voice.noTts': 'TTS не налаштовано. Голосові відповіді недоступні.',
    'cmd.voice.off': 'Голосові відповіді ВИМКНЕНО.',
    'cmd.voice.on': 'Голосові відповіді УВІМКНЕНО.',
    'cmd.voice.noStt': 'Транскрипцію голосу не налаштовано. Додай GROQ_API_KEY в .env',
    'cmd.voice.fail': 'Не вдалося обробити голосове повідомлення.',

    // Usage
    'cmd.usage.title': '<b>Використання BotVa</b>',
    'cmd.usage.hour': '<b>За годину:</b> {requests} запитів | {tokens} токенів | {cost}',
    'cmd.usage.day': '<b>За добу:</b> {requests} запитів | {tokens} токенів | {cost}',
    'cmd.usage.week': '<b>За тиждень:</b> {requests} запитів | {tokens} токенів | {cost}',
    'cmd.usage.details': 'Деталі за тиждень:',

    // Stats
    'cmd.stats.off': 'Статистика під повідомленнями ВИМКНЕНА.',
    'cmd.stats.on': 'Статистика під повідомленнями УВІМКНЕНА.',

    // Edit (photo caption)
    'cmd.edit.usage': 'Додай опис що змінити: /edit <опис>',
    'cmd.edit.fail': 'Не вдалося відредагувати зображення.',
    'cmd.edit.error': 'Помилка редагування: {err}',

    // Model
    'cmd.model.unknown': 'Невідома модель: {args}\nДоступні: {models}',
    'cmd.model.set': 'Модель: {label}',
    'cmd.model.title': 'Модель: <b>{label}</b>',
    'model.opus': 'Найпотужніший',
    'model.sonnet': 'Збалансований',
    'model.haiku': 'Швидкий і легкий',

    // Lang
    'cmd.lang.set': 'Мову встановлено на українську.',
    'cmd.lang.title': 'Мова: <b>{label}</b>',
    'lang.en': 'English',
    'lang.uk': 'Українська',

    // Delay
    'delay.title': 'Затримка видалення прогресу: <b>{label}</b>',
    'delay.feedback': 'Затримка: {label}',
    'delay.0': 'одразу',
    'delay.15': '15 секунд',
    'delay.30': '30 секунд',
    'delay.60': '1 хвилина',
    'delay.inf': 'не видаляти',
    'delay.default': 'за замовчуванням (~18с)',

    // Style
    'style.title': 'Стиль прогресу: <b>{label}</b>',
    'style.feedback': 'Стиль: {label}',
    'style.brunette': 'технічний стиль',
    'style.brunette.label': '👩‍💻 Брюнетка',
    'style.blonde': 'милий стиль',
    'style.blonde.label': '👱‍♀️ Блондинка',

    // Team work
    'teamwork.title': 'Видимість командної роботи: <b>{label}</b>',
    'teamwork.feedback': 'Видимість: {label}',
    'teamwork.all': 'запит, відповідь, typing',
    'teamwork.all.label': '📢 Все',
    'teamwork.result': 'тільки результат',
    'teamwork.result.label': '📋 Запит і відповідь',
    'teamwork.none': 'не показувати',
    'teamwork.none.label': '🔇 Нічого',

    // Admin
    'admin.running': 'Admin panel працює:',
    'admin.started': 'Admin panel запущено:',
    'admin.stopped': 'Admin panel зупинено.',
    'admin.idle': 'Admin panel зупинено (20 хв неактивності).',
    'admin.notRunning': 'Admin panel не запущена',
    'admin.open': '🔧 Відкрити',
    'admin.stop': '🛑 Зупинити',
    'admin.stoppedShort': 'Зупинено',

    // Callbacks
    'cb.questionExpired': 'Питання вже не актуальне',
    'cb.stopping': 'Зупиняю...',
    'cb.nothingToStop': 'Нічого зупиняти',
    'cb.unknownModel': 'Невідома модель',
    'cb.askSkip': '✏️ Інше (пропустити)',
    'cb.userSkipped': 'Користувач пропустив питання',

    // Media
    'media.photoFail': 'Не вдалося обробити фото.',
    'media.docFail': 'Не вдалося обробити документ.',
    'media.videoFail': 'Не вдалося обробити відео.',

    // Followup
    'followup.prefix': '[Користувач додав повідомлення під час твоєї роботи]: {text}\n\nВрахуй це повідомлення і продовжуй виконувати попереднє завдання.',

    // Progress reporter
    'progress.stop': '⏹ Стоп',
    'progress.stopCute': '🛑 Стапе!',
    'progress.rateLimit': '⏳ Rate limit, чекаю...',
    'progress.billing': '💳 Billing помилка',
    'progress.authError': '🔑 Auth помилка',
    'progress.serverError': '🔥 Server помилка',
    'progress.compacting': '📦 <i>стискаю контекст...</i>',
    'progress.compacted': '📦 <i>контекст стиснений (було {k} токенів)</i>',
    'progress.auth': 'авторизація...',
    'progress.doneIn': '✨ готово за {duration}',
    'progress.done': '✨ готово!',

    // Progress cute mode
    'progress.cute.read': '📖 читаємо файлик',
    'progress.cute.write': '✏️ пишемо файлик',
    'progress.cute.edit': '💅 міняємо буквочки',
    'progress.cute.glob': '🔍 шукаємо файлики',
    'progress.cute.grep': '👀 продивляємось папочки',
    'progress.cute.bash': '⚡ запускаємо команду',
    'progress.cute.websearch': '🌐 гуглимо',
    'progress.cute.webfetch': '📥 завантажуємо сторіночку',
    'progress.cute.agent': '🤖 помічник думає',
    'progress.cute.todowrite': '📝 записуємо задачку',
    'progress.cute.todoread': '📋 дивимось задачки',
    'progress.cute.notebookedit': '📓 редагуємо зошит',
    'progress.cute.skill': '✨ використовуємо скіл',
    'progress.cute.default': '🔮 робимо магію',
    'progress.cute.compacting': '🧹 прибираємо в голові...',
    'progress.cute.compacted': '🧹 прибрали в голові',
    'progress.cute.auth': '🔑 авторизуємось...',
    'progress.cute.authFail': '🔑 ой, не пустили',
    'progress.cute.hookFail': '⚙️ ой, щось зламалось',
    'progress.cute.rateLimit': '⏳ трішки зачекаємо...',
    'progress.cute.billing': '💳 ой, з оплатою щось',
    'progress.cute.authError': '🔑 не вдалось увійти',
    'progress.cute.serverError': '🔥 серверу поганенько',
    'progress.cute.working': '⏳ працюємо',
    'progress.cute.done': '✅ зробили!',
    'progress.cute.stop': '🛑 Стапе!',
    'progress.cute.bitrix24': '📋 дивимось CRM',
    'progress.cute.homeassistant': '🏠 керуємо будинком',
    'progress.cute.stagehand': '🎭 керуємо браузером',
    'progress.cute.playwright': '🎭 керуємо браузером',
    'progress.cute.macoscontrol': '🖥️ керуємо маком',
    'progress.cute.googleworkspace': '📧 дивимось пошту',

    // Consolidation
    'consolidate.done': '🧠 Консолідація пам\'яті за {date} завершена.',

    // Settings
    'cmd.settings.title': 'Налаштування',
    'settings.voice.on': '🗣 Голос: УВІМК',
    'settings.voice.off': '🗣 Голос: ВИМК',
    'settings.stats.on': '📊 Статистика: УВІМК',
    'settings.stats.off': '📊 Статистика: ВИМК',
    'settings.lang': '🌐 {label}',
    'settings.style': '🎨 {label}',
    'settings.delay': '⏱ {label}',
    'settings.team': '👥 {label}',

    // Bot commands menu
    'menu.start': 'Почати роботу',
    'menu.new': 'Нова сесія (очистити контекст)',
    'menu.cancel': 'Скасувати поточний запит',
    'menu.model': 'Змінити модель AI',
    'menu.memory': 'Показати останні спогади',
    'menu.usage': 'Статистика використання',
    'menu.settings': 'Налаштування',
    'menu.admin': 'Запустити/зупинити адмін панель',
  },
}

export function createBotT(lang: BotLang): BotT {
  const dict = translations[lang] ?? translations.uk
  return (key: string, params?: Record<string, string | number>) => {
    let text = dict[key] ?? translations.uk[key] ?? key
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        text = text.replaceAll(`{${k}}`, String(v))
      }
    }
    return text
  }
}

export function getChatLang(chatId: string): BotLang {
  const val = getChatSetting(chatId, 'lang')
  if (val === 'en' || val === 'uk') return val
  return 'uk' // default Ukrainian
}

export function setChatLang(chatId: string, lang: BotLang): void {
  setChatSetting(chatId, 'lang', lang)
}

export function chatT(chatId: string): BotT {
  return createBotT(getChatLang(chatId))
}
