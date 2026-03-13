const https = require('https');
const readline = require('readline');

// Create readline interface for stdin/stdout
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false
});

// Handle each line of input (MCP messages)
rl.on('line', (line) => {
  try {
    // Parse the MCP message
    const message = JSON.parse(line);
    
    // Forward to remote server
    const postData = JSON.stringify(message);
    
    const options = {
      hostname: 'bitrix24-mcp-server.azurewebsites.net',
      port: 443,
      path: '/mcp',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      
      res.on('data', (chunk) => {
        data += chunk;
      });
      
      res.on('end', () => {
        try {
          // Forward response back to Claude
          console.log(data);
        } catch (error) {
          console.error(JSON.stringify({
            jsonrpc: "2.0",
            error: {
              code: -32603,
              message: "Internal error: " + error.message
            },
            id: message.id || null
          }));
        }
      });
    });

    req.on('error', (error) => {
      console.error(JSON.stringify({
        jsonrpc: "2.0",
        error: {
          code: -32603,
          message: "Network error: " + error.message
        },
        id: message.id || null
      }));
    });

    req.write(postData);
    req.end();
    
  } catch (error) {
    console.error(JSON.stringify({
      jsonrpc: "2.0",
      error: {
        code: -32700,
        message: "Parse error: " + error.message
      },
      id: null
    }));
  }
});

// Handle process termination
process.on('SIGINT', () => {
  rl.close();
  process.exit(0);
});

process.on('SIGTERM', () => {
  rl.close();
  process.exit(0);
});
