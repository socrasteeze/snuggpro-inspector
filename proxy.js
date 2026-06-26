// SnuggPro API Proxy
// Run: node proxy.js
// Then open snuggpro-inspector.html in your browser
//
// Keys are loaded from .env (see .env.example). Never commit .env.

require('dotenv').config();

const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3001;
const PUBLIC_KEY = process.env.SNUGG_PUBLIC_KEY;
const PRIVATE_KEY = process.env.SNUGG_PRIVATE_KEY;
const EXPORTS_DIR = path.join(__dirname, 'exports');
const TEMPLATE_PATH = path.join(__dirname, 'template.xlsx');

if (!PUBLIC_KEY || !PRIVATE_KEY) {
  console.error('Missing SNUGG_PUBLIC_KEY or SNUGG_PRIVATE_KEY.');
  console.error('Copy .env.example to .env and fill in your keys.');
  process.exit(1);
}

if (!fs.existsSync(EXPORTS_DIR)) fs.mkdirSync(EXPORTS_DIR);

function signRequest() {
  const date = new Date().toISOString();
  const hmac = crypto.createHmac('sha256', PRIVATE_KEY);
  hmac.update(date);
  const sig = hmac.digest('hex');
  return { date, auth: `Credential=${PUBLIC_KEY},Signature=${sig}` };
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // Serve template.xlsx to the browser
  if (req.url === '/template' && req.method === 'GET') {
    if (!fs.existsSync(TEMPLATE_PATH)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'template.xlsx not found in project root' }));
      return;
    }
    const data = fs.readFileSync(TEMPLATE_PATH);
    res.writeHead(200, { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    res.end(data);
    return;
  }

  // Save an exported XLSX to the exports/ folder
  if (req.url.startsWith('/exports') && req.method === 'POST') {
    const params = new URL(req.url, `http://localhost:${PORT}`).searchParams;
    const filename = path.basename(params.get('filename') || 'export.xlsx');
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      fs.writeFileSync(path.join(EXPORTS_DIR, filename), Buffer.concat(chunks));
      console.log(`-> saved exports/${filename}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ saved: filename }));
    });
    return;
  }

  if (req.method !== 'GET') { res.writeHead(405); res.end('Method not allowed'); return; }

  const proxyPath = req.url.replace(/^\/proxy/, '') || '/';
  const { date, auth } = signRequest();

  console.log(`-> GET ${proxyPath}`);

  const options = {
    hostname: 'api.snuggpro.com',
    path: proxyPath,
    method: 'GET',
    headers: {
      'Authorization': auth,
      'X-Date': date,
      'Content-Type': 'application/json'
    }
  };

  const upstream = https.request(options, upRes => {
    let body = '';
    upRes.on('data', d => body += d);
    upRes.on('end', () => {
      console.log(`<- ${upRes.statusCode} ${proxyPath}`);
      res.writeHead(upRes.statusCode, { 'Content-Type': 'application/json' });
      res.end(body);
    });
  });

  upstream.on('error', e => {
    console.error('Upstream error:', e.message);
    res.writeHead(502);
    res.end(JSON.stringify({ error: e.message }));
  });

  upstream.end();
});

server.listen(PORT, () => {
  console.log(`SnuggPro proxy running -> http://localhost:${PORT}`);
  console.log(`Test: http://localhost:${PORT}/proxy/jobs/332046`);
});
