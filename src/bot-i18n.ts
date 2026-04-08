import { getChatSetting, setChatSetting } from './db.js'

export type BotLang = 'en' | 'uk'
export type BotT = (key: string, params?: Record<string, string | number>) => string

const translations: Record<BotLang, Record<string, string>> = {
  en: {
    // Auth
    'auth.denied': 'Access denied. Your chat ID: {chatId}',
    'auth.noReply': '(no reply)',

    // Agent errors
    'agent.crash': '⚠️ Claude process crashed (exit code 1). Try again or /new for a fresh session.',
    'agent.crash.partial': '⚠️ Process interrupted. Partial response above.',
    'agent.crash.double': '⚠️ Claude process crashed twice. Try /new for a clean session, or try later.',
    'agent.error': '⚠️ Agent error:',

    // Start / Help
    'cmd.start': "BotVa online.\n\nYour chat ID: <code>{chatId}</code>\n\n/new -- new session\n/cancel -- cancel current request\n/model -- switch AI model\n/usage -- usage stats\n/settings -- voice, language, style & more\n/session -- switch sessions, import from CLI\n/admin -- admin panel",
    'cmd.chatid': 'Your chat ID: <code>{chatId}</code>',

    // Session
    'cmd.newchat': 'Session cleared. Starting fresh.',

    // Cancel
    'cancel.request': 'request cancelled',
    'cancel.queue': '{n} in queue cleared',
    'cancel.nothing': 'Nothing to cancel.',

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
    'cmd.usage.authOk': 'authenticated',
    'cmd.usage.authExpired': 'not authenticated',

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
    'model.opus-1m': 'Most capable, 1M context',
    'model.opus': 'Most capable, 200k context',
    'model.sonnet-1m': 'Balanced, 1M context',
    'model.sonnet': 'Balanced, 200k context',
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
    'style.brunette.label': '👩🏻‍⚕️ Brunette',
    'style.blonde': 'cute style',
    'style.blonde.label': '👩 Blonde',

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
    'cb.interrupting': 'Force-stopping...',
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
    'progress.interrupt': '⛔ Interrupt',
    'progress.interruptCute': '💥 Kill it!',
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
    'progress.cute.generateimage': '🎨 drawing a picture',
    'progress.cute.editimage': '🖌️ retouching a picture',
    'progress.cute.texttospeech': '🗣️ recording voice',
    'progress.cute.sendmedia': '📎 sending a file',
    'progress.cute.setreaction': '😊 reacting',
    'progress.cute.forwardmessage': '↗️ forwarding',
    'progress.cute.publishtelegraph': '📰 publishing an article',
    'progress.cute.sharefile': '📤 sharing a file',
    'progress.cute.gallery': '🖼️ browsing gallery',
    'progress.cute.backup': '💾 backing up',
    'progress.cute.sendemail': '📧 sending email',
    'progress.cute.savefact': '🧠 memorizing',
    'progress.cute.searchmemory': '🧠 remembering',
    'progress.cute.deletefact': '🧹 forgetting',
    'progress.cute.botmanage': '🤖 managing bots',
    'progress.cute.currencyrates': '💱 checking rates',
    'progress.cute.getcurrenttime': '🕐 checking time',
    'progress.cute.reminder': '⏰ setting reminder',
    'progress.cute.runpython': '🐍 running code',
    'progress.cute.askuser': '❓ asking a question',
    'progress.cute.takescreenshot': '📸 taking a screenshot',
    'progress.cute.namesession': '🏷️ naming session',
    'progress.cute.workspacefile': '📂 checking workspace',
    'progress.cute.default': '💫 doing magic',
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
    'progress.cute.interrupt': '💥 Kill it!',
    'progress.cute.bitrix24': '📋 checking CRM',
    'progress.cute.homeassistant': '🏠 controlling home',
    'progress.cute.stagehand': '🎭 controlling browser',
    'progress.cute.playwright': '🎭 controlling browser',
    'progress.cute.macoscontrol': '🖥️ controlling Mac',
    'progress.cute.googleworkspace': '📧 checking email',
    'progress.cute.metaads': '📣 running ads magic',
    'progress.cute.notion': '📔 flipping through notes',
    'progress.cute.pubmed': '🔬 reading science stuff',
    'progress.cute.medical': '💊 checking pills',
    'progress.cute.spacedome': '⛺ building a dome',
    'progress.cute.freecad': '📐 drawing shapes',
    'progress.cute.askgemini': '💎 asking Gemini bestie',
    'progress.cute.geminisearch': '💎 Gemini is googling',
    'progress.cute.miro': '🎨 drawing on the board',

    // Consolidation
    'consolidate.done': '🧠 Memory consolidation for {date} complete.',

    // Settings
    'cmd.settings.title': 'Settings',
    'settings.voice.on': '🟢 🗣 Voice',
    'settings.voice.off': '⚪ 🗣 Voice',
    'settings.stats.on': '🟢 📊 Stats',
    'settings.stats.off': '⚪ 📊 Stats',
    'settings.lang': '🌐 {label}',
    'settings.style': '🎨 {label}',
    'settings.delay': '⏱ {label}',
    'settings.team': '👥 {label}',
    'settings.close': 'Close',
    'settings.desc.voice': 'Reply with voice messages along with text',
    'settings.desc.stats': 'Show token count and cost after each reply',
    'settings.desc.lang': 'Bot interface language',
    'settings.desc.style': 'Progress indicator style: brunette (technical) or blonde (cute emoji)',
    'settings.desc.delay': 'How long progress stays visible after the final reply (0 = remove immediately, ∞ = keep forever)',
    'settings.desc.team': 'Show teammate work: all steps, result only, or hidden',
    'settings.facts.on': '🟢 🧠 Facts notify',
    'settings.facts.off': '⚪ 🧠 Facts notify',
    'settings.desc.facts': 'Show saved facts in chat (SaveFact notifications)',
    'settings.agent': '🤖 Agent: {label}',
    'settings.desc.agent': 'Agent mode: full (no limits), ask user (confirms before actions), plan (read-only)',
    'settings.voice_confirm.on': '🟢 🎤 Voice confirm',
    'settings.voice_confirm.off': '⚪ 🎤 Voice confirm',
    'settings.desc.voice_confirm': 'Confirm voice transcription before sending to AI',
    'voice.confirm.prompt': '🎤 Transcription:',
    'voice.confirm.ok': '✅ Confirmed',
    'voice.confirm.cancelled': '❌ Cancelled',
    'voice.confirm.btn.ok': '✅ Confirm',
    'voice.confirm.btn.cancel': '❌ Cancel',
    'cb.voiceExpired': 'Voice confirmation expired',
    'agent.full': 'FULL',
    'agent.ask': 'ASK USER',
    'agent.plan': 'PLAN',

    // Sessions
    'cmd.session.title': 'Sessions',
    'cmd.session.active': 'Active session',
    'cmd.session.none': 'No active session',
    'cmd.session.saved': 'Saved sessions:',
    'cmd.session.empty': 'No saved sessions.',
    'cmd.session.saved_ok': 'Session saved: {name}',
    'cmd.session.loaded': 'Session loaded: {name}',
    'cmd.session.deleted': 'Session deleted: {name}',
    'cmd.session.imported': 'CLI session imported. Send a message to continue.',
    'cmd.session.import_usage': 'Usage: /session import <session_id>',
    'cmd.session.cli': 'Resume in CLI:',
    'cmd.session.btn.save': '💾 Save',
    'cmd.session.btn.new': '🆕 New',
    'cmd.session.btn.import': '🔗 Import CLI',
    'cmd.session.btn.delete': '🗑',
    'cmd.session.auto_name': 'Session {n}',
    'cmd.session.ago.now': 'just now',
    'cmd.session.ago.min': '{n}m ago',
    'cmd.session.ago.hour': '{n}h ago',
    'cmd.session.ago.day': '{n}d ago',
    'cmd.session.first': 'First message',
    'cmd.session.last': 'Last message',
    'menu.session': 'Sessions (switch, save, import)',

    // Group debate
    'group.context.injected': '📌 Added to context',
    'group.context.resumed': '📌 Added to context. Debate resumed.',
    'group.iteration.limit': '🛑 Iteration limit ({max}). /stop to reset.',
    'group.thinking': '⏳ Got it. Thinking {sec}s...',
    'group.stop.already': '⏹ Already stopped.',
    'group.stop.done': '⏹ Debate stopped ({count} iterations).',
    'group.stop.done.short': '⏹ Debate stopped.',
    'group.pause.already': '⏸ Already paused.',
    'group.pause.done': '⏸ Debate paused. /resume or send a message to continue.',
    'group.resume.done': '▶️ Debate resumed.',
    'group.resume.stopped': '⏹ Debate was stopped via /stop. Send a new message to start a new debate.',
    'group.resume.notPaused': '▶️ Debate is not paused.',

    // Fact review
    'review.saved': '✅ <b>Saved</b>',
    'review.skipped': '❌ <b>Skipped</b>',
    'review.allDone': '✅ All facts reviewed!\n\n📊 +{approved} saved, {declined} skipped',
    'review.ownerOnly': '⛔ Owner only',
    'review.groupAdded': '✅ Group added',
    'review.groupAllowed': '✅ <b>Allowed</b>',
    'review.groupDenied': '❌ Denied, bot left',
    'review.groupDeniedLabel': '❌ <b>Denied</b>',
    'review.noFacts': '📋 No facts to review.\n\n📊 Total: {approved} saved, {declined} skipped',
    'review.found': '📋 Found {pending} new facts from recordings. Starting review:',
    'review.type.fact': 'Fact',
    'review.type.decision': 'Decision',
    'review.type.task': 'Task',
    'review.fromRecording': 'from recording',
    'review.btn.save': '✅ Save',
    'review.btn.skip': '❌ Skip',
    'review.btn.later': '⏭ Later',

    // Restart / Update
    'cmd.restart': '🔄 Restarting in 5s...',
    'cmd.update.start': '🔄 Updating...\n\n`git pull --ff-only`...',
    'cmd.update.upToDate': '✅ Already up to date.',
    'cmd.update.building': '🔄 Updating...\n\n`git pull` ✓\n`deploy.sh build`...',
    'cmd.update.done': '✅ Updated!\n\n```\n{result}\n```\n\nRestarting...',
    'cmd.update.failed': '❌ Update failed:\n\n```\n{error}\n```',

    // Scheduler
    'sched.running': '⏰ Running scheduled task: {prompt}...',
    'sched.retry': '⚠️ Task crashed, retrying...',
    'sched.result': '📋 Task result:\n\n{result}',
    'sched.failed': 'Task failed: {error}',

    // Colleague
    'colleague.noReply': 'No reply',

    // Bot commands menu
    'menu.start': 'Start',
    'menu.new': 'New session (clear context)',
    'menu.cancel': 'Cancel current request',
    'menu.model': 'Switch AI model',
    'menu.usage': 'Usage stats',
    'menu.settings': 'Settings',
    'menu.admin': 'Start/stop admin panel',
    'menu.restart': 'Restart bot',
    'menu.update': 'Update (git pull + build + restart)',
    'menu.review': 'Review facts from room recordings',
  },

  uk: {
    // Auth
    'auth.denied': 'Немає доступу. Твій chat ID: {chatId}',
    'auth.noReply': '(без відповіді)',

    // Agent errors
    'agent.crash': '⚠️ Процес Claude впав (exit code 1). Спробуй ще раз або /new для нової сесії.',
    'agent.crash.partial': '⚠️ Процес перервався. Часткова відповідь вище.',
    'agent.crash.double': '⚠️ Процес Claude впав двічі. Спробуй /new для чистої сесії, або пізніше.',
    'agent.error': '⚠️ Помилка агента:',

    // Start / Help
    'cmd.start': "BotVa на зв'язку.\n\nТвій chat ID: <code>{chatId}</code>\n\n/new -- нова сесія\n/cancel -- скасувати поточний запит\n/model -- змінити модель AI\n/usage -- статистика використання\n/settings -- голос, мова, стиль та інше\n/session -- перемикання сесій, імпорт з CLI\n/admin -- адмін панель",
    'cmd.chatid': 'Твій chat ID: <code>{chatId}</code>',

    // Session
    'cmd.newchat': 'Сесію очищено. Починаємо з нуля.',

    // Cancel
    'cancel.request': 'запит скасовано',
    'cancel.queue': '{n} в черзі очищено',
    'cancel.nothing': 'Нічого скасовувати.',

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
    'cmd.usage.authOk': 'автентифікований',
    'cmd.usage.authExpired': 'не автентифікований',

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
    'model.opus-1m': 'Найпотужніший, 1M контекст',
    'model.opus': 'Найпотужніший, 200k контекст',
    'model.sonnet-1m': 'Збалансований, 1M контекст',
    'model.sonnet': 'Збалансований, 200k контекст',
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
    'style.brunette.label': '👩🏻‍⚕️ Брюнетка',
    'style.blonde': 'милий стиль',
    'style.blonde.label': '👩 Блондинка',

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
    'cb.interrupting': 'Вбиваю процес...',
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
    'progress.stopCute': '🛑 Стопе!',
    'progress.interrupt': '⛔ Перервати',
    'progress.interruptCute': '💥 Ну стопе!',
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
    'progress.cute.generateimage': '🎨 малюємо картиночку',
    'progress.cute.editimage': '🖌️ підмальовуємо',
    'progress.cute.texttospeech': '🗣️ записуємо голос',
    'progress.cute.sendmedia': '📎 надсилаємо файлик',
    'progress.cute.setreaction': '😊 реагуємо',
    'progress.cute.forwardmessage': '↗️ пересилаємо',
    'progress.cute.publishtelegraph': '📰 публікуємо статтю',
    'progress.cute.sharefile': '📤 ділимось файликом',
    'progress.cute.gallery': '🖼️ гортаємо галерею',
    'progress.cute.backup': '💾 робимо бекапчик',
    'progress.cute.sendemail': '📧 відправляємо листик',
    'progress.cute.savefact': '🧠 запам\'ятовуємо',
    'progress.cute.searchmemory': '🧠 згадуємо',
    'progress.cute.deletefact': '🧹 забуваємо',
    'progress.cute.botmanage': '🤖 керуємо ботиками',
    'progress.cute.currencyrates': '💱 дивимось курси',
    'progress.cute.getcurrenttime': '🕐 дивимось час',
    'progress.cute.reminder': '⏰ ставимо нагадування',
    'progress.cute.runpython': '🐍 запускаємо код',
    'progress.cute.askuser': '❓ питаємо',
    'progress.cute.takescreenshot': '📸 робимо скріншот',
    'progress.cute.namesession': '🏷️ називаємо сесію',
    'progress.cute.workspacefile': '📂 дивимось workspace',
    'progress.cute.default': '💫 робимо магію',
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
    'progress.cute.interrupt': '💥 Ну стапе!',
    'progress.cute.bitrix24': '📋 дивимось CRM',
    'progress.cute.homeassistant': '🏠 керуємо будинком',
    'progress.cute.stagehand': '🎭 керуємо браузером',
    'progress.cute.playwright': '🎭 керуємо браузером',
    'progress.cute.macoscontrol': '🖥️ керуємо маком',
    'progress.cute.googleworkspace': '📧 дивимось пошту',
    'progress.cute.metaads': '📣 крутимо рекламку',
    'progress.cute.notion': '📔 гортаємо нотатки',
    'progress.cute.pubmed': '🔬 читаємо наукове',
    'progress.cute.medical': '💊 дивимось пігулочки',
    'progress.cute.spacedome': '⛺ будуємо купол',
    'progress.cute.freecad': '📐 малюємо фігурки',
    'progress.cute.askgemini': '💎 питаємо Джемінічку',
    'progress.cute.geminisearch': '💎 Джемінічка гуглить',
    'progress.cute.miro': '🎨 малюємо на дошці',

    // Consolidation
    'consolidate.done': '🧠 Консолідація пам\'яті за {date} завершена.',

    // Settings
    'cmd.settings.title': 'Налаштування',
    'settings.voice.on': '🟢 🗣 Голос',
    'settings.voice.off': '⚪ 🗣 Голос',
    'settings.stats.on': '🟢 📊 Статистика',
    'settings.stats.off': '⚪ 📊 Статистика',
    'settings.lang': '🌐 {label}',
    'settings.style': '🎨 {label}',
    'settings.delay': '⏱ {label}',
    'settings.team': '👥 {label}',
    'settings.close': 'Закрити',
    'settings.desc.voice': 'Відповідати голосовими повідомленнями разом з текстом',
    'settings.desc.stats': 'Показувати кількість токенів та вартість після кожної відповіді',
    'settings.desc.lang': 'Мова інтерфейсу бота',
    'settings.desc.style': 'Стиль індикатора прогресу: brunette (технічний) або blonde (милі емодзі)',
    'settings.desc.delay': 'Скільки прогрес видно після фінальної відповіді (0 = прибрати одразу, ∞ = залишити)',
    'settings.desc.team': 'Показ роботи команди: всі кроки, тільки результат або приховано',
    'settings.facts.on': '🟢 🧠 Факти',
    'settings.facts.off': '⚪ 🧠 Факти',
    'settings.desc.facts': 'Показувати збережені факти в чаті (нотифікації SaveFact)',
    'settings.agent': '🤖 Агент: {label}',
    'settings.desc.agent': 'Режим агента: повний (без обмежень), запит (підтверджує дії), план (тільки читання)',
    'settings.voice_confirm.on': '🟢 🎤 Підтв. голосу',
    'settings.voice_confirm.off': '⚪ 🎤 Підтв. голосу',
    'settings.desc.voice_confirm': 'Підтверджувати транскрипцію голосового перед відправкою в AI',
    'voice.confirm.prompt': '🎤 Транскрипція:',
    'voice.confirm.ok': '✅ Підтверджено',
    'voice.confirm.cancelled': '❌ Скасовано',
    'voice.confirm.btn.ok': '✅ Підтвердити',
    'voice.confirm.btn.cancel': '❌ Скасувати',
    'cb.voiceExpired': 'Підтвердження голосового застаріло',
    'agent.full': 'ПОВНИЙ',
    'agent.ask': 'ЗАПИТ',
    'agent.plan': 'ПЛАН',

    // Sessions
    'cmd.session.title': 'Сесії',
    'cmd.session.active': 'Активна сесія',
    'cmd.session.none': 'Немає активної сесії',
    'cmd.session.saved': 'Збережені сесії:',
    'cmd.session.empty': 'Збережених сесій немає.',
    'cmd.session.saved_ok': 'Сесію збережено: {name}',
    'cmd.session.loaded': 'Сесію завантажено: {name}',
    'cmd.session.deleted': 'Сесію видалено: {name}',
    'cmd.session.imported': 'CLI сесію імпортовано. Надішли повідомлення щоб продовжити.',
    'cmd.session.import_usage': 'Використання: /session import <session_id>',
    'cmd.session.cli': 'Продовжити в CLI:',
    'cmd.session.btn.save': '💾 Зберегти',
    'cmd.session.btn.new': '🆕 Нова',
    'cmd.session.btn.import': '🔗 Імпорт CLI',
    'cmd.session.btn.delete': '🗑',
    'cmd.session.auto_name': 'Сесія {n}',
    'cmd.session.ago.now': 'щойно',
    'cmd.session.ago.min': '{n}хв тому',
    'cmd.session.ago.hour': '{n}год тому',
    'cmd.session.ago.day': '{n}д тому',
    'cmd.session.first': 'Перше повідомлення',
    'cmd.session.last': 'Останнє повідомлення',
    'menu.session': 'Сесії (перемикання, збереження, імпорт)',

    // Group debate
    'group.context.injected': '📌 Додано до контексту',
    'group.context.resumed': '📌 Додано до контексту. Діалог відновлено.',
    'group.iteration.limit': '🛑 Ліміт ітерацій ({max}). /stop для reset.',
    'group.thinking': '⏳ Прийняв. Думаю {sec}с...',
    'group.stop.already': '⏹ Вже зупинено.',
    'group.stop.done': '⏹ Діалог зупинено (було {count} ітерацій).',
    'group.stop.done.short': '⏹ Діалог зупинено.',
    'group.pause.already': '⏸ Вже призупинено.',
    'group.pause.done': '⏸ Діалог на паузі. /resume або нове повідомлення щоб продовжити.',
    'group.resume.done': '▶️ Діалог відновлено.',
    'group.resume.stopped': '⏹ Діалог був зупинений через /stop. Надішли нове повідомлення для нового діалогу.',
    'group.resume.notPaused': '▶️ Діалог не на паузі.',

    // Fact review
    'review.saved': '✅ <b>Збережено</b>',
    'review.skipped': '❌ <b>Пропущено</b>',
    'review.allDone': '✅ Всі факти переглянуто!\n\n📊 +{approved} збережено, {declined} пропущено',
    'review.ownerOnly': '⛔ Тільки власник',
    'review.groupAdded': '✅ Групу додано',
    'review.groupAllowed': '✅ <b>Дозволено</b>',
    'review.groupDenied': '❌ Відхилено, бот вийшов',
    'review.groupDeniedLabel': '❌ <b>Відхилено</b>',
    'review.noFacts': '📋 Немає фактів для перегляду.\n\n📊 Всього: {approved} збережено, {declined} пропущено',
    'review.found': '📋 Знайдено {pending} нових фактів із записів. Починаємо перегляд:',
    'review.type.fact': 'Факт',
    'review.type.decision': 'Рішення',
    'review.type.task': 'Задача',
    'review.fromRecording': 'із запису',
    'review.btn.save': '✅ Зберегти',
    'review.btn.skip': '❌ Пропустити',
    'review.btn.later': '⏭ Потім',

    // Restart / Update
    'cmd.restart': '🔄 Перезапуск через 5с...',
    'cmd.update.start': '🔄 Оновлення...\n\n`git pull --ff-only`...',
    'cmd.update.upToDate': '✅ Вже актуальна версія.',
    'cmd.update.building': '🔄 Оновлення...\n\n`git pull` ✓\n`deploy.sh build`...',
    'cmd.update.done': '✅ Оновлено!\n\n```\n{result}\n```\n\nПерезапуск...',
    'cmd.update.failed': '❌ Помилка оновлення:\n\n```\n{error}\n```',

    // Scheduler
    'sched.running': '⏰ Виконую заплановану задачу: {prompt}...',
    'sched.retry': '⚠️ Задача впала, повторюю...',
    'sched.result': '📋 Результат задачі:\n\n{result}',
    'sched.failed': 'Задача не виконана: {error}',

    // Colleague
    'colleague.noReply': 'Немає відповіді',

    // Bot commands menu
    'menu.start': 'Почати роботу',
    'menu.new': 'Нова сесія (очистити контекст)',
    'menu.cancel': 'Скасувати поточний запит',
    'menu.model': 'Змінити модель AI',
    'menu.usage': 'Статистика використання',
    'menu.settings': 'Налаштування',
    'menu.admin': 'Запустити/зупинити адмін панель',
    'menu.restart': 'Перезапустити бота',
    'menu.update': 'Оновити (git pull + build + restart)',
    'menu.review': 'Переглянути факти із записів',
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
