import { Hono } from 'hono'
import { html } from 'hono/html'
import { layout, botNav, icon } from '../views/layout.js'
import { formatCost, formatTs, truncate } from '../views/components.js'
import { getImagenSummary, getImagenRows, getImagenDaily } from '../db-multi.js'
import { imageTokenCost } from '../../pricing.js'
import { validateBot, botName } from '../bot-middleware.js'
import type { TFunc, Lang, I18nEnv } from '../i18n.js'

const app = new Hono<I18nEnv>()

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

app.get('/bot/:name/images', validateBot, (c) => {
  const t: TFunc = c.get('t')
  const lang: Lang = c.get('lang')
  const name = botName(c)
  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0)
  const todayTs = Math.floor(todayStart.getTime() / 1000)

  const emptyImagen = { total: 0, generates: 0, edits: 0, inputTokens: 0, outputTokens: 0, totalImageBytes: 0, estimatedCostUSD: 0 }
  let imgToday = emptyImagen, imgWeek = emptyImagen, imgMonth = emptyImagen
  let imgRecent: ReturnType<typeof getImagenRows> = []
  try {
    imgToday = getImagenSummary(name, todayTs)
    imgWeek = getImagenSummary(name, todayTs - 7 * 86400)
    imgMonth = getImagenSummary(name, todayTs - 30 * 86400)
    imgRecent = getImagenRows(name, 30)
  } catch { /* table may not exist */ }

  const content = html`
    ${botNav(name, 'images', t)}
    <h3>${icon('image')} ${t('img.title')}</h3>

    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-label">${icon('calendar', 12)} ${t('img.today')}</div>
        <div class="stat-number">${imgToday.total}</div>
        <small>${imgToday.generates} gen / ${imgToday.edits} edit &middot; ${formatCost(imgToday.estimatedCostUSD)}</small>
      </div>
      <div class="stat-card">
        <div class="stat-label">${icon('calendar', 12)} ${t('img.7days')}</div>
        <div class="stat-number">${imgWeek.total}</div>
        <small>${formatBytes(imgWeek.totalImageBytes)} &middot; ${formatCost(imgWeek.estimatedCostUSD)}</small>
      </div>
      <div class="stat-card">
        <div class="stat-label">${icon('calendar', 12)} ${t('img.30days')}</div>
        <div class="stat-number">${imgMonth.total}</div>
        <small>${formatBytes(imgMonth.totalImageBytes)} &middot; ${formatCost(imgMonth.estimatedCostUSD)}</small>
      </div>
    </div>

    <h4>${t('img.dailyImages')}</h4>
    <canvas id="imagen-chart" style="max-height:250px"></canvas>

    ${imgRecent.length > 0 ? html`
      <h4>${t('img.recentGen')}</h4>
      <div class="table-wrap">
        <table>
          <thead><tr><th>${t('img.time')}</th><th>${t('img.type')}</th><th>${t('img.prompt')}</th><th class="hide-mobile">${t('img.tokens')}</th><th class="hide-mobile">${t('img.size')}</th><th>${t('img.estCost')}</th></tr></thead>
          <tbody>
            ${imgRecent.map(r => html`<tr>
              <td class="ts-cell">${formatTs(r.created_at)}</td>
              <td><span class="badge badge-${r.type === 'generate' ? 'set' : 'optional'}">${r.type}</span></td>
              <td class="detail-cell">${truncate(r.prompt, 60)}</td>
              <td class="hide-mobile">${r.input_tokens.toLocaleString()} / ${r.output_tokens.toLocaleString()}</td>
              <td class="hide-mobile">${formatBytes(r.image_bytes)}</td>
              <td>${formatCost(imageTokenCost(r.output_tokens))}</td>
            </tr>`)}
          </tbody>
        </table>
      </div>
    ` : html`
      <div class="empty-state">
        <div class="empty-icon"><i data-lucide="image-off" style="width:32px;height:32px"></i></div>
        <p>${t('img.noImages')}</p>
      </div>
    `}

    <script src="https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js"></script>
    <script>
      fetch('/bot/${name}/images/data').then(r=>r.json()).then(data=>{
        if(data.length===0) return
        new Chart(document.getElementById('imagen-chart'),{type:'bar',data:{labels:data.map(d=>d.date),datasets:[{label:'${t('img.chartImages')}',data:data.map(d=>d.count),backgroundColor:'rgba(255,159,64,0.6)',borderColor:'rgba(255,159,64,1)',borderWidth:1},{label:'${t('img.chartCost')}',data:data.map(d=>d.cost),backgroundColor:'rgba(255,99,132,0.4)',borderColor:'rgba(255,99,132,1)',borderWidth:1,yAxisID:'y1'}]},options:{responsive:true,scales:{y:{beginAtZero:true,position:'left'},y1:{beginAtZero:true,position:'right',grid:{drawOnChartArea:false}}}}})
      })
    </script>
  `
  return c.html(layout(`${name} ${t('botnav.images')}`, content, `/bot/${name}/images`, t, lang))
})

app.get('/bot/:name/images/data', validateBot, (c) => {
  let daily: ReturnType<typeof getImagenDaily> = []
  try { daily = getImagenDaily(botName(c), 30) } catch { /* table may not exist */ }
  return c.json(daily)
})

export default app
