import { Hono } from 'hono'
import { html } from 'hono/html'
import { layout, icon } from '../views/layout.js'
import { pagination, formatTs } from '../views/components.js'
import { getGalleryImages, countGalleryImages, getBotNames } from '../db-multi.js'

const PER_PAGE = 24

const app = new Hono()

app.get('/gallery', (c) => {
  const page = Math.max(1, parseInt(c.req.query('page') ?? '1', 10))
  const bot = c.req.query('bot') || undefined
  const total = countGalleryImages(bot)
  const totalPages = Math.ceil(total / PER_PAGE)
  const offset = (page - 1) * PER_PAGE
  const images = getGalleryImages(PER_PAGE, offset, bot)
  const bots = getBotNames()

  const baseUrl = bot ? `/gallery?bot=${bot}` : '/gallery'

  const content = html`
    <h2>${icon('image')} Gallery</h2>

    <div class="filter-bar">
      <label>Bot
        <select onchange="location.href='/gallery'+(this.value ? '?bot='+this.value : '')">
          <option value="">All bots</option>
          ${bots.map(b => html`<option value="${b}" ${b === bot ? 'selected' : ''}>${b}</option>`)}
        </select>
      </label>
      <div style="flex:1"></div>
      <small style="color:var(--mc-text-dim);align-self:center">${total} images</small>
    </div>

    ${images.length === 0 ? html`
      <div class="empty-state">
        <div class="empty-icon"><i data-lucide="image-off" style="width:40px;height:40px"></i></div>
        <p>No images yet</p>
      </div>
    ` : html`
      <div class="gallery-grid">
        ${images.map(img => html`
          <div class="gallery-item" onclick="openLightbox(this)" data-full="/gallery-img/${img.filename}">
            <img src="/gallery-thumb/${img.filename.replace(/\.\w+$/, '.jpg')}" alt="${img.prompt}" loading="lazy"
              onerror="this.src='/gallery-img/${img.filename}'">
            <div class="gallery-meta">
              <span class="badge badge-${img.bot_name}" style="font-size:0.65rem;padding:0.1rem 0.35rem">${img.bot_name}</span>
              <span class="gallery-date">${formatTs(img.created_at)}</span>
            </div>
            <div class="gallery-prompt">${img.prompt.length > 100 ? img.prompt.slice(0, 100) + '\u2026' : img.prompt}</div>
            <div class="gallery-full-prompt" style="display:none">${img.prompt}</div>
          </div>
        `)}
      </div>
      ${pagination(page, totalPages, baseUrl)}
    `}

    <!-- Lightbox -->
    <div id="lightbox" class="lightbox" onclick="closeLightbox(event)">
      <button class="lightbox-close" onclick="closeLightbox(event)">&times;</button>
      <div class="lightbox-content">
        <img id="lightbox-img" src="" alt="">
        <div id="lightbox-info" class="lightbox-info"></div>
      </div>
    </div>

    <script>
      function openLightbox(el) {
        var fullSrc = el.getAttribute('data-full');
        var prompt = el.querySelector('.gallery-full-prompt').textContent;
        var meta = el.querySelector('.gallery-meta').innerHTML;
        document.getElementById('lightbox-img').src = fullSrc;
        document.getElementById('lightbox-info').innerHTML =
          '<div style="margin-bottom:0.3rem">' + meta + '</div>' +
          '<div style="font-size:0.82rem;color:var(--mc-text-secondary)">' + prompt + '</div>';
        document.getElementById('lightbox').classList.add('active');
        document.body.style.overflow = 'hidden';
      }
      function closeLightbox(e) {
        if (e.target === document.getElementById('lightbox') || e.target.classList.contains('lightbox-close')) {
          document.getElementById('lightbox').classList.remove('active');
          document.body.style.overflow = '';
        }
      }
      document.addEventListener('keydown', function(e) {
        if (e.key === 'Escape') {
          document.getElementById('lightbox').classList.remove('active');
          document.body.style.overflow = '';
        }
      });
    </script>
  `

  return c.html(layout('Gallery', content, '/gallery'))
})

export default app
