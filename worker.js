// SnuggPro Inspector — Cloudflare Worker
//
// One Worker is the whole backend:
//   1. Gates every request on an email-one-time-code login session.
//   2. Serves the inspector UI (public/index.html) once signed in.
//   3. Signs (HMAC-SHA256) and forwards /proxy/* to api.snuggpro.com — the
//      same job proxy.js does locally, ported to Web Crypto.
//
// Secrets (wrangler secret put):
//   REGION1_PUBLIC_KEY  REGION1_PRIVATE_KEY
//   REGION2_PUBLIC_KEY  REGION2_PRIVATE_KEY
//   SDGE_PUBLIC_KEY     SDGE_PRIVATE_KEY
//   SCE_PUBLIC_KEY      SCE_PRIVATE_KEY
//   SESSION_SECRET  EMAIL_API_KEY
// Vars (wrangler.toml): ALLOWED_EMAILS (comma-separated), FROM_EMAIL.
//
// Nothing here is hardcoded — all keys come from env. Never commit real secrets.

const SNUGG_HOST = 'api.snuggpro.com';

// Program registry — mirrors proxy.js on the local side.
const PROGRAMS = (env) => ({
  region1: { name: 'Region 1 – CA LIWP Farmworkers', pub: env.REGION1_PUBLIC_KEY, priv: env.REGION1_PRIVATE_KEY },
  region2: { name: 'Region 2 – CA LIWP Farmworkers', pub: env.REGION2_PUBLIC_KEY, priv: env.REGION2_PRIVATE_KEY },
  sdge:    { name: 'SDGE – Whole Home Program',       pub: env.SDGE_PUBLIC_KEY,    priv: env.SDGE_PRIVATE_KEY },
  sce:     { name: 'SCE/SCG ESA Whole Home',          pub: env.SCE_PUBLIC_KEY,     priv: env.SCE_PRIVATE_KEY },
});
const DEFAULT_PROGRAM = 'region1';
const OTP_TTL_MS = 10 * 60 * 1000;          // code valid 10 minutes
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // session valid 30 days

// ---------- crypto helpers ----------

async function hmacHex(message, secret) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// Constant-time-ish string compare (both already hex/fixed-length here).
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function b64urlEncode(str) {
  return btoa(unescape(encodeURIComponent(str)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  return decodeURIComponent(escape(atob(str)));
}

// A signed token is "<b64url(payloadJson)>.<hmacHex(b64url(payloadJson))>".
async function makeToken(payload, secret) {
  const body = b64urlEncode(JSON.stringify(payload));
  return `${body}.${await hmacHex(body, secret)}`;
}
async function readToken(token, secret) {
  if (!token || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  if (!safeEqual(sig, await hmacHex(body, secret))) return null;
  let payload;
  try { payload = JSON.parse(b64urlDecode(body)); } catch (_) { return null; }
  if (!payload.exp || payload.exp < Date.now()) return null;
  return payload;
}

// ---------- cookie helpers ----------

function getCookie(request, name) {
  const header = request.headers.get('Cookie') || '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}
function setCookie(name, value, maxAgeSec) {
  const attrs = ['Path=/', 'HttpOnly', 'Secure', 'SameSite=Lax'];
  if (maxAgeSec === 0) attrs.push('Max-Age=0');
  else if (maxAgeSec) attrs.push(`Max-Age=${maxAgeSec}`);
  return `${name}=${value}; ${attrs.join('; ')}`;
}

// ---------- HTML pages ----------

const PAGE_STYLE = `body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#0f1115;color:#e6e6e6;
display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.card{background:#1a1d23;padding:32px;border-radius:12px;width:320px;box-shadow:0 8px 40px rgba(0,0,0,.4)}
h1{font-size:18px;margin:0 0 4px}p{color:#9aa0aa;font-size:13px;margin:0 0 20px}
input{width:100%;box-sizing:border-box;padding:11px;margin-bottom:12px;border-radius:8px;border:1px solid #2c313a;
background:#0f1115;color:#fff;font-size:15px}
button{width:100%;padding:11px;border:0;border-radius:8px;background:#1c6ef2;color:#fff;font-size:15px;
font-weight:600;cursor:pointer}.err{color:#ff7676;font-size:13px;margin-bottom:12px}`;

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function pageHtml(inner) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>SnuggPro Inspector</title><style>${PAGE_STYLE}</style></head><body><div class="card">${inner}</div></body></html>`;
}

// Wrap an HTML string in a Response, optionally setting cookies.
function htmlResponse(html, cookies) {
  const headers = new Headers({ 'Content-Type': 'text/html; charset=utf-8' });
  for (const c of cookies || []) headers.append('Set-Cookie', c);
  return new Response(html, { headers });
}

function loginPage(msg) {
  return pageHtml(`<h1>SnuggPro Inspector</h1><p>Enter your email to receive a sign-in code.</p>
${msg ? `<div class="err">${escapeHtml(msg)}</div>` : ''}
<form method="POST" action="/auth/request-code">
<input type="email" name="email" placeholder="you@example.com" autofocus required>
<button type="submit">Send code</button></form>`);
}

function codePage(email, msg) {
  return pageHtml(`<h1>Check your email</h1><p>We sent a 6-digit code to ${escapeHtml(email)}. Enter it below.</p>
${msg ? `<div class="err">${escapeHtml(msg)}</div>` : ''}
<form method="POST" action="/auth/verify">
<input type="text" name="code" placeholder="123456" inputmode="numeric" autocomplete="one-time-code" autofocus required>
<button type="submit">Sign in</button></form>
<p style="margin-top:16px"><a href="/auth/login" style="color:#9aa0aa">Use a different email</a></p>`);
}

// ---------- email sending (SendGrid) ----------

async function sendCodeEmail(env, to, code) {
  const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.EMAIL_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: to }] }],
      from: { email: env.FROM_EMAIL, name: 'SnuggPro Inspector' },
      subject: `Your SnuggPro Inspector code: ${code}`,
      content: [{
        type: 'text/plain',
        value: `Your sign-in code is ${code}\n\nIt expires in 10 minutes. If you didn't request this, ignore this email.`,
      }],
    }),
  });
  if (!res.ok) {
    console.error('Email send failed', res.status, await res.text());
    throw new Error('email_send_failed');
  }
}

// ---------- auth helpers ----------

function allowedEmails(env) {
  return (env.ALLOWED_EMAILS || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
}

// Local-only escape hatch: set LOCAL_BYPASS_AUTH=true in .dev.vars (gitignored, never
// deployed) to skip the login gate under `wrangler dev`. There is no way to set this in
// production — it's not in wrangler.toml [vars] and must never be added there or via
// `wrangler secret put`.
function bypassAuth(env) {
  return env.LOCAL_BYPASS_AUTH === 'true';
}

async function currentSession(request, env) {
  const token = getCookie(request, 'session');
  const payload = await readToken(token, env.SESSION_SECRET);
  if (!payload || !payload.email) return null;
  // Re-check the allowlist on every request so removing an email takes effect immediately.
  if (!allowedEmails(env).includes(payload.email)) return null;
  return payload;
}

async function formField(request, name) {
  const form = await request.formData();
  const v = form.get(name);
  return typeof v === 'string' ? v.trim() : '';
}

// ---------- /programs: list available programs ----------

function handlePrograms(env) {
  const progs = PROGRAMS(env);
  const list = Object.entries(progs).map(([key, p]) => ({
    key, name: p.name, active: !!(p.pub && p.priv),
  }));
  return new Response(JSON.stringify(list), { headers: { 'Content-Type': 'application/json' } });
}

// ---------- /proxy: sign and forward to SnuggPro ----------

async function handleProxy(request, url, env) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204 });
  if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 });

  // Strip ?program= from the forwarded path; keep any other query params.
  const programKey = url.searchParams.get('program') || DEFAULT_PROGRAM;
  const cleanSearch = url.search.replace(/[?&]program=[^&]*/g, '').replace(/^&/, '?') || '';
  const path = url.pathname.replace(/^\/proxy/, '') + cleanSearch || '/';

  const progs = PROGRAMS(env);
  const prog = progs[programKey] || progs[DEFAULT_PROGRAM];
  if (!prog.pub || !prog.priv) {
    return new Response(JSON.stringify({ error: `No keys configured for program: ${programKey}` }), {
      status: 503, headers: { 'Content-Type': 'application/json' },
    });
  }

  const date = new Date().toISOString();                 // SAME value for signature and X-Date
  const sig = await hmacHex(date, prog.priv);
  const auth = `Credential=${prog.pub},Signature=${sig}`;

  console.log(`-> GET ${path} [${programKey}]`);
  try {
    const upstream = await fetch(`https://${SNUGG_HOST}${path}`, {
      headers: { 'Authorization': auth, 'X-Date': date, 'Content-Type': 'application/json' },
    });
    console.log(`<- ${upstream.status} ${path}`);
    return new Response(upstream.body, {
      status: upstream.status,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (e) {
    console.error('Upstream error:', e.message);
    return new Response(JSON.stringify({ error: e.message }), {
      status: 502, headers: { 'Content-Type': 'application/json' },
    });
  }
}

// ---------- worker entry ----------

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const p = url.pathname;

    // --- auth routes (always reachable) ---
    if (p === '/auth/login') {
      return htmlResponse(loginPage());
    }

    if (p === '/auth/logout') {
      return new Response(null, {
        status: 302,
        headers: { 'Location': '/auth/login', 'Set-Cookie': setCookie('session', '', 0) },
      });
    }

    if (p === '/auth/request-code' && request.method === 'POST') {
      const email = (await formField(request, 'email')).toLowerCase();
      if (!email || !allowedEmails(env).includes(email)) {
        // Neutral response — don't reveal who's on the allowlist.
        return htmlResponse(codePage(email || 'your email',
          'If that address is approved, a code is on its way.'));
      }
      const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1000000).padStart(6, '0');
      const codeHmac = await hmacHex(`${email}:${code}`, env.SESSION_SECRET);
      const otp = await makeToken({ email, codeHmac, exp: Date.now() + OTP_TTL_MS }, env.SESSION_SECRET);
      try {
        await sendCodeEmail(env, email, code);
      } catch (_) {
        return htmlResponse(loginPage('Could not send the code right now. Please try again.'));
      }
      return htmlResponse(codePage(email), [setCookie('otp', otp, Math.floor(OTP_TTL_MS / 1000))]);
    }

    if (p === '/auth/verify' && request.method === 'POST') {
      const code = await formField(request, 'code');
      const otpPayload = await readToken(getCookie(request, 'otp'), env.SESSION_SECRET);
      if (!otpPayload) {
        return htmlResponse(loginPage('Your code expired. Please request a new one.'));
      }
      const expected = await hmacHex(`${otpPayload.email}:${code}`, env.SESSION_SECRET);
      if (!safeEqual(expected, otpPayload.codeHmac)) {
        return htmlResponse(codePage(otpPayload.email, 'That code is incorrect. Try again.'));
      }
      const session = await makeToken({ email: otpPayload.email, exp: Date.now() + SESSION_TTL_MS },
        env.SESSION_SECRET);
      const headers = new Headers({ 'Location': '/' });
      headers.append('Set-Cookie', setCookie('session', session, Math.floor(SESSION_TTL_MS / 1000)));
      headers.append('Set-Cookie', setCookie('otp', '', 0));
      return new Response(null, { status: 302, headers });
    }

    // --- everything below requires a valid session ---
    const session = bypassAuth(env) ? { email: 'local-dev' } : await currentSession(request, env);
    if (!session) {
      return new Response(null, { status: 302, headers: { 'Location': '/auth/login' } });
    }

    if (p === '/programs') return handlePrograms(env);

    if (p.startsWith('/proxy')) return handleProxy(request, url, env);

    // Serve the static UI.
    return env.ASSETS.fetch(request);
  },
};
