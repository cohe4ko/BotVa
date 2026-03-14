import { Hono } from 'hono'
import { html } from 'hono/html'
import { layout, icon } from '../views/layout.js'
import { pagination, formatTs } from '../views/components.js'
import { getGalleryImages, countGalleryImages, getBotNames, deleteGalleryImage, getProjectRoot, getGalleryImageById } from '../db-multi.js'
import { existsSync, unlinkSync, readFileSync } from 'fs'
import { resolve } from 'path'
import { adminGenerateImage, adminEditImage } from '../imagen-admin.js'
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

    <!-- Workspace: Generate / Edit -->
    <div class="gen-workspace" id="gen-workspace">
      <div class="gen-workspace-preview" id="gen-ws-preview">
        <img id="gen-preview-img" src="" alt="">
        <div id="gen-preview-empty" class="gen-preview-empty">
          <i data-lucide="sparkles" style="width:28px;height:28px;opacity:0.3"></i>
          <span>${t('gallery.generateNew')}</span>
        </div>
      </div>
      <div class="gen-workspace-form">
        <textarea id="gen-prompt" rows="3" placeholder="${t('gallery.promptPlaceholder')}"></textarea>
        <div class="gen-refs-row">
          <div id="gen-dropzone" class="gen-dropzone" onclick="document.getElementById('gen-files').click()">
            <i data-lucide="upload" style="width:14px;height:14px;opacity:0.4"></i>
            <span>${t('gallery.dropzone')}</span>
          </div>
          <input type="file" id="gen-files" multiple accept="image/*" style="display:none" onchange="handleFiles(this.files)">
          <div id="gen-previews" class="gen-previews"></div>
        </div>
        <input type="hidden" id="gen-edit-id" value="">
        <div class="gen-workspace-actions">
          <button id="gen-submit" class="primary" onclick="submitGen()">
            ${icon('sparkles', 13)} <span id="gen-submit-text">${t('gallery.generate')}</span>
          </button>
          <button id="gen-reset" onclick="resetWorkspace()" style="display:none">${t('gallery.reset')}</button>
          <div id="gen-loading" class="gen-loading-inline" style="display:none">
            <div class="gen-spinner"></div>
            <span id="gen-loading-text">${t('gallery.generating')}</span>
          </div>
        </div>
        <div id="gen-error" class="alert alert-error" style="display:none;margin-top:0.5rem"></div>
      </div>
    </div>

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
            <button class="gallery-edit-btn" onclick="event.stopPropagation(); editImage(this.parentElement)" title="${t('gallery.edit')}">
              <i data-lucide="pencil" style="width:14px;height:14px"></i>
            </button>
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
      var genFiles = [];

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

      // Workspace: edit image from gallery card
      function editImage(el) {
        var fullSrc = el.getAttribute('data-full');
        var editId = el.getAttribute('data-id');
        var prompt = el.querySelector('.gallery-full-prompt').textContent;

        document.getElementById('gen-edit-id').value = editId;
        document.getElementById('gen-prompt').value = prompt;
        document.getElementById('gen-prompt').placeholder = '${t('gallery.editPlaceholder')}';
        document.getElementById('gen-submit-text').textContent = '${t('gallery.edit')}';
        document.getElementById('gen-loading-text').textContent = '${t('gallery.editingImage')}';

        var previewImg = document.getElementById('gen-preview-img');
        previewImg.src = fullSrc;
        previewImg.style.display = '';
        document.getElementById('gen-preview-empty').style.display = 'none';
        document.getElementById('gen-reset').style.display = '';

        genFiles = [];
        renderPreviews();
        document.getElementById('gen-error').style.display = 'none';

        document.getElementById('gen-workspace').scrollIntoView({ behavior: 'smooth', block: 'start' });
        setTimeout(function() { document.getElementById('gen-prompt').focus(); }, 300);
      }

      function resetWorkspace() {
        document.getElementById('gen-edit-id').value = '';
        document.getElementById('gen-prompt').value = '';
        document.getElementById('gen-prompt').placeholder = '${t('gallery.promptPlaceholder')}';
        document.getElementById('gen-submit-text').textContent = '${t('gallery.generate')}';
        document.getElementById('gen-loading-text').textContent = '${t('gallery.generating')}';

        document.getElementById('gen-preview-img').style.display = 'none';
        document.getElementById('gen-preview-empty').style.display = '';
        document.getElementById('gen-reset').style.display = 'none';

        genFiles = [];
        renderPreviews();
        document.getElementById('gen-error').style.display = 'none';
      }

      // Drag & drop
      var dz = document.getElementById('gen-dropzone');
      dz.addEventListener('dragover', function(e) { e.preventDefault(); dz.classList.add('dragover'); });
      dz.addEventListener('dragleave', function() { dz.classList.remove('dragover'); });
      dz.addEventListener('drop', function(e) {
        e.preventDefault();
        dz.classList.remove('dragover');
        handleFiles(e.dataTransfer.files);
      });

      function handleFiles(files) {
        for (var i = 0; i < files.length; i++) {
          if (files[i].type.startsWith('image/')) genFiles.push(files[i]);
        }
        renderPreviews();
      }

      function renderPreviews() {
        var container = document.getElementById('gen-previews');
        container.innerHTML = '';
        genFiles.forEach(function(f, idx) {
          var chip = document.createElement('div');
          chip.className = 'gen-preview-chip';
          var img = document.createElement('img');
          img.src = URL.createObjectURL(f);
          var rm = document.createElement('button');
          rm.type = 'button';
          rm.className = 'gen-preview-rm';
          rm.textContent = '\u00d7';
          rm.onclick = function() { genFiles.splice(idx, 1); renderPreviews(); };
          chip.appendChild(img);
          chip.appendChild(rm);
          container.appendChild(chip);
        });
      }

      function submitGen() {
        var prompt = document.getElementById('gen-prompt').value.trim();
        if (!prompt) return;
        var editId = document.getElementById('gen-edit-id').value;

        document.getElementById('gen-submit').style.display = 'none';
        document.getElementById('gen-reset').style.display = 'none';
        document.getElementById('gen-loading').style.display = 'flex';
        document.getElementById('gen-error').style.display = 'none';

        var fd = new FormData();
        fd.append('prompt', prompt);
        genFiles.forEach(function(f) { fd.append('files', f); });

        var url = editId ? '/gallery/edit/' + editId : '/gallery/generate';

        fetch(url, { method: 'POST', body: fd })
          .then(function(r) { return r.json(); })
          .then(function(data) {
            if (data.ok) {
              location.reload();
            } else {
              showGenError(data.error || 'Unknown error');
            }
          })
          .catch(function(err) {
            showGenError(err.message);
          });
      }

      function showGenError(msg) {
        document.getElementById('gen-loading').style.display = 'none';
        document.getElementById('gen-submit').style.display = '';
        if (document.getElementById('gen-edit-id').value) {
          document.getElementById('gen-reset').style.display = '';
        }
        document.getElementById('gen-error').textContent = msg;
        document.getElementById('gen-error').style.display = '';
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
  const root = getProjectRoot()
  const imgPath = resolve(root, 'workspace/gallery', deleted.filename)
  const thumbName = deleted.filename.replace(/\.\w+$/, '.jpg')
  const thumbPath = resolve(root, 'workspace/gallery/thumbs', thumbName)
  try { if (existsSync(imgPath)) unlinkSync(imgPath) } catch {}
  try { if (existsSync(thumbPath)) unlinkSync(thumbPath) } catch {}
  return c.text('OK')
})

app.post('/gallery/generate', async (c) => {
  try {
    const body = await c.req.parseBody({ all: true })
    const prompt = (body['prompt'] as string)?.trim()
    if (!prompt) return c.json({ ok: false, error: 'Prompt is required' })

    const files = body['files']
    const buffers: Buffer[] = []
    if (files) {
      const fileList = Array.isArray(files) ? files : [files]
      for (const f of fileList) {
        if (f instanceof File) {
          buffers.push(Buffer.from(await f.arrayBuffer()))
        }
      }
    }

    const result = await adminGenerateImage(prompt, buffers.length ? buffers : undefined)
    return c.json({ ok: true, id: result.filename, filename: result.filename })
  } catch (err: any) {
    return c.json({ ok: false, error: err.message || 'Generation failed' })
  }
})

app.post('/gallery/edit/:id', async (c) => {
  try {
    const id = parseInt(c.req.param('id'), 10)
    const img = getGalleryImageById(id)
    if (!img) return c.json({ ok: false, error: 'Image not found' })

    const body = await c.req.parseBody({ all: true })
    const prompt = (body['prompt'] as string)?.trim()
    if (!prompt) return c.json({ ok: false, error: 'Prompt is required' })

    const root = getProjectRoot()
    const imgPath = resolve(root, 'workspace/gallery', img.filename)
    if (!existsSync(imgPath)) return c.json({ ok: false, error: 'Image file not found' })

    const existingBuf = readFileSync(imgPath)

    const files = body['files']
    const extraBuffers: Buffer[] = []
    if (files) {
      const fileList = Array.isArray(files) ? files : [files]
      for (const f of fileList) {
        if (f instanceof File) {
          extraBuffers.push(Buffer.from(await f.arrayBuffer()))
        }
      }
    }

    const result = await adminEditImage(existingBuf, prompt, extraBuffers.length ? extraBuffers : undefined)
    return c.json({ ok: true, id: result.filename, filename: result.filename })
  } catch (err: any) {
    return c.json({ ok: false, error: err.message || 'Edit failed' })
  }
})

export default app
