import { Hono } from 'hono'
import { html } from 'hono/html'
import { randomUUID } from 'crypto'
import { layout, botNav } from '../views/layout.js'
import { alert, formatTs, taskStatusBadge, truncate } from '../views/components.js'
import { getTasks, createTask, deleteTask, pauseTask, resumeTask } from '../db-multi.js'
import { validateBot, botName } from '../bot-middleware.js'
import type { TFunc, Lang, I18nEnv } from '../i18n.js'

const app = new Hono<I18nEnv>()

app.get('/bot/:name/tasks', validateBot, (c) => {
  const t: TFunc = c.get('t')
  const lang: Lang = c.get('lang')
  const name = botName(c)
  let tasks: ReturnType<typeof getTasks> = []
  try { tasks = getTasks(name) } catch { /* db may not exist */ }

  const content = html`
    ${botNav(name, 'tasks', t)}
    <h3>${t('tasks.title')} <small>(${tasks.length})</small></h3>
    <div id="task-alerts"></div>
    <details>
      <summary>${t('tasks.createNew')}</summary>
      <form hx-post="/bot/${name}/tasks" hx-target="#task-alerts" hx-swap="innerHTML">
        <label>${t('tasks.chatId')}<input type="text" name="chat_id" required placeholder="${t('tasks.chatIdPlaceholder')}"></label>
        <label>${t('tasks.prompt')}<textarea name="prompt" rows="3" required placeholder="${t('tasks.promptPlaceholder')}"></textarea></label>
        <label>${t('tasks.schedule')}<input type="text" name="schedule" required placeholder="${t('tasks.schedulePlaceholder')}"></label>
        <button type="submit">${t('tasks.create')}</button>
      </form>
    </details>
    <table>
      <thead><tr><th>${t('mem.id')}</th><th>${t('tasks.prompt')}</th><th>${t('tasks.schedule')}</th><th>${t('tasks.status')}</th><th>${t('tasks.nextRun')}</th><th>${t('tasks.lastRun')}</th><th></th></tr></thead>
      <tbody>
        ${tasks.map(task => html`
          <tr id="task-${task.id}">
            <td><small>${task.id.slice(0, 8)}</small></td>
            <td title="${task.prompt}">${truncate(task.prompt, 60)}</td>
            <td><code>${task.schedule}</code></td>
            <td>${taskStatusBadge(task.status)}</td>
            <td><small>${formatTs(task.next_run)}</small></td>
            <td><small>${task.last_run ? formatTs(task.last_run) : '—'}</small></td>
            <td><div class="btn-group">
              ${task.status === 'active'
                ? html`<button hx-post="/bot/${name}/tasks/${task.id}/pause" hx-target="#task-${task.id}" hx-swap="outerHTML" class="secondary outline" style="padding:0.2rem 0.5rem;font-size:0.8rem">${t('tasks.pause')}</button>`
                : html`<button hx-post="/bot/${name}/tasks/${task.id}/resume" hx-target="#task-${task.id}" hx-swap="outerHTML" class="outline" style="padding:0.2rem 0.5rem;font-size:0.8rem">${t('tasks.resume')}</button>`}
              <button hx-delete="/bot/${name}/tasks/${task.id}" hx-target="#task-${task.id}" hx-swap="outerHTML" hx-confirm="${t('tasks.deleteConfirm')}" class="secondary outline" style="padding:0.2rem 0.5rem;font-size:0.8rem">${t('mem.del')}</button>
            </div></td>
          </tr>
        `)}
        ${tasks.length === 0 ? html`<tr><td colspan="7">${t('tasks.noTasks')}</td></tr>` : ''}
      </tbody>
    </table>
  `
  return c.html(layout(`${name} ${t('botnav.tasks')}`, content, `/bot/${name}`, t, lang))
})

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

export default app
