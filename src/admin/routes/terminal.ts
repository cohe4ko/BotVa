import { Hono } from 'hono'
import { html } from 'hono/html'
import { layout, icon } from '../views/layout.js'
import { guideBlock } from '../views/components.js'
import type { I18nEnv } from '../i18n.js'
import { getActiveSessions, deleteSession } from '../terminal-ws.js'

const app = new Hono<I18nEnv>()

app.get('/terminal/sessions', (c) => c.json(getActiveSessions()))

app.delete('/terminal/sessions/:id', (c) => {
  return c.json({ ok: deleteSession(c.req.param('id')) })
})

app.get('/terminal', (c) => {
  const t = c.get('t')
  const lang = c.get('lang')
  const activeSessions = getActiveSessions()

  const content = html`
    <style>
      .term-toolbar {
        display: flex; align-items: center; justify-content: space-between;
        margin-bottom: 0.5rem; gap: 0.5rem; flex-wrap: wrap;
      }
      .term-toolbar h2 { margin: 0; font-size: 1.1rem; white-space: nowrap; }
      .term-sessions {
        display: flex; gap: 0.35rem; align-items: center; flex-wrap: wrap;
        overflow-x: auto; -webkit-overflow-scrolling: touch;
      }
      body.has-touch .term-sessions { flex-wrap: nowrap; }
      .term-sessions .session-btn { position: relative; font-size: 0.75rem; padding: 0.2rem 0.5rem; margin-top: 5px; }
      .term-sessions .session-btn.dead { text-decoration: line-through; opacity: 0.5; }
      .session-action { position: absolute; width: 16px; height: 16px;
        border-radius: 50%; color: #fff; border: none;
        font-size: 10px; line-height: 16px; text-align: center; cursor: pointer;
        display: none; padding: 0; }
      .session-del { top: -6px; right: -6px; background: var(--mc-red, #e74c3c); }
      .session-play { top: -6px; left: -6px; background: var(--mc-accent, #3b82f6); }
      .session-btn:hover .session-action { display: block; }
      #terminal-container {
        width: 100%; border: 1px solid var(--mc-border); border-radius: var(--radius);
        overflow: hidden; background: #1e1e1e;
        height: calc(100vh - 210px); /* fallback */
      }
      #terminal-container .xterm-screen { left: 5px; top: 5px; }
      #reconnect-bar {
        display: none; padding: 0.5rem 1rem; background: var(--mc-yellow-light);
        border: 1px solid var(--mc-border); border-radius: var(--radius);
        margin-top: 0.5rem; font-size: 0.85rem; text-align: center;
      }

      /* Fullscreen */
      body.term-fullscreen .top-nav,
      body.term-fullscreen .mc-footer,
      body.term-fullscreen .page-bg-icon,
      body.term-fullscreen .term-title-row { display: none !important; }
      body.term-fullscreen .mc-main { padding: 0 !important; max-width: 100% !important; margin: 0 !important; }
      body.term-fullscreen #terminal-container { border: none !important; border-radius: 0 !important; }
      body.term-fullscreen .term-toolbar {
        padding: 0.35rem 0.75rem; margin: 0;
        background: var(--mc-bg); border-bottom: 1px solid var(--mc-border);
      }

      /* Keybar */
      .term-keybar {
        display: none;
        gap: 4px; padding: 6px 4px;
        background: var(--mc-bg); border-bottom: 1px solid var(--mc-border);
        overflow-x: auto; white-space: nowrap;
        -webkit-overflow-scrolling: touch;
      }
      .term-keybar button {
        flex-shrink: 0; min-width: 36px; height: 32px;
        border: 1px solid var(--mc-border); border-radius: 4px;
        background: var(--mc-white); color: var(--mc-text);
        font-size: 13px; font-family: monospace;
        cursor: pointer; padding: 0 8px;
        -webkit-tap-highlight-color: transparent;
      }
      .term-keybar button:active { background: var(--mc-accent); color: #fff; }
      .term-keybar .kb-wide { min-width: 48px; }
      .term-keybar .kb-sep { width: 1px; height: 20px; background: var(--mc-border); flex-shrink: 0; align-self: center; }

      /* Mobile */
      @media (max-width: 640px) {
        .term-title-row { display: none; }
        .term-toolbar { justify-content: flex-start; }
        .term-toolbar h2 { display: none; }
        #terminal-container { border-radius: 0 !important; }
      }
      /* Touch — show keybar */
      body.has-touch .term-keybar { display: flex; }

      /* Active button */
      .session-btn.active { background: var(--mc-accent); border-color: var(--mc-accent); color: #fff; opacity: 1 !important; }
    </style>

    <div class="term-toolbar">
      <h2>${icon('terminal')} ${t('terminal.title')}</h2>
      <div class="term-sessions">
        ${activeSessions.map((s, i) => html`
          <button class="btn btn-sm btn-outline session-btn${s.alive ? '' : ' dead'}" data-session="${s.id}"
            title="${new Date(s.createdAt).toLocaleTimeString()}${s.alive ? '' : ' (exited)'}">
            ${s.alive ? '' : html`<span class="session-action session-play" data-play="${s.id}">&#9654;</span>`}
            #${i + 1} ${s.connected ? '●' : '○'}
            <span class="session-action session-del" data-del="${s.id}">&times;</span>
          </button>
        `)}
        ${activeSessions.length > 0 ? html`<span class="sess-sep" style="color:var(--mc-border);margin:0 0.15rem">|</span>` : ''}
        <button id="btn-new" class="btn btn-sm" style="font-size:0.75rem;padding:0.2rem 0.5rem">
          ${icon('plus', 12)} ${t('terminal.new')}
        </button>
        <span style="display:inline-flex;gap:2px;align-items:center">
          <button id="btn-font-down" class="btn btn-sm btn-outline" style="font-size:0.75rem;padding:0.2rem 0.4rem;min-width:0" title="A-">-</button>
          <span id="font-size-label" style="font-size:0.7rem;min-width:1.5rem;text-align:center;color:var(--mc-text-dim)">14</span>
          <button id="btn-font-up" class="btn btn-sm btn-outline" style="font-size:0.75rem;padding:0.2rem 0.4rem;min-width:0" title="A+">+</button>
        </span>
        <button id="btn-fullscreen" class="btn btn-sm btn-outline" style="font-size:0.75rem;padding:0.2rem 0.5rem" title="${t('terminal.fullscreen')}">
          ${icon('maximize-2', 12)}
        </button>
      </div>
    </div>

    <div class="term-keybar" id="term-keybar">
      <button data-key="esc">Esc</button>
      <button data-key="tab" class="kb-wide">Tab</button>
      <span class="kb-sep"></span>
      <button data-key="up">\u2191</button>
      <button data-key="down">\u2193</button>
      <button data-key="left">\u2190</button>
      <button data-key="right">\u2192</button>
      <span class="kb-sep"></span>
      <button data-key="ctrl-c">C-c</button>
      <button data-key="ctrl-d">C-d</button>
      <button data-key="ctrl-l">C-l</button>
      <button data-key="ctrl-a">C-a</button>
      <button data-key="ctrl-e">C-e</button>
      <span class="kb-sep"></span>
      <button data-key="/" class="kb-wide">/</button>
      <button data-key="|">|</button>
      <button data-key="~">~</button>
    </div>
    <div id="terminal-container"></div>
    <div id="reconnect-bar">
      ${t('terminal.disconnected')}
      <button id="btn-reconnect" class="btn btn-sm" style="margin-left:0.5rem;font-size:0.75rem">${t('terminal.reconnect')}</button>
    </div>

    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/css/xterm.css">
    <script src="https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/lib/xterm.min.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/@xterm/addon-fit@0.10.0/lib/addon-fit.min.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/@xterm/addon-web-links@0.11.0/lib/addon-web-links.min.js"></script>
    <script>
      (function() {
        var hasTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
        var isMobile = window.innerWidth <= 640 || hasTouch;
        if (hasTouch) document.body.classList.add('has-touch');

        var term = new Terminal({
          cursorBlink: true,
          fontSize: isMobile ? 12 : 14,
          fontFamily: '"Fira Code", "Cascadia Code", "JetBrains Mono", "SF Mono", monospace',
          theme: { background: '#1e1e1e', foreground: '#d4d4d4', cursor: '#d4d4d4', selectionBackground: 'rgba(255,255,255,0.2)' },
          allowProposedApi: true,
          scrollOnUserInput: true,
        });

        var fitAddon = new FitAddon.FitAddon();
        var webLinksAddon = new WebLinksAddon.WebLinksAddon();
        term.loadAddon(fitAddon);
        term.loadAddon(webLinksAddon);
        term.open(document.getElementById('terminal-container'));
        fitAddon.fit();

        var sessionId = null;
        var ws = null;

        // --- Session buttons ---
        function getSessionCount() { return document.querySelectorAll('.session-btn').length; }

        function ensureSeparator() {
          var c = document.querySelector('.term-sessions');
          if (!c || c.querySelector('.sess-sep') || getSessionCount() === 0) return;
          var sep = document.createElement('span');
          sep.className = 'sess-sep';
          sep.style.cssText = 'color:var(--mc-border);margin:0 0.15rem';
          sep.textContent = '|';
          c.insertBefore(sep, document.getElementById('btn-new'));
        }

        function wireSessionBtn(btn) {
          btn.addEventListener('click', function(e) {
            if (e.target.classList.contains('session-action')) return;
            var sid = btn.getAttribute('data-session');
            if (ws && ws.readyState === 1) ws.close();
            term.reset();
            connect(sid);
          });
        }

        function wirePlayBtn(btn) {
          btn.addEventListener('click', function(e) {
            e.stopPropagation();
            var sid = btn.getAttribute('data-play');
            if (ws && ws.readyState === 1) ws.close();
            term.reset();
            connect(sid, true);
          });
        }

        function wireDeleteBtn(btn) {
          btn.addEventListener('click', function(e) {
            e.stopPropagation();
            var sid = btn.getAttribute('data-del');
            if (!confirm('Delete session?')) return;
            fetch('/terminal/sessions/' + sid, { method: 'DELETE' }).then(function() {
              btn.closest('.session-btn').remove();
              if (getSessionCount() === 0) { var sep = document.querySelector('.sess-sep'); if (sep) sep.remove(); }
              if (sessionId === sid) { sessionId = null; term.reset(); term.writeln('[Session deleted]'); }
            });
          });
        }

        function ensureSessionBtn(sid) {
          if (document.querySelector('.session-btn[data-session="' + sid + '"]')) return;
          var c = document.querySelector('.term-sessions');
          if (!c) return;
          var num = getSessionCount() + 1;
          var btn = document.createElement('button');
          btn.className = 'btn btn-sm btn-outline session-btn';
          btn.setAttribute('data-session', sid);
          btn.style.cssText = 'font-size:0.75rem;padding:0.2rem 0.5rem;position:relative';
          btn.innerHTML = '#' + num + ' \\u25CF<span class="session-action session-del" data-del="' + sid + '">&times;</span>';
          var sep = c.querySelector('.sess-sep');
          c.insertBefore(btn, sep || document.getElementById('btn-new'));
          ensureSeparator();
          wireSessionBtn(btn);
          wireDeleteBtn(btn.querySelector('.session-del'));
        }

        function updateActiveBtn() {
          document.querySelectorAll('.session-btn').forEach(function(btn) {
            var isActive = btn.getAttribute('data-session') === sessionId;
            btn.classList.toggle('active', isActive);
            btn.childNodes.forEach(function(node) {
              if (node.nodeType === 3) node.textContent = node.textContent.replace(/[\\u25CF\\u25CB]/, isActive ? '\\u25CF' : '\\u25CB');
            });
          });
        }

        // --- WebSocket ---
        function connect(sid, autoRevive) {
          var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
          var wsUrl = proto + '//' + location.host + '/terminal/ws';
          if (sid) wsUrl += '?session=' + sid;
          ws = new WebSocket(wsUrl);

          ws.onopen = function() {
            document.getElementById('reconnect-bar').style.display = 'none';
            ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
            term.focus();
          };

          ws.onmessage = function(e) {
            var d = e.data;
            if (d.charCodeAt(0) === 0) {
              try {
                var msg = JSON.parse(d.slice(1));
                if (msg.type === 'session') {
                  sessionId = msg.id;
                  var url = new URL(location.href);
                  url.searchParams.set('session', msg.id);
                  history.replaceState(null, '', url.toString());
                  ensureSessionBtn(msg.id);
                  updateActiveBtn();
                }
                if (msg.type === 'dead') {
                  if (autoRevive) { autoRevive = false; ws.send(JSON.stringify({ type: 'revive' })); }
                }
                if (msg.type === 'alive') {
                  term.reset();
                  var ab = document.querySelector('.session-btn[data-session="' + sessionId + '"]');
                  if (ab) { ab.classList.remove('dead'); var pb = ab.querySelector('.session-play'); if (pb) pb.remove(); }
                }
                if (msg.type === 'exit') {
                  term.writeln('\\r\\n[Process exited with code ' + msg.code + ']');
                  var eb = document.querySelector('.session-btn[data-session="' + sessionId + '"]');
                  if (eb) eb.classList.add('dead');
                  sessionId = null;
                }
                if (msg.type === 'error') {
                  term.writeln('\\r\\n[Error: ' + msg.message + ']');
                }
              } catch(ex) { console.error('ctrl parse error', ex); }
              return;
            }
            term.write(d);
          };

          ws.onclose = function() {
            if (sessionId) document.getElementById('reconnect-bar').style.display = 'block';
            else term.writeln('\\r\\n[Connection closed]');
          };
          ws.onerror = function() {};
        }

        // Filter terminal response sequences
        var termResponseRe = /^\\x1b\\[\\??[\\d;]*[cI]$/;
        term.onData(function(data) {
          if (termResponseRe.test(data)) return;
          if (ws && ws.readyState === 1) ws.send(data);
        });

        // --- Height ---
        var container = document.getElementById('terminal-container');
        function updateHeight() {
          var top = container.getBoundingClientRect().top;
          // On mobile: reserve ~50% for keyboard; on desktop: fill available space
          var vh = isMobile ? window.innerHeight * 0.6 : window.innerHeight - top;
          if (vh < 100) vh = 100;
          container.style.height = vh + 'px';
          fitAddon.fit();
        }
        updateHeight();
        window.addEventListener('resize', function() { if (!isMobile) updateHeight(); });
        new ResizeObserver(function() { fitAddon.fit(); }).observe(container);

        term.onResize(function(size) {
          if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'resize', cols: size.cols, rows: size.rows }));
        });

        // --- Keybar ---
        var keyMap = {
          'esc': '\\x1b', 'tab': '\\t',
          'up': '\\x1b[A', 'down': '\\x1b[B', 'left': '\\x1b[D', 'right': '\\x1b[C',
          'ctrl-c': '\\x03', 'ctrl-d': '\\x04', 'ctrl-l': '\\x0c', 'ctrl-a': '\\x01', 'ctrl-e': '\\x05',
        };
        document.querySelectorAll('#term-keybar button').forEach(function(btn) {
          btn.addEventListener('click', function(e) {
            e.preventDefault();
            var raw = btn.getAttribute('data-key');
            var key = keyMap[raw] || raw;
            if (key && ws && ws.readyState === 1) ws.send(key);
            term.focus();
          });
        });

        // --- Font size ---
        var fontLabel = document.getElementById('font-size-label');
        function setFontSize(size) {
          size = Math.max(8, Math.min(28, size));
          term.options.fontSize = size;
          fontLabel.textContent = size;
          fitAddon.fit();
          localStorage.setItem('term-font-size', size);
        }
        var savedSize = parseInt(localStorage.getItem('term-font-size') || '0');
        if (savedSize) setFontSize(savedSize);
        else fontLabel.textContent = term.options.fontSize;
        document.getElementById('btn-font-up').addEventListener('click', function() { setFontSize(term.options.fontSize + 1); });
        document.getElementById('btn-font-down').addEventListener('click', function() { setFontSize(term.options.fontSize - 1); });

        // --- Fullscreen ---
        document.getElementById('btn-fullscreen').addEventListener('click', function() {
          document.body.classList.toggle('term-fullscreen');
          setTimeout(updateHeight, 50);
        });
        document.addEventListener('keydown', function(e) {
          if (e.key === 'Escape' && document.body.classList.contains('term-fullscreen')) {
            document.body.classList.remove('term-fullscreen');
            setTimeout(updateHeight, 50);
          }
        });

        // Auto-fullscreen on mobile
        if (isMobile) document.body.classList.add('term-fullscreen');

        // --- Wire existing buttons ---
        document.querySelectorAll('.session-btn').forEach(wireSessionBtn);
        document.querySelectorAll('.session-play').forEach(wirePlayBtn);
        document.querySelectorAll('.session-del').forEach(wireDeleteBtn);

        // --- Reconnect / New ---
        document.getElementById('btn-reconnect').addEventListener('click', function() { connect(sessionId); });
        document.getElementById('btn-new').addEventListener('click', function() {
          if (ws && ws.readyState === 1) ws.close();
          sessionId = null;
          term.reset();
          connect(null);
        });

        // --- Auto-connect ---
        var params = new URLSearchParams(location.search);
        connect(params.get('session'));
      })();
    </script>
  `
  return c.html(layout(t('terminal.title'), content, '/terminal', t, lang, 'terminal'))
})

export default app
