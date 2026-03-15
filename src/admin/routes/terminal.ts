import { Hono } from 'hono'
import { html } from 'hono/html'
import { layout, icon } from '../views/layout.js'
import type { I18nEnv } from '../i18n.js'

const app = new Hono<I18nEnv>()

app.get('/terminal', (c) => {
  const t = c.get('t')
  const lang = c.get('lang')

  const content = html`
    <h2>${icon('terminal')} ${t('terminal.title')}</h2>
    <p style="color:var(--mc-text-secondary);font-size:0.85rem;margin-bottom:1rem">${t('terminal.desc')}</p>
    <div id="terminal-container" style="width:100%;height:calc(100vh - 200px);border:1px solid var(--mc-border);border-radius:var(--radius);overflow:hidden;background:#1e1e1e"></div>
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/css/xterm.css">
    <script src="https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/lib/xterm.min.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/@xterm/addon-fit@0.10.0/lib/addon-fit.min.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/@xterm/addon-web-links@0.11.0/lib/addon-web-links.min.js"></script>
    <script>
      (function() {
        var term = new Terminal({
          cursorBlink: true,
          fontSize: 14,
          fontFamily: '"Fira Code", "Cascadia Code", "JetBrains Mono", "SF Mono", monospace',
          theme: {
            background: '#1e1e1e',
            foreground: '#d4d4d4',
            cursor: '#d4d4d4',
            selectionBackground: 'rgba(255,255,255,0.2)',
          },
          allowProposedApi: true,
        });

        var fitAddon = new FitAddon.FitAddon();
        var webLinksAddon = new WebLinksAddon.WebLinksAddon();
        term.loadAddon(fitAddon);
        term.loadAddon(webLinksAddon);
        term.open(document.getElementById('terminal-container'));
        fitAddon.fit();

        var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
        var wsUrl = proto + '//' + location.host + '/terminal/ws';
        var ws = new WebSocket(wsUrl);

        ws.onopen = function() {
          ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
          term.focus();
        };

        ws.onmessage = function(e) {
          try {
            var msg = JSON.parse(e.data);
            if (msg.type === 'exit') {
              term.writeln('\\r\\n[Process exited with code ' + msg.code + ']');
              return;
            }
            if (msg.type === 'error') {
              term.writeln('\\r\\n[Error: ' + msg.message + ']');
              return;
            }
          } catch(ex) {}
          term.write(e.data);
        };

        ws.onclose = function() {
          term.writeln('\\r\\n[Connection closed]');
        };

        ws.onerror = function() {
          term.writeln('\\r\\n[WebSocket error]');
        };

        term.onData(function(data) {
          if (ws.readyState === 1) ws.send(data);
        });

        window.addEventListener('resize', function() {
          fitAddon.fit();
        });

        new ResizeObserver(function() {
          fitAddon.fit();
        }).observe(document.getElementById('terminal-container'));

        term.onResize(function(size) {
          if (ws.readyState === 1) {
            ws.send(JSON.stringify({ type: 'resize', cols: size.cols, rows: size.rows }));
          }
        });
      })();
    </script>
  `
  return c.html(layout(t('terminal.title'), content, '/terminal', t, lang, 'terminal'))
})

export default app
