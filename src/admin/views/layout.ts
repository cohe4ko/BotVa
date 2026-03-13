import { html } from 'hono/html'
import type { HtmlEscapedString } from 'hono/utils/html'
import { getBotNames } from '../db-multi.js'

type HtmlContent = HtmlEscapedString | Promise<HtmlEscapedString>

/** Lucide icon helper — renders as inline SVG placeholder, hydrated by lucide.createIcons() */
export function icon(name: string, size = 15): HtmlContent {
  return html`<i data-lucide="${name}" style="width:${size}px;height:${size}px;display:inline-block;vertical-align:middle"></i>` as HtmlEscapedString
}

export function layout(title: string, content: HtmlContent, activePath = '/'): HtmlContent {
  const bots = getBotNames()
  return html`<!DOCTYPE html>
<html lang="uk">
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
      <a href="/" class="${activePath === '/' ? 'active' : ''}"><i data-lucide="layout-dashboard" style="width:14px;height:14px"></i> Dashboard</a>
      <div class="nav-dropdown${bots.some(b => activePath.startsWith(`/bot/${b}`)) ? ' active' : ''}">
        <button class="nav-dropdown-toggle"><i data-lucide="bot" style="width:14px;height:14px"></i> Bots <i data-lucide="chevron-down" style="width:12px;height:12px"></i></button>
        <div class="nav-dropdown-menu">
          ${bots.map(b => html`
            <a href="/bot/${b}/config" class="${activePath.startsWith(`/bot/${b}`) ? 'active' : ''}">${b}</a>
          `)}
        </div>
      </div>
      <a href="/team" class="${activePath === '/team' ? 'active' : ''}"><i data-lucide="users" style="width:14px;height:14px"></i> Team</a>
      <a href="/gallery" class="${activePath === '/gallery' ? 'active' : ''}"><i data-lucide="image" style="width:14px;height:14px"></i> Gallery</a>
      <a href="/storage" class="${activePath === '/storage' ? 'active' : ''}"><i data-lucide="hard-drive" style="width:14px;height:14px"></i> Storage</a>
      <a href="/system" class="${activePath === '/system' ? 'active' : ''}"><i data-lucide="server" style="width:14px;height:14px"></i> System</a>
      <a href="/create-bot" class="${activePath === '/create-bot' ? 'active' : ''}"><i data-lucide="plus" style="width:14px;height:14px"></i> New</a>
    </div>
    <button class="theme-toggle" onclick="toggleTheme()" title="Toggle theme">
      <i data-lucide="sun" style="width:16px;height:16px"></i>
    </button>
  </nav>
  <main class="mc-main">
    ${content}
  </main>
  <footer class="mc-footer">BotVa Admin</footer>
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
  { id: 'config', label: 'Config', icon: 'settings' },
  { id: 'knowledge', label: 'Knowledge', icon: 'book-open' },
  { id: 'memories', label: 'Memories', icon: 'brain' },
  { id: 'tasks', label: 'Tasks', icon: 'clock' },
  { id: 'sessions', label: 'Sessions', icon: 'link' },
  { id: 'settings', label: 'Settings', icon: 'sliders-horizontal' },
  { id: 'usage', label: 'Usage', icon: 'bar-chart-3' },
  { id: 'images', label: 'Images', icon: 'image' },
  { id: 'audit', label: 'Audit', icon: 'scroll-text' },
  { id: 'logs', label: 'Logs', icon: 'file-text' },
]

export function botNav(botName: string, currentSection: string): HtmlContent {
  return html`
    <div style="display:flex;align-items:center;gap:0.75rem;margin-bottom:0.75rem">
      <span class="badge badge-${botName}" style="font-size:0.85rem;padding:0.3rem 0.7rem">${botName}</span>
    </div>
    <div class="bot-nav">
      ${NAV_SECTIONS.map(s => html`
        <a href="/bot/${botName}/${s.id}" class="${currentSection === s.id ? 'active' : ''}"><i data-lucide="${s.icon}" style="width:13px;height:13px"></i> ${s.label}</a>
      `)}
    </div>
  ` as HtmlEscapedString
}
