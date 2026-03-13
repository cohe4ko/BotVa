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
    <div class="section-header">
      <h3 style="margin:0"><i data-lucide="clock" style="width:15px;height:15px;display:inline-block;vertical-align:middle"></i> ${t('tasks.title')}</h3>
      <small>${tasks.length} ${tasks.length === 1 ? 'task' : 'tasks'}</small>
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
            <thead><tr><th style="width:60px">${t('mem.id')}</th><th>${t('tasks.prompt')}</th><th style="width:100px">${t('tasks.schedule')}</th><th style="width:70px">${t('tasks.status')}</th><th style="width:140px">${t('tasks.nextRun')}</th><th style="width:140px">${t('tasks.lastRun')}</th><th style="width:100px"></th></tr></thead>
            <tbody>
              ${tasks.map(task => html`
                <tr id="task-${task.id}">
                  <td><small>${task.id.slice(0, 8)}</small></td>
                  <td title="${task.prompt}" style="font-size:0.78rem">${truncate(task.prompt, 60)}</td>
                  <td><code>${task.schedule}</code></td>
                  <td>${taskStatusBadge(task.status)}</td>
                  <td class="ts-cell">${formatTs(task.next_run)}</td>
                  <td class="ts-cell">${task.last_run ? formatTs(task.last_run) : '\u2014'}</td>
                  <td><div class="btn-group">
                    ${task.status === 'active'
                      ? html`<button hx-post="/bot/${name}/tasks/${task.id}/pause" hx-target="#task-${task.id}" hx-swap="outerHTML" class="contrast outline btn-sm"><i data-lucide="pause" style="width:12px;height:12px;display:inline-block;vertical-align:middle"></i></button>`
                      : html`<button hx-post="/bot/${name}/tasks/${task.id}/resume" hx-target="#task-${task.id}" hx-swap="outerHTML" class="outline btn-sm"><i data-lucide="play" style="width:12px;height:12px;display:inline-block;vertical-align:middle"></i></button>`}
                    <button hx-delete="/bot/${name}/tasks/${task.id}" hx-target="#task-${task.id}" hx-swap="outerHTML" hx-confirm="${t('tasks.deleteConfirm')}" class="danger btn-sm"><i data-lucide="trash-2" style="width:12px;height:12px;display:inline-block;vertical-align:middle"></i></button>
                  </div></td>
                </tr>
              `)}
            </tbody>
          </table>
        </div>
      `
    }
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
