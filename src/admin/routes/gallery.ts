import { Hono } from 'hono'
import { html } from 'hono/html'
import { layout, icon } from '../views/layout.js'
import { pagination, formatTs } from '../views/components.js'
import { getGalleryImages, countGalleryImages, getBotNames, deleteGalleryImage, getProjectRoot } from '../db-multi.js'
import { existsSync, unlinkSync } from 'fs'
import { resolve } from 'path'
import type { TFunc, Lang, I18nEnv } from '../i18n.js'

const PER_PAGE = 24

const app = new Hono<I18nEnv>()

app.get('/gallery', (c) => {
  const t: TFunc = c.get('t')
  const lang: Lang = c.get('lang')
  const page = Math.max(1, parseInt(c.req.query('page') ?? '1', 10))
  const bot = c.req.query('bot') || undefined
  const total = countGalleryImages(bot)
  const totalPages = Math.ceil(total / PER_PAGE)
  const offset = (page - 1) * PER_PAGE
  const images = getGalleryImages(PER_PAGE, offset, bot)
  const bots = getBotNames()

  const baseUrl = bot ? `/gallery?bot=${bot}` : '/gallery'

  const content = html`
    <h2>${icon('image')} ${t('gallery.title')}</h2>

    <div class="filter-bar">
      <label>${t('gallery.bot')}
        <select onchange="location.href='/gallery'+(this.value ? '?bot='+this.value : '')">
          <option value="">${t('gallery.allBots')}</option>
          ${bots.map(b => html`<option value="${b}" ${b === bot ? 'selected' : ''}>${b}</option>`)}
        </select>
      </label>
      <div style="flex:1"></div>
      <small style="color:var(--mc-text-dim);align-self:center">${total} ${t('gallery.images')}</small>
    </div>

    ${images.length === 0 ? html`
      <div class="empty-state">
        <div class="empty-icon"><i data-lucide="image-off" style="width:40px;height:40px"></i></div>
        <p>${t('gallery.noImages')}</p>
      </div>
    ` : html`
      <div class="gallery-grid">
        ${images.map(img => html`
          <div class="gallery-item" onclick="openLightbox(this)" data-full="/gallery-img/${img.filename}" data-id="${img.id}">
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
        <button id="lightbox-delete" class="danger btn-sm" style="margin-top:0.5rem" onclick="deleteImage()">
          ${icon('trash-2', 13)} ${t('gallery.delete') ?? 'Delete'}
        </button>
      </div>
    </div>

    <script>
      var currentImageId = null;
      var currentImageEl = null;
      function openLightbox(el) {
        var fullSrc = el.getAttribute('data-full');
        currentImageId = el.getAttribute('data-id');
        currentImageEl = el;
        var prompt = el.querySelector('.gallery-full-prompt').textContent;
        var metaEl = el.querySelector('.gallery-meta');
        var info = document.getElementById('lightbox-info');
        info.textContent = '';
        var metaDiv = document.createElement('div');
        metaDiv.style.marginBottom = '0.3rem';
        metaDiv.appendChild(metaEl.cloneNode(true));
        var promptDiv = document.createElement('div');
        promptDiv.style.fontSize = '0.82rem';
        promptDiv.style.color = 'var(--mc-text-secondary)';
        promptDiv.textContent = prompt;
        info.appendChild(metaDiv);
        info.appendChild(promptDiv);
        document.getElementById('lightbox-img').src = fullSrc;
        document.getElementById('lightbox').classList.add('active');
        document.body.style.overflow = 'hidden';
      }
      function deleteImage() {
        if (!currentImageId || !confirm('${t('gallery.deleteConfirm') ?? 'Delete this image?'}')) return;
        fetch('/gallery/delete/' + currentImageId, { method: 'POST' }).then(function(r) {
          if (r.ok) {
            if (currentImageEl) currentImageEl.remove();
            closeLightbox({ target: document.getElementById('lightbox') });
          }
        });
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

  return c.html(layout(t('gallery.title'), content, '/gallery', t, lang))
})

app.post('/gallery/delete/:id', (c) => {
  const id = parseInt(c.req.param('id'), 10)
  const deleted = deleteGalleryImage(id)
  if (!deleted) return c.text('Not found', 404)
  // Remove files
  const root = getProjectRoot()
  const imgPath = resolve(root, 'workspace/gallery', deleted.filename)
  const thumbName = deleted.filename.replace(/\.\w+$/, '.jpg')
  const thumbPath = resolve(root, 'workspace/gallery/thumbs', thumbName)
  try { if (existsSync(imgPath)) unlinkSync(imgPath) } catch {}
  try { if (existsSync(thumbPath)) unlinkSync(thumbPath) } catch {}
  return c.text('OK')
})

export default app
