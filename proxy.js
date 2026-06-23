// SnuggPro API Proxy
// Run: node proxy.js
// Then open snuggpro-inspector.html in your browser
//
// Keys are loaded from .env (see .env.example). Never commit .env.

require('dotenv').config();

const http = require('http');
const https = require('https');
const crypto = require('crypto');

const PORT = process.env.PORT || 3001;
const PUBLIC_KEY = process.env.SNUGG_PUBLIC_KEY;
const PRIVATE_KEY = process.env.SNUGG_PRIVATE_KEY;

if (!PUBLIC_KEY || !PRIVATE_KEY) {
  console.error('Missing SNUGG_PUBLIC_KEY or SNUGG_PRIVATE_KEY.');
  console.error('Copy .env.example to .env and fill in your keys.');
  process.exit(1);
}

function signRequest() {
  const date = new Date().toISOString();
  const hmac = crypto.createHmac('sha256', PRIVATE_KEY);
  hmac.update(date);
  const sig = hmac.digest('hex');
  return { date, auth: `Credential=${PUBLIC_KEY},Signature=${sig}` };
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  if (req.method !== 'GET') { res.writeHead(405); res.end('Method not allowed'); return; }

  const path = req.url.replace(/^\/proxy/, '') || '/';
  const { date, auth } = signRequest();

  console.log(`-> GET ${path}`);

  const options = {
    hostname: 'api.snuggpro.com',
    path,
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
      console.log(`<- ${upRes.statusCode} ${path}`);
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
