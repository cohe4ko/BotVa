import { Hono } from 'hono'
import { html } from 'hono/html'
import { layout, botNav, icon } from '../views/layout.js'
import { formatCost, formatTs, truncate } from '../views/components.js'
import { getImagenSummary, getImagenRows, getImagenDaily } from '../db-multi.js'
import { validateBot, botName } from '../bot-middleware.js'

const app = new Hono()

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

app.get('/bot/:name/images', validateBot, (c) => {
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
    ${botNav(name, 'images')}
    <h3>${icon('image')} Image Generation</h3>

    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-label">${icon('calendar', 12)} Today</div>
        <div class="stat-number">${imgToday.total}</div>
        <small>${imgToday.generates} gen / ${imgToday.edits} edit &middot; ${formatCost(imgToday.estimatedCostUSD)}</small>
      </div>
      <div class="stat-card">
        <div class="stat-label">${icon('calendar', 12)} 7 days</div>
        <div class="stat-number">${imgWeek.total}</div>
        <small>${formatBytes(imgWeek.totalImageBytes)} &middot; ${formatCost(imgWeek.estimatedCostUSD)}</small>
      </div>
      <div class="stat-card">
        <div class="stat-label">${icon('calendar', 12)} 30 days</div>
        <div class="stat-number">${imgMonth.total}</div>
        <small>${formatBytes(imgMonth.totalImageBytes)} &middot; ${formatCost(imgMonth.estimatedCostUSD)}</small>
      </div>
    </div>

    <h4>Daily images (30 days)</h4>
    <canvas id="imagen-chart" style="max-height:250px"></canvas>

    ${imgRecent.length > 0 ? html`
      <h4>Recent generations</h4>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Time</th><th>Type</th><th>Prompt</th><th>Tokens</th><th>Size</th><th>~Cost</th></tr></thead>
          <tbody>
            ${imgRecent.map(r => html`<tr>
              <td class="ts-cell">${formatTs(r.created_at)}</td>
              <td><span class="badge badge-${r.type === 'generate' ? 'set' : 'optional'}">${r.type}</span></td>
              <td class="detail-cell">${truncate(r.prompt, 60)}</td>
              <td>${r.input_tokens.toLocaleString()} / ${r.output_tokens.toLocaleString()}</td>
              <td>${formatBytes(r.image_bytes)}</td>
              <td>${formatCost(0.039)}</td>
            </tr>`)}
          </tbody>
        </table>
      </div>
    ` : html`
      <div class="empty-state">
        <div class="empty-icon"><i data-lucide="image-off" style="width:32px;height:32px"></i></div>
        <p>No images generated yet</p>
      </div>
    `}

    <script src="https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js"></script>
    <script>
      fetch('/bot/${name}/images/data').then(r=>r.json()).then(data=>{
        if(data.length===0) return
        new Chart(document.getElementById('imagen-chart'),{type:'bar',data:{labels:data.map(d=>d.date),datasets:[{label:'Images',data:data.map(d=>d.count),backgroundColor:'rgba(255,159,64,0.6)',borderColor:'rgba(255,159,64,1)',borderWidth:1},{label:'Cost (USD)',data:data.map(d=>d.cost),backgroundColor:'rgba(255,99,132,0.4)',borderColor:'rgba(255,99,132,1)',borderWidth:1,yAxisID:'y1'}]},options:{responsive:true,scales:{y:{beginAtZero:true,position:'left'},y1:{beginAtZero:true,position:'right',grid:{drawOnChartArea:false}}}}})
      })
    </script>
  `
  return c.html(layout(`${name} Images`, content, `/bot/${name}`))
})

app.get('/bot/:name/images/data', validateBot, (c) => {
  let daily: ReturnType<typeof getImagenDaily> = []
  try { daily = getImagenDaily(botName(c), 30) } catch { /* table may not exist */ }
  return c.json(daily)
})

export default app
