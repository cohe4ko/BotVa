import { Hono } from 'hono'
import { html } from 'hono/html'
import { layout, botNav, icon } from '../views/layout.js'
import { formatCost, formatTs } from '../views/components.js'
import { getUsageSummary, getUsageDaily, getUsageRows } from '../db-multi.js'
import { validateBot, botName } from '../bot-middleware.js'

const app = new Hono()

app.get('/bot/:name/usage', validateBot, (c) => {
  const name = botName(c)
  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0)
  const todayTs = Math.floor(todayStart.getTime() / 1000)

  let today = { requests: 0, costUSD: 0, inputTokens: 0, outputTokens: 0 }
  let week = { requests: 0, costUSD: 0, inputTokens: 0, outputTokens: 0 }
  let month = { requests: 0, costUSD: 0, inputTokens: 0, outputTokens: 0 }
  let recent: ReturnType<typeof getUsageRows> = []
  try {
    today = getUsageSummary(name, todayTs)
    week = getUsageSummary(name, todayTs - 7 * 86400)
    month = getUsageSummary(name, todayTs - 30 * 86400)
    recent = getUsageRows(name, 20)
  } catch { /* db may not exist */ }

  const content = html`
    ${botNav(name, 'usage')}
    <h3>${icon('bar-chart-3')} Claude Usage</h3>

    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-label">${icon('calendar', 12)} Today</div>
        <div class="stat-number">${formatCost(today.costUSD)}</div>
        <small>${today.requests} requests &middot; ${(today.inputTokens / 1000).toFixed(1)}K in / ${(today.outputTokens / 1000).toFixed(1)}K out</small>
      </div>
      <div class="stat-card">
        <div class="stat-label">${icon('calendar', 12)} 7 days</div>
        <div class="stat-number">${formatCost(week.costUSD)}</div>
        <small>${week.requests} requests</small>
      </div>
      <div class="stat-card">
        <div class="stat-label">${icon('calendar', 12)} 30 days</div>
        <div class="stat-number">${formatCost(month.costUSD)}</div>
        <small>${month.requests} requests</small>
      </div>
    </div>

    <h4>Daily cost (30 days)</h4>
    <canvas id="usage-chart" style="max-height:250px"></canvas>

    <h4>Recent requests</h4>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Time</th><th>Chat</th><th>Input</th><th>Output</th><th>Cache</th><th>Cost</th></tr></thead>
        <tbody>
          ${recent.map(r => html`<tr>
            <td class="ts-cell">${formatTs(r.created_at)}</td>
            <td><small>${r.chat_id}</small></td>
            <td>${r.input_tokens.toLocaleString()}</td>
            <td>${r.output_tokens.toLocaleString()}</td>
            <td>${r.cache_read_tokens.toLocaleString()}</td>
            <td>${formatCost(r.cost_usd)}</td>
          </tr>`)}
        </tbody>
      </table>
    </div>

    <script src="https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js"></script>
    <script>
      fetch('/bot/${name}/usage/data').then(r=>r.json()).then(data=>{
        new Chart(document.getElementById('usage-chart'),{type:'bar',data:{labels:data.map(d=>d.date),datasets:[{label:'Cost (USD)',data:data.map(d=>d.cost),backgroundColor:'rgba(74,158,255,0.6)',borderColor:'rgba(74,158,255,1)',borderWidth:1}]},options:{responsive:true,scales:{y:{beginAtZero:true}}}})
      })
    </script>
  `
  return c.html(layout(`${name} Usage`, content, `/bot/${name}`))
})

app.get('/bot/:name/usage/data', validateBot, (c) => {
  let daily: ReturnType<typeof getUsageDaily> = []
  try { daily = getUsageDaily(botName(c), 30) } catch { /* db may not exist */ }
  return c.json(daily)
})

export default app
