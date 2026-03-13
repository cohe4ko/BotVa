import { Hono } from 'hono'
import { html } from 'hono/html'
import { layout, botNav, icon } from '../views/layout.js'
import { formatCost, formatTs } from '../views/components.js'
import { getUsageSummary, getUsageDaily, getUsageRows } from '../db-multi.js'
import { validateBot, botName } from '../bot-middleware.js'
import type { TFunc, Lang, I18nEnv } from '../i18n.js'

const app = new Hono<I18nEnv>()

app.get('/bot/:name/usage', validateBot, (c) => {
  const t: TFunc = c.get('t')
  const lang: Lang = c.get('lang')
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
    ${botNav(name, 'usage', t)}
    <h3>${icon('bar-chart-3')} ${t('usage.title')}</h3>

    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-label">${icon('calendar', 12)} ${t('usage.today')}</div>
        <div class="stat-number">${formatCost(today.costUSD)}</div>
        <small>${today.requests} ${t('usage.requests')} &middot; ${(today.inputTokens / 1000).toFixed(1)}K in / ${(today.outputTokens / 1000).toFixed(1)}K out</small>
      </div>
      <div class="stat-card">
        <div class="stat-label">${icon('calendar', 12)} ${t('usage.7days')}</div>
        <div class="stat-number">${formatCost(week.costUSD)}</div>
        <small>${week.requests} ${t('usage.requests')}</small>
      </div>
      <div class="stat-card">
        <div class="stat-label">${icon('calendar', 12)} ${t('usage.30days')}</div>
        <div class="stat-number">${formatCost(month.costUSD)}</div>
        <small>${month.requests} ${t('usage.requests')}</small>
      </div>
    </div>

    <h4>${t('usage.dailyCost')}</h4>
    <canvas id="usage-chart" style="max-height:250px"></canvas>

    <h4>${t('usage.recentRequests')}</h4>
    <div class="table-wrap">
      <table>
        <thead><tr><th>${t('usage.time')}</th><th>${t('usage.chat')}</th><th>${t('usage.input')}</th><th>${t('usage.output')}</th><th>${t('usage.cache')}</th><th>${t('usage.cost')}</th></tr></thead>
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
        new Chart(document.getElementById('usage-chart'),{type:'bar',data:{labels:data.map(d=>d.date),datasets:[{label:'${t('usage.chartLabel')}',data:data.map(d=>d.cost),backgroundColor:'rgba(74,158,255,0.6)',borderColor:'rgba(74,158,255,1)',borderWidth:1}]},options:{responsive:true,scales:{y:{beginAtZero:true}}}})
      })
    </script>
  `
  return c.html(layout(`${name} ${t('botnav.usage')}`, content, `/bot/${name}`, t, lang))
})

app.get('/bot/:name/usage/data', validateBot, (c) => {
  let daily: ReturnType<typeof getUsageDaily> = []
  try { daily = getUsageDaily(botName(c), 30) } catch { /* db may not exist */ }
  return c.json(daily)
})

export default app
