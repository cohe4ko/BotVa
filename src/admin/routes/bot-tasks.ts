import { Hono } from 'hono'
import { html } from 'hono/html'
import { randomUUID } from 'crypto'
import { layout, botNav } from '../views/layout.js'
import { alert, formatTs, taskStatusBadge, truncate } from '../views/components.js'
import { getTasks, getTask, createTask, updateTask, deleteTask, pauseTask, resumeTask, getReminders, createReminder, updateReminder, deleteReminder } from '../db-multi.js'
import { validateBot, botName } from '../bot-middleware.js'
import type { TFunc, Lang, I18nEnv } from '../i18n.js'

const app = new Hono<I18nEnv>()

app.get('/bot/:name/tasks', validateBot, (c) => {
  const t: TFunc = c.get('t')
  const lang: Lang = c.get('lang')
  const name = botName(c)
  let tasks: ReturnType<typeof getTasks> = []
  try { tasks = getTasks(name) } catch { /* db may not exist */ }
  let reminders: ReturnType<typeof getReminders> = []
  try { reminders = getReminders(name, 'pending') } catch { /* table may not exist */ }

  const content = html`
    ${botNav(name, 'tasks', t)}

    <!-- Reminders section -->
    <div class="section-header">
      <h3 style="margin:0"><i data-lucide="bell" style="width:15px;height:15px;display:inline-block;vertical-align:middle"></i> ${t('tasks.reminders')}</h3>
      <small>${reminders.length} ${t('tasks.pending')}</small>
    </div>
    <div id="reminder-alerts"></div>
    <details style="margin-bottom:1rem">
      <summary><i data-lucide="plus" style="width:13px;height:13px;display:inline-block;vertical-align:middle"></i> ${t('tasks.newReminder')}</summary>
      <form hx-post="/bot/${name}/reminders" hx-target="#reminder-alerts" hx-swap="innerHTML">
        <label>${t('tasks.chatId')}<input type="text" name="chat_id" required placeholder="${t('tasks.chatIdPlaceholder')}"></label>
        <label style="margin-top:0.5rem">${t('tasks.text')}<textarea name="text" rows="3" required placeholder="${t('tasks.textPlaceholder')}"></textarea></label>
        <label style="margin-top:0.5rem">${t('tasks.when')}<input type="datetime-local" name="remind_at" required></label>
        <button type="submit" style="margin-top:0.75rem"><i data-lucide="plus" style="width:13px;height:13px;display:inline-block;vertical-align:middle"></i> ${t('tasks.create')}</button>
      </form>
    </details>
    ${reminders.length === 0
      ? html`<div class="empty-state" style="margin-bottom:2rem"><div class="empty-icon"><i data-lucide="bell-off" style="width:32px;height:32px"></i></div><p>${t('tasks.noPending')}</p></div>`
      : html`
        <div class="table-wrap" style="margin-bottom:2rem">
          <table>
            <thead><tr><th style="width:50px">ID</th><th>${t('tasks.text')}</th><th style="width:140px">${t('tasks.when')}</th><th style="width:140px" class="hide-mobile">${t('common.created')}</th><th style="width:90px"></th></tr></thead>
            <tbody>
              ${reminders.map(r => {
                const d = new Date(r.remind_at * 1000)
                const pad = (n: number) => String(n).padStart(2, '0')
                const remindLocal = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
                return html`
                <tr id="reminder-${r.id}">
                  <td><small>#${r.id}</small></td>
                  <td style="font-size:0.78rem">${truncate(r.text, 80)}</td>
                  <td class="ts-cell">${formatTs(r.remind_at)}</td>
                  <td class="ts-cell hide-mobile">${formatTs(r.created_at)}</td>
                  <td><div class="btn-group">
                    <button type="button" onclick="document.getElementById('reminder-edit-${r.id}').toggleAttribute('hidden')" class="outline btn-sm" title="${t('tasks.edit')}"><i data-lucide="pencil" style="width:12px;height:12px;display:inline-block;vertical-align:middle"></i></button>
                    <button hx-delete="/bot/${name}/reminders/${r.id}" hx-target="#reminder-${r.id}" hx-swap="outerHTML" hx-confirm="${t('tasks.reminderDeleteConfirm')}" class="danger btn-sm"><i data-lucide="trash-2" style="width:12px;height:12px;display:inline-block;vertical-align:middle"></i></button>
                  </div></td>
                </tr>
                <tr hidden id="reminder-edit-${r.id}">
                  <td colspan="5" style="padding:0.75rem 1rem;background:var(--mc-bg-dim,#f8f9fa)">
                    <form hx-put="/bot/${name}/reminders/${r.id}" hx-target="#reminder-alerts" hx-swap="innerHTML">
                      <label>${t('tasks.chatId')}<input type="text" name="chat_id" value="${r.chat_id}" required></label>
                      <label style="margin-top:0.5rem">${t('tasks.text')}<textarea name="text" rows="3" required>${r.text}</textarea></label>
                      <label style="margin-top:0.5rem">${t('tasks.when')}<input type="datetime-local" name="remind_at" value="${remindLocal}" required></label>
                      <div class="btn-group" style="margin-top:0.5rem">
                        <button type="submit"><i data-lucide="save" style="width:13px;height:13px;display:inline-block;vertical-align:middle"></i> ${t('tasks.update')}</button>
                        <button type="button" class="outline" onclick="document.getElementById('reminder-edit-${r.id}').setAttribute('hidden','')"><i data-lucide="x" style="width:13px;height:13px;display:inline-block;vertical-align:middle"></i> ${t('common.cancel')}</button>
                      </div>
                    </form>
                  </td>
                </tr>
              `})}
            </tbody>
          </table>
        </div>
      `
    }

    <!-- Cron Tasks section -->
    <div class="section-header">
      <h3 style="margin:0"><i data-lucide="clock" style="width:15px;height:15px;display:inline-block;vertical-align:middle"></i> ${t('tasks.cronTasks')}</h3>
      <small>${tasks.length} ${tasks.length === 1 ? t('tasks.task') : t('tasks.tasks')}</small>
    </div>
    <div id="task-alerts"></div>
    <details style="margin-bottom:1rem">
      <summary><i data-lucide="plus" style="width:13px;height:13px;display:inline-block;vertical-align:middle"></i> ${t('tasks.createNew')}</summary>
      <form hx-post="/bot/${name}/tasks" hx-target="#task-alerts" hx-swap="innerHTML">
        <label>${t('tasks.chatId')}<input type="text" name="chat_id" required placeholder="${t('tasks.chatIdPlaceholder')}"></label>
        <label style="margin-top:0.5rem">${t('tasks.prompt')}<textarea name="prompt" rows="3" required placeholder="${t('tasks.promptPlaceholder')}"></textarea></label>
        <label style="margin-top:0.5rem">${t('tasks.schedule')}<input type="text" name="schedule" required placeholder="${t('tasks.schedulePlaceholder')}"></label>
        <button type="submit" style="margin-top:0.75rem"><i data-lucide="plus" style="width:13px;height:13px;display:inline-block;vertical-align:middle"></i> ${t('tasks.create')}</button>
      </form>
    </details>
    ${tasks.length === 0
      ? html`<div class="empty-state"><div class="empty-icon"><i data-lucide="clock" style="width:32px;height:32px"></i></div><p>${t('tasks.noTasks')}</p></div>`
      : html`
        <div class="table-wrap">
          <table>
            <thead><tr><th style="width:60px" class="hide-mobile">${t('mem.id')}</th><th>${t('tasks.prompt')}</th><th style="width:100px">${t('tasks.schedule')}</th><th style="width:70px">${t('tasks.status')}</th><th style="width:140px">${t('tasks.nextRun')}</th><th style="width:140px" class="hide-mobile">${t('tasks.lastRun')}</th><th style="width:100px"></th></tr></thead>
            <tbody>
              ${tasks.map(task => {
                const isError = task.last_result?.startsWith('ERROR:') || task.last_result?.includes('{{agent.crash}}')
                const statusIcon = task.last_result ? (isError ? '\u2717' : '\u2713') : ''
                const statusClass = isError ? 'color:var(--mc-red,#e53935)' : 'color:var(--mc-green,#43a047)'
                return html`
                <tr id="task-${task.id}" style="cursor:pointer" onclick="this.nextElementSibling.toggleAttribute('hidden')">
                  <td class="hide-mobile"><small>${task.id.slice(0, 8)}</small></td>
                  <td title="${task.prompt}" style="font-size:0.78rem">${statusIcon ? html`<span style="${statusClass};font-weight:bold;margin-right:0.3rem">${statusIcon}</span>` : ''}${truncate(task.prompt, 60)}</td>
                  <td><code>${task.schedule}</code></td>
                  <td>${taskStatusBadge(task.status)}</td>
                  <td class="ts-cell">${formatTs(task.next_run)}</td>
                  <td class="ts-cell hide-mobile">${task.last_run ? formatTs(task.last_run) : '\u2014'}</td>
                  <td><div class="btn-group" onclick="event.stopPropagation()">
                    <button onclick="event.stopPropagation();this.closest('tr').nextElementSibling.nextElementSibling.toggleAttribute('hidden')" class="outline btn-sm" title="${t('tasks.edit')}"><i data-lucide="pencil" style="width:12px;height:12px;display:inline-block;vertical-align:middle"></i></button>
                    ${task.status === 'active'
                      ? html`<button hx-post="/bot/${name}/tasks/${task.id}/pause" hx-target="#task-${task.id}" hx-swap="outerHTML" class="contrast outline btn-sm"><i data-lucide="pause" style="width:12px;height:12px;display:inline-block;vertical-align:middle"></i></button>`
                      : html`<button hx-post="/bot/${name}/tasks/${task.id}/resume" hx-target="#task-${task.id}" hx-swap="outerHTML" class="outline btn-sm"><i data-lucide="play" style="width:12px;height:12px;display:inline-block;vertical-align:middle"></i></button>`}
                    <button hx-delete="/bot/${name}/tasks/${task.id}" hx-target="#task-${task.id}" hx-swap="outerHTML" hx-confirm="${t('tasks.deleteConfirm')}" class="danger btn-sm"><i data-lucide="trash-2" style="width:12px;height:12px;display:inline-block;vertical-align:middle"></i></button>
                  </div></td>
                </tr>
                <tr hidden>
                  <td colspan="7" style="padding:0.5rem 1rem;background:var(--mc-bg-dim,#f8f9fa);font-size:0.78rem">
                    <strong>${t('tasks.lastResult')}:</strong>
                    <pre style="white-space:pre-wrap;word-break:break-word;margin:0.25rem 0 0;max-height:200px;overflow:auto;font-size:0.75rem">${task.last_result ?? '\u2014'}</pre>
                  </td>
                </tr>
                <tr hidden id="edit-${task.id}">
                  <td colspan="7" style="padding:0.75rem 1rem;background:var(--mc-bg-dim,#f8f9fa)">
                    <form hx-put="/bot/${name}/tasks/${task.id}" hx-target="#task-alerts" hx-swap="innerHTML">
                      <label>${t('tasks.chatId')}<input type="text" name="chat_id" value="${task.chat_id}" required></label>
                      <label style="margin-top:0.5rem">${t('tasks.prompt')}<textarea name="prompt" rows="3">${task.prompt}</textarea></label>
                      <label style="margin-top:0.5rem">${t('tasks.schedule')}<input type="text" name="schedule" value="${task.schedule}"></label>
                      <div class="btn-group" style="margin-top:0.5rem">
                        <button type="submit"><i data-lucide="save" style="width:13px;height:13px;display:inline-block;vertical-align:middle"></i> ${t('tasks.update')}</button>
                        <button type="button" class="outline" onclick="this.closest('tr').setAttribute('hidden','')"><i data-lucide="x" style="width:13px;height:13px;display:inline-block;vertical-align:middle"></i> ${t('common.cancel')}</button>
                      </div>
                    </form>
                  </td>
                </tr>
              `})}
            </tbody>
          </table>
        </div>
      `
    }
  `
  return c.html(layout(`${name} ${t('botnav.tasks')}`, content, `/bot/${name}/tasks`, t, lang))
})

// --- Cron Tasks ---

app.post('/bot/:name/tasks', validateBot, async (c) => {
  const t: TFunc = c.get('t')
  const name = botName(c)
  const body = await c.req.parseBody()
  const chatId = String(body['chat_id'] ?? ''), prompt = String(body['prompt'] ?? ''), schedule = String(body['schedule'] ?? '')
  if (!chatId || !prompt || !schedule) return c.html(alert('error', t('tasks.allRequired')))
  try {
    const { parseExpression } = await import('cron-parser')
    const nextRun = Math.floor(parseExpression(schedule).next().getTime() / 1000)
    const id = randomUUID().slice(0, 8)
    createTask(name, id, chatId, prompt, schedule, nextRun)
    return c.html(alert('success', t('tasks.created', { id })))
  } catch { return c.html(alert('error', t('tasks.invalidCron', { schedule }))) }
})

app.delete('/bot/:name/tasks/:id', validateBot, (c) => { deleteTask(botName(c), c.req.param('id')!); return c.html(html``) })
app.post('/bot/:name/tasks/:id/pause', validateBot, (c) => { pauseTask(botName(c), c.req.param('id')!); return c.redirect(`/bot/${botName(c)}/tasks`) })
app.post('/bot/:name/tasks/:id/resume', validateBot, (c) => { resumeTask(botName(c), c.req.param('id')!); return c.redirect(`/bot/${botName(c)}/tasks`) })

// --- Reminders ---

app.put('/bot/:name/tasks/:id', validateBot, async (c) => {
  const t: TFunc = c.get('t')
  const name = botName(c)
  const id = c.req.param('id')!
  const body = await c.req.parseBody()
  const chatId = String(body['chat_id'] ?? '').trim()
  const prompt = String(body['prompt'] ?? '').trim()
  const schedule = String(body['schedule'] ?? '').trim()
  if (!chatId || !prompt || !schedule) return c.html(alert('error', t('tasks.allRequired')))
  try {
    const { parseExpression } = await import('cron-parser')
    const nextRun = Math.floor(parseExpression(schedule).next().getTime() / 1000)
    const updated = updateTask(name, id, chatId, prompt, schedule, nextRun)
    if (!updated) return c.html(alert('error', t('tasks.notFound')))
    return c.html(alert('success', t('tasks.updated', { id: id.slice(0, 8) })))
  } catch { return c.html(alert('error', t('tasks.invalidCron', { schedule }))) }
})

app.put('/bot/:name/reminders/:id', validateBot, async (c) => {
  const t: TFunc = c.get('t')
  const name = botName(c)
  const id = parseInt(c.req.param('id')!, 10)
  const body = await c.req.parseBody()
  const chatId = String(body['chat_id'] ?? '').trim()
  const text = String(body['text'] ?? '').trim()
  const remindAtStr = String(body['remind_at'] ?? '').trim()
  if (!chatId || !text || !remindAtStr) return c.html(alert('error', t('tasks.allFieldsRequired')))
  const remindAt = Math.floor(new Date(remindAtStr).getTime() / 1000)
  if (isNaN(remindAt) || remindAt <= 0) return c.html(alert('error', t('tasks.invalidDate')))
  try {
    const updated = updateReminder(name, id, chatId, text, remindAt)
    if (!updated) return c.html(alert('error', t('tasks.reminderNotFound')))
    return c.html(alert('success', t('tasks.reminderUpdated', { id: String(id) })))
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return c.html(alert('error', msg))
  }
})

app.post('/bot/:name/reminders', validateBot, async (c) => {
  const t: TFunc = c.get('t')
  const name = botName(c)
  const body = await c.req.parseBody()
  const chatId = String(body['chat_id'] ?? '').trim()
  const text = String(body['text'] ?? '').trim()
  const remindAtStr = String(body['remind_at'] ?? '').trim()
  if (!chatId || !text || !remindAtStr) return c.html(alert('error', t('tasks.allFieldsRequired')))
  const remindAt = Math.floor(new Date(remindAtStr).getTime() / 1000)
  if (isNaN(remindAt) || remindAt <= 0) return c.html(alert('error', t('tasks.invalidDate')))
  try {
    const id = createReminder(name, chatId, text, remindAt)
    return c.html(alert('success', t('tasks.reminderCreated', { id: String(id) })))
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return c.html(alert('error', msg))
  }
})

app.delete('/bot/:name/reminders/:id', validateBot, (c) => {
  deleteReminder(botName(c), parseInt(c.req.param('id')!, 10))
  return c.html(html``)
})

export default app
