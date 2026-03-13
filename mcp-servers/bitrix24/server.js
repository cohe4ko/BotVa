import { createServer } from 'http';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PORT = process.env.PORT || 3000;

// Create HTTP server
const server = createServer((req, res) => {
  // Set CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Bitrix24 MCP Server</title>
        <style>
          body { font-family: Arial, sans-serif; margin: 40px; }
          .container { max-width: 800px; margin: 0 auto; }
          .status { padding: 20px; background: #e8f5e8; border-radius: 5px; margin: 20px 0; }
          .info { padding: 15px; background: #f0f8ff; border-radius: 5px; margin: 10px 0; }
          code { background: #f5f5f5; padding: 2px 5px; border-radius: 3px; }
        </style>
      </head>
      <body>
        <div class="container">
          <h1>🚀 Bitrix24 MCP Server</h1>
          <div class="status">
            <h2>✅ Server Status: Running</h2>
            <p>Your Bitrix24 MCP Server is successfully deployed and running on Azure!</p>
          </div>
          
          <div class="info">
            <h3>📋 Server Information</h3>
            <ul>
              <li><strong>Version:</strong> 1.0.0</li>
              <li><strong>Runtime:</strong> Node.js ${process.version}</li>
              <li><strong>Platform:</strong> ${process.platform}</li>
              <li><strong>Port:</strong> ${PORT}</li>
              <li><strong>Environment:</strong> ${process.env.NODE_ENV || 'development'}</li>
            </ul>
          </div>

          <div class="info">
            <h3>🔧 Usage</h3>
            <p>This is an MCP (Model Context Protocol) server for Bitrix24 integration. It's designed to be used with AI agents and tools that support the MCP protocol.</p>
            <p>To use this server, configure your MCP client to connect to:</p>
            <code>node ${join(__dirname, 'build', 'index.js')}</code>
          </div>

          <div class="info">
            <h3>🔗 API Endpoints</h3>
            <ul>
              <li><code>GET /</code> - This status page</li>
              <li><code>GET /health</code> - Health check endpoint</li>
              <li><code>POST /mcp</code> - MCP protocol endpoint (for HTTP-based clients)</li>
            </ul>
          </div>
        </div>
      </body>
      </html>
    `);
    return;
  }

  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      version: '1.0.0',
      uptime: process.uptime()
    }));
    return;
  }

  if (req.method === 'POST' && req.url === '/mcp') {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
    });

    req.on('end', () => {
      try {
        const mcpRequest = JSON.parse(body);
        
        // Spawn the MCP server process
        const mcpProcess = spawn('node', [join(__dirname, 'build', 'index.js')], {
          stdio: ['pipe', 'pipe', 'pipe']
        });

        let responseData = '';
        let errorData = '';

        mcpProcess.stdout.on('data', (data) => {
          responseData += data.toString();
        });

        mcpProcess.stderr.on('data', (data) => {
          errorData += data.toString();
        });

        mcpProcess.on('close', (code) => {
          if (code === 0) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(responseData || JSON.stringify({ success: true }));
          } else {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: errorData || 'MCP process failed' }));
          }
        });

        // Send the request to MCP server
        mcpProcess.stdin.write(JSON.stringify(mcpRequest) + '\n');
        mcpProcess.stdin.end();

      } catch (error) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON request' }));
      }
    });
    return;
  }

  // 404 for other routes
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
});

server.listen(PORT, () => {
  console.log(`🚀 Bitrix24 MCP Server HTTP wrapper running on port ${PORT}`);
  console.log(`📍 Access your server at: http://localhost:${PORT}`);
  console.log(`💡 MCP Server binary location: ${join(__dirname, 'build', 'index.js')}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('Received SIGTERM, shutting down gracefully...');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});
