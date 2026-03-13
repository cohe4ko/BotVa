import { html } from 'hono/html'
import type { HtmlEscapedString } from 'hono/utils/html'
import { getBotNames } from '../db-multi.js'
import type { TFunc, Lang } from '../i18n.js'

type HtmlContent = HtmlEscapedString | Promise<HtmlEscapedString>

/** Lucide icon helper — renders as inline SVG placeholder, hydrated by lucide.createIcons() */
export function icon(name: string, size = 15): HtmlContent {
  return html`<i data-lucide="${name}" style="width:${size}px;height:${size}px;display:inline-block;vertical-align:middle"></i>` as HtmlEscapedString
}

export function layout(title: string, content: HtmlContent, activePath = '/', t?: TFunc, lang?: Lang): HtmlContent {
  const bots = getBotNames()
  const _t = t ?? ((k: string) => k)
  const _lang = lang ?? 'uk'
  const otherLang = _lang === 'uk' ? 'en' : 'uk'
  const langLabel = _lang === 'uk' ? 'EN' : 'UA'
  return html`<!DOCTYPE html>
<html lang="${_lang}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title} — BotVa</title>
  <link rel="stylesheet" href="/static/app.css">
  <script src="/static/htmx.min.js"></script>
  <script src="https://unpkg.com/lucide@latest/dist/umd/lucide.min.js"></script>
  <script>
    (function(){
      var t = localStorage.getItem('theme');
      if (t) document.documentElement.setAttribute('data-theme', t);
    })();
    function toggleTheme() {
      var current = document.documentElement.getAttribute('data-theme');
      var isDark = current === 'dark' || (!current && window.matchMedia('(prefers-color-scheme: dark)').matches);
      var next = isDark ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      localStorage.setItem('theme', next);
    }
    function toggleMobileMenu() {
      document.querySelector('.nav-links').classList.toggle('open');
      document.querySelector('.burger-toggle').classList.toggle('open');
    }
    function switchLang() {
      document.cookie = 'lang=${otherLang};path=/;max-age=' + (365*86400);
      location.reload();
    }
  </script>
</head>
<body>
  <nav class="top-nav">
    <a href="/" class="logo">
      <span class="logo-icon"><i data-lucide="sprout" style="width:14px;height:14px"></i></span>
      BotVa
    </a>
    <button class="burger-toggle" onclick="toggleMobileMenu()" aria-label="Menu">
      <i data-lucide="menu" style="width:20px;height:20px"></i>
    </button>
    <div class="nav-links">
      <a href="/" class="${activePath === '/' ? 'active' : ''}"><i data-lucide="layout-dashboard" style="width:14px;height:14px"></i> ${_t('nav.dashboard')}</a>
      <div class="nav-dropdown${bots.some(b => activePath.startsWith(`/bot/${b}`)) ? ' active' : ''}">
        <button class="nav-dropdown-toggle"><i data-lucide="bot" style="width:14px;height:14px"></i> ${_t('nav.bots')} <i data-lucide="chevron-down" style="width:12px;height:12px"></i></button>
        <div class="nav-dropdown-menu">
          ${bots.map(b => html`
            <a href="/bot/${b}/config" class="${activePath.startsWith(`/bot/${b}`) ? 'active' : ''}">${b}</a>
          `)}
        </div>
      </div>
      <a href="/team" class="${activePath === '/team' ? 'active' : ''}"><i data-lucide="users" style="width:14px;height:14px"></i> ${_t('nav.team')}</a>
      <a href="/gallery" class="${activePath === '/gallery' ? 'active' : ''}"><i data-lucide="image" style="width:14px;height:14px"></i> ${_t('nav.gallery')}</a>
      <a href="/storage" class="${activePath === '/storage' ? 'active' : ''}"><i data-lucide="hard-drive" style="width:14px;height:14px"></i> ${_t('nav.storage')}</a>
      <a href="/system" class="${activePath === '/system' ? 'active' : ''}"><i data-lucide="server" style="width:14px;height:14px"></i> ${_t('nav.system')}</a>
      <a href="/create-bot" class="${activePath === '/create-bot' ? 'active' : ''}"><i data-lucide="plus" style="width:14px;height:14px"></i> ${_t('nav.new')}</a>
    </div>
    <div style="display:flex;align-items:center;gap:0.25rem">
      <button class="theme-toggle" onclick="switchLang()" title="Switch language" style="font-size:0.75rem;font-weight:600;min-width:28px">
        ${langLabel}
      </button>
      <button class="theme-toggle" onclick="toggleTheme()" title="Toggle theme">
        <i data-lucide="sun" style="width:16px;height:16px"></i>
      </button>
    </div>
  </nav>
  <main class="mc-main">
    ${content}
  </main>
  <footer class="mc-footer">${_t('nav.footer')}</footer>
  <script>lucide.createIcons();</script>
  <script>
    // Re-init icons after htmx swaps
    document.body.addEventListener('htmx:afterSwap', function() { lucide.createIcons(); });
    // Nav dropdown toggle
    document.querySelectorAll('.nav-dropdown-toggle').forEach(function(btn) {
      btn.addEventListener('click', function(e) {
        e.stopPropagation();
        var dd = btn.closest('.nav-dropdown');
        dd.classList.toggle('open');
      });
    });
    document.addEventListener('click', function() {
      document.querySelectorAll('.nav-dropdown.open').forEach(function(dd) { dd.classList.remove('open'); });
    });
  </script>
</body>
</html>` as HtmlEscapedString
}

const NAV_SECTIONS = [
  { id: 'config', key: 'botnav.config', icon: 'settings' },
  { id: 'knowledge', key: 'botnav.knowledge', icon: 'book-open' },
  { id: 'memories', key: 'botnav.memories', icon: 'brain' },
  { id: 'tasks', key: 'botnav.tasks', icon: 'clock' },
  { id: 'sessions', key: 'botnav.sessions', icon: 'link' },
  { id: 'settings', key: 'botnav.settings', icon: 'sliders-horizontal' },
  { id: 'usage', key: 'botnav.usage', icon: 'bar-chart-3' },
  { id: 'images', key: 'botnav.images', icon: 'image' },
  { id: 'audit', key: 'botnav.audit', icon: 'scroll-text' },
  { id: 'logs', key: 'botnav.logs', icon: 'file-text' },
]

export function botNav(botName: string, currentSection: string, t?: TFunc): HtmlContent {
  const _t = t ?? ((k: string) => k)
  return html`
    <div style="display:flex;align-items:center;gap:0.75rem;margin-bottom:0.75rem">
      <span class="badge badge-${botName}" style="font-size:0.85rem;padding:0.3rem 0.7rem">${botName}</span>
    </div>
    <div class="bot-nav">
      ${NAV_SECTIONS.map(s => html`
        <a href="/bot/${botName}/${s.id}" class="${currentSection === s.id ? 'active' : ''}"><i data-lucide="${s.icon}" style="width:13px;height:13px"></i> ${_t(s.key)}</a>
      `)}
    </div>
  ` as HtmlEscapedString
}
