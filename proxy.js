// SnuggPro API Proxy
// Run: node proxy.js
// Then open http://localhost:3001 in your browser (the proxy serves the UI).
//
// Keys are loaded from .env (see .env.example). Never commit .env.

require('dotenv').config();

const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3001;
const EXPORTS_DIR = path.join(__dirname, 'exports');
const TEMPLATE_PATH       = path.join(__dirname, 'template.xlsx');
// Single source: the same file the Worker serves as a static asset.
const TEMPLATE_RANGE_PATH = path.join(__dirname, 'public', 'template_range.xlsx');

const PROGRAMS = {
  region1: { name: 'Region 1 – CA LIWP Farmworkers', pub: process.env.REGION1_PUBLIC_KEY, priv: process.env.REGION1_PRIVATE_KEY },
  region2: { name: 'Region 2 – CA LIWP Farmworkers', pub: process.env.REGION2_PUBLIC_KEY, priv: process.env.REGION2_PRIVATE_KEY },
  sdge:    { name: 'SDGE – Whole Home Program',       pub: process.env.SDGE_PUBLIC_KEY,    priv: process.env.SDGE_PRIVATE_KEY },
  sce:     { name: 'SCE/SCG ESA Whole Home',          pub: process.env.SCE_PUBLIC_KEY,     priv: process.env.SCE_PRIVATE_KEY },
};
const DEFAULT_PROGRAM = 'sce';

const missingKeys = Object.entries(PROGRAMS).filter(([, p]) => !p.pub || !p.priv).map(([k]) => k);
if (missingKeys.length === Object.keys(PROGRAMS).length) {
  console.error('No program keys found in .env. Copy .env.example to .env and fill in your keys.');
  process.exit(1);
}
if (missingKeys.length) {
  console.warn(`Warning: missing keys for programs: ${missingKeys.join(', ')}`);
}
console.log('Loaded programs:');
Object.entries(PROGRAMS).forEach(([key, p]) => {
  const status = (p.pub && p.priv) ? `pub=${p.pub.slice(0,8)}…` : 'MISSING KEYS';
  console.log(`  ${key}: ${status}`);
});

if (!fs.existsSync(EXPORTS_DIR)) fs.mkdirSync(EXPORTS_DIR);

function signRequest(programKey) {
  const prog = PROGRAMS[programKey] || PROGRAMS[DEFAULT_PROGRAM];
  const date = new Date().toISOString();
  const hmac = crypto.createHmac('sha256', prog.priv);
  hmac.update(date);
  const sig = hmac.digest('hex');
  return { date, auth: `Credential=${prog.pub},Signature=${sig}` };
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // Serve the UI
  if (req.url === '/' && req.method === 'GET') {
    const htmlPath = path.join(__dirname, 'public', 'index.html');
    if (!fs.existsSync(htmlPath)) {
      res.writeHead(404); res.end('public/index.html not found'); return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(htmlPath));
    return;
  }

  // Return program list for the UI switcher
  if (req.url === '/programs' && req.method === 'GET') {
    const list = Object.entries(PROGRAMS).map(([key, p]) => ({ key, name: p.name, active: !!(p.pub && p.priv) }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(list));
    return;
  }

  // Serve template files to the browser
  const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  const isTemplateReq = ['/template', '/template.xlsx', '/template_range', '/template_range.xlsx'].includes(req.url);
  if (isTemplateReq && req.method === 'GET') {
    const filePath = req.url.startsWith('/template_range') ? TEMPLATE_RANGE_PATH : TEMPLATE_PATH;
    if (!fs.existsSync(filePath)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `${path.basename(filePath)} not found` }));
      return;
    }
    res.writeHead(200, { 'Content-Type': XLSX_MIME });
    res.end(fs.readFileSync(filePath));
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

  const reqUrl = new URL(req.url, `http://localhost:${PORT}`);
  const programKey = reqUrl.searchParams.get('program') || DEFAULT_PROGRAM;
  const proxyPath = reqUrl.pathname.replace(/^\/proxy/, '') + (reqUrl.search.replace(/[?&]program=[^&]*/g, '').replace(/^&/, '?') || '');
  const { date, auth } = signRequest(programKey);

  const prog = PROGRAMS[programKey] || PROGRAMS[DEFAULT_PROGRAM];
  console.log(`-> GET ${proxyPath} [${programKey}] pub=${prog?.pub?.slice(0,8) ?? 'MISSING'}…`);

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

// Single 'listening' handler (not a per-listen callback): retries after EADDRINUSE
// would stack callbacks and print one bogus "running" line per failed attempt.
server.on('listening', () => {
  const port = server.address().port;
  console.log(`SnuggPro proxy running -> http://localhost:${port}`);
  console.log(`Test: http://localhost:${port}/proxy/jobs/332046`);
  if (port !== Number(PORT)) console.log(`(port ${PORT} was in use, bound to ${port} instead)`);
});

function listen(port) {
  server.listen(port);
}

server.on('error', e => {
  if (e.code === 'EADDRINUSE') {
    // server.address() is null when the bind failed — advance from the port that
    // actually failed or retries loop forever on the same port.
    const next = (Number(e.port) || Number(PORT)) + 1;
    console.warn(`Port ${e.port ?? PORT} in use, trying ${next}…`);
    server.close(() => listen(next));
  } else {
    throw e;
  }
});

listen(Number(PORT));
