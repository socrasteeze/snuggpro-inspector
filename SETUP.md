# SETUP — Hosting SnuggPro Inspector for your team

The one guide for getting the inspector online so your team can use it by clicking a link —
no install for them, no Node, no API keys on their machines. It runs as a free **Cloudflare
Worker** with **email one-time-code** login restricted to an allowlist you control.

> Following along to deploy? The numbered checklist in **[TODO.md](TODO.md)** mirrors this and
> is nicer to tick through. This file is the explanation; TODO.md is the run sheet.

---

## How it works (30-second mental model)

```
Teammate clicks the bookmarked URL
  → Cloudflare Worker checks for a login session
      → none?  shows a login page → they enter their email → get a 6-digit code → paste it
  → signed in: the Worker serves the UI and signs every SnuggPro API call on their behalf
```

- **One Worker does everything:** serves the UI (`public/index.html`), gates login, and signs
  `/proxy/*` requests to `api.snuggpro.com` (HMAC-SHA256). Same origin, so no CORS issues.
- **Multi-program:** the UI has a program switcher. Each request carries `?program=…` and the
  Worker signs it with that program's key pair. Programs: **Region 1**, **Region 2**, **SDGE**,
  **SCE** (default: Region 1). You only configure the ones you use.
- **Keys never live in the repo or on laptops** — they're stored as encrypted Cloudflare
  secrets. The team needs no keys at all.

---

## Prerequisites (the only things you provide)

1. **A free [SendGrid](https://sendgrid.com) account** — sends the login codes.
2. **A free [Cloudflare](https://dash.cloudflare.com/sign-up) account** — hosts the Worker.
3. **Your SnuggPro API key pairs** — one public + private key per program you use
   (Settings → App Integrations in SnuggPro). You already have these.
4. **Node.js** on your machine (only *you* need it, to run the deploy CLI).

No domain and no DNS/nameserver changes are required — the free `*.workers.dev` URL is used.

---

## 1. Install (one-time, your machine)

```bash
git clone <this repo>            # or: git checkout claude/team-api-caller-auth-2hjsiq
cd snuggpro-inspector
npm install                      # installs wrangler (the Cloudflare CLI)
npx wrangler login               # opens a browser to authorize your Cloudflare account
```

## 2. Set up the email sender (SendGrid)

1. Create the SendGrid account.
2. **Settings → Sender Authentication → Single Sender Verification** → add one "from" address
   (e.g. your work email) → click the link SendGrid emails you. **No DNS required.**
3. **Settings → API Keys → Create API Key** (Mail Send permission) → copy it somewhere safe.

## 3. Configure — two kinds of settings, two homes

**Non-secret settings → `wrangler.toml`** (committed to the repo):

```toml
[vars]
ALLOWED_EMAILS = "alice@acme.com,bob@acme.com"   # exactly who may sign in
FROM_EMAIL     = "you@acme.com"                   # the address you verified in SendGrid
```

**Secrets → Cloudflare secret store** (never in git), set with `wrangler secret put`:

| Secret | What it is |
|---|---|
| `REGION1_PUBLIC_KEY` / `REGION1_PRIVATE_KEY` | Region 1 – CA LIWP Farmworkers key pair |
| `REGION2_PUBLIC_KEY` / `REGION2_PRIVATE_KEY` | Region 2 – CA LIWP Farmworkers key pair |
| `SDGE_PUBLIC_KEY` / `SDGE_PRIVATE_KEY` | SDGE – Whole Home Program key pair |
| `SCE_PUBLIC_KEY` / `SCE_PRIVATE_KEY` | SCE/SCG ESA Whole Home key pair |
| `SESSION_SECRET` | random string that signs login cookies |
| `EMAIL_API_KEY` | your SendGrid API key |

Run each (it prompts you to paste the value — keeps it out of your shell history):

```bash
# only the programs you actually use need keys
npx wrangler secret put REGION1_PUBLIC_KEY
npx wrangler secret put REGION1_PRIVATE_KEY
npx wrangler secret put REGION2_PUBLIC_KEY
npx wrangler secret put REGION2_PRIVATE_KEY
npx wrangler secret put SDGE_PUBLIC_KEY
npx wrangler secret put SDGE_PRIVATE_KEY
npx wrangler secret put SCE_PUBLIC_KEY
npx wrangler secret put SCE_PRIVATE_KEY
npx wrangler secret put SESSION_SECRET   # generate one with the command below
npx wrangler secret put EMAIL_API_KEY    # your SendGrid key
```

Generate a `SESSION_SECRET`:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

> **Programs you skip just go dark.** Any program missing its keys shows as inactive in the
> switcher and refuses to sign — it never falls back to the wrong account.

## 4. Deploy

```bash
npx wrangler deploy
```

This prints your URL, e.g. `https://snuggpro-inspector.<subdomain>.workers.dev`. **That URL is
the product.**

## 5. Test it yourself first (incognito window)

1. Open the URL → you should see the login page.
2. Enter one of your `ALLOWED_EMAILS` → check email for the 6-digit code → paste it.
3. Fetch job **332046** → the Measures Table should show combined **967.82 kWh**.
4. Switch programs in the dropdown and confirm a fetch works for each program you configured.
5. (Optional) try a non-allowlisted email → it should be blocked.

## 6. Share with your team

Send them the URL to bookmark. Their entire experience: open it → type email → paste the code
→ use it. Nothing to install.

---

## Managing it later

**Add or remove a teammate** — edit `ALLOWED_EMAILS` in `wrangler.toml`, then:
```bash
npx wrangler deploy
```
Removal is immediate (the allowlist is re-checked on every request).

**Rotate a key** — regenerate it in SnuggPro, then re-run `wrangler secret put <NAME>` for that
key and `npx wrangler deploy`.

**Change the team's login emails** — same as add/remove above.

---

## Running it locally (only if you want to test changes before deploying)

```bash
cp .dev.vars.example .dev.vars   # fill in keys; this file is gitignored
npx wrangler dev                 # serves UI + login + proxy at http://localhost:8787
```

`.dev.vars` holds the same secrets/vars as production, just for local runs. (`proxy.js` on
`localhost:3001` remains as an offline solo fallback, but `wrangler dev` is the way to exercise
the full hosted experience locally.)

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| **Login email never arrives** | Check spam. Confirm `FROM_EMAIL` exactly matches your verified SendGrid sender, and `EMAIL_API_KEY` is set (`npx wrangler secret list`). |
| **"No keys configured for program: X"** | That program's `X_PUBLIC_KEY` / `X_PRIVATE_KEY` pair isn't set. Add it (Step 3) and redeploy, or use a different program. |
| **A job fetch returns 401/403 from SnuggPro** | The key pair for that program is wrong — re-check and re-`put` it. |
| **Everyone is blocked / can't log in** | Confirm their address is in `ALLOWED_EMAILS` and that you redeployed after editing it. |

---

## Security notes

- Keys live only as Cloudflare secrets — never in the repo, never on a teammate's machine.
- `.env` and `.dev.vars` are gitignored; don't commit them.
- Login is gated by `ALLOWED_EMAILS`, re-checked on every request, so removing someone +
  redeploy revokes access immediately.
- The 6-digit code is never stored in plaintext; sessions are stateless signed cookies.
- Without domain authentication, login emails can occasionally land in spam — have teammates
  mark "not spam" once. Adding SPF/DKIM **records** (not nameserver changes) at your registrar
  improves deliverability but is optional.
