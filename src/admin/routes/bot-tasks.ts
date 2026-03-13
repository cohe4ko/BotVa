import { Hono } from 'hono'
import { html } from 'hono/html'
import { randomUUID } from 'crypto'
import { layout, botNav } from '../views/layout.js'
import { alert, formatTs, taskStatusBadge, truncate } from '../views/components.js'
import { getTasks, createTask, deleteTask, pauseTask, resumeTask } from '../db-multi.js'
import { validateBot, botName } from '../bot-middleware.js'

const app = new Hono()

app.get('/bot/:name/tasks', validateBot, (c) => {
  const name = botName(c)
  let tasks: ReturnType<typeof getTasks> = []
  try { tasks = getTasks(name) } catch { /* db may not exist */ }

  const content = html`
    ${botNav(name, 'tasks')}
    <h3>Scheduled Tasks <small>(${tasks.length})</small></h3>
    <div id="task-alerts"></div>
    <details>
      <summary>Create new task</summary>
      <form hx-post="/bot/${name}/tasks" hx-target="#task-alerts" hx-swap="innerHTML">
        <label>Chat ID<input type="text" name="chat_id" required placeholder="e.g. 123456789"></label>
        <label>Prompt<textarea name="prompt" rows="3" required placeholder="What should the bot do?"></textarea></label>
        <label>Schedule (cron)<input type="text" name="schedule" required placeholder="0 9 * * *"></label>
        <button type="submit">Create</button>
      </form>
    </details>
    <table>
      <thead><tr><th>ID</th><th>Prompt</th><th>Schedule</th><th>Status</th><th>Next run</th><th>Last run</th><th></th></tr></thead>
      <tbody>
        ${tasks.map(t => html`
          <tr id="task-${t.id}">
            <td><small>${t.id.slice(0, 8)}</small></td>
            <td title="${t.prompt}">${truncate(t.prompt, 60)}</td>
            <td><code>${t.schedule}</code></td>
            <td>${taskStatusBadge(t.status)}</td>
            <td><small>${formatTs(t.next_run)}</small></td>
            <td><small>${t.last_run ? formatTs(t.last_run) : '—'}</small></td>
            <td><div class="btn-group">
              ${t.status === 'active'
                ? html`<button hx-post="/bot/${name}/tasks/${t.id}/pause" hx-target="#task-${t.id}" hx-swap="outerHTML" class="secondary outline" style="padding:0.2rem 0.5rem;font-size:0.8rem">Pause</button>`
                : html`<button hx-post="/bot/${name}/tasks/${t.id}/resume" hx-target="#task-${t.id}" hx-swap="outerHTML" class="outline" style="padding:0.2rem 0.5rem;font-size:0.8rem">Resume</button>`}
              <button hx-delete="/bot/${name}/tasks/${t.id}" hx-target="#task-${t.id}" hx-swap="outerHTML" hx-confirm="Delete?" class="secondary outline" style="padding:0.2rem 0.5rem;font-size:0.8rem">Del</button>
            </div></td>
          </tr>
        `)}
        ${tasks.length === 0 ? html`<tr><td colspan="7">No tasks</td></tr>` : ''}
      </tbody>
    </table>
  `
  return c.html(layout(`${name} Tasks`, content, `/bot/${name}`))
})

app.post('/bot/:name/tasks', validateBot, async (c) => {
  const name = botName(c)
  const body = await c.req.parseBody()
  const chatId = String(body['chat_id'] ?? ''), prompt = String(body['prompt'] ?? ''), schedule = String(body['schedule'] ?? '')
  if (!chatId || !prompt || !schedule) return c.html(alert('error', 'All fields required'))
  try {
    const { parseExpression } = await import('cron-parser')
    const nextRun = Math.floor(parseExpression(schedule).next().getTime() / 1000)
    const id = randomUUID().slice(0, 8)
    createTask(name, id, chatId, prompt, schedule, nextRun)
    return c.html(alert('success', `Task created: ${id}. Reload to see it.`))
  } catch { return c.html(alert('error', `Invalid cron: ${schedule}`)) }
})

app.delete('/bot/:name/tasks/:id', validateBot, (c) => { deleteTask(botName(c), c.req.param('id')!); return c.html(html``) })
app.post('/bot/:name/tasks/:id/pause', validateBot, (c) => { pauseTask(botName(c), c.req.param('id')!); return c.redirect(`/bot/${botName(c)}/tasks`) })
app.post('/bot/:name/tasks/:id/resume', validateBot, (c) => { resumeTask(botName(c), c.req.param('id')!); return c.redirect(`/bot/${botName(c)}/tasks`) })

export default app
