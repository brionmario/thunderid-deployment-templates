/**
 * Copyright (c) 2026, WSO2 LLC. (https://www.wso2.com).
 * Apache License, Version 2.0
 *
 * Vercel serverless handler for ThunderID.
 *
 * Cold-start flow (once per Lambda container):
 *   1. Copy thunderid-bin/ (bundled at build time, pre-initialized) to /tmp/thunderid/
 *   2. Fill deployment.yaml placeholders from Vercel env vars
 *   3. Start the thunderid binary in the background
 *   4. Poll until port 8090 is accepting connections
 *
 * While starting up, every request gets a lightweight "warming up" page that
 * auto-refreshes every 5 seconds — so the Vercel function timeout never blocks
 * the cold start from completing.
 *
 * Once ready, all traffic is proxied transparently to localhost:8090.
 */

const http = require('http');
const https = require('https');
const net = require('net');
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const BIN_SRC = path.join(__dirname, 'thunderid-bin');
const WORK_DIR = '/tmp/thunderid';
const THUNDER_PORT = 8090;

function makeExecutable(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      makeExecutable(full);
    } else if (entry.isFile() && (entry.name === 'thunderid' || entry.name.endsWith('.sh'))) {
      fs.chmodSync(full, 0o755);
    }
  }
}

// ── State ─────────────────────────────────────────────────────────────────────
// Persists within a warm Lambda container across requests.
let status = 'idle'; // idle | starting | ready | failed
let startError = '';

// ── Helpers ───────────────────────────────────────────────────────────────────
function isPortOpen(port) {
  return new Promise(resolve => {
    const s = new net.Socket();
    s.setTimeout(1000);
    s.connect(port, '127.0.0.1', () => { s.destroy(); resolve(true); });
    s.on('error', () => { s.destroy(); resolve(false); });
    s.on('timeout', () => { s.destroy(); resolve(false); });
  });
}

async function pollUntilReady(port, intervalMs = 3000) {
  while (status === 'starting') {
    if (await isPortOpen(port)) {
      status = 'ready';
      return;
    }
    await new Promise(r => setTimeout(r, intervalMs));
  }
}

// ── Boot sequence ─────────────────────────────────────────────────────────────
function boot() {
  if (status !== 'idle') return;
  status = 'starting';

  (async () => {
    try {
      // 1. Copy bundled binary to /tmp (which is writable).
      if (!fs.existsSync(WORK_DIR)) {
        console.log('[thunderid] Copying binary to /tmp...');
        fs.mkdirSync(WORK_DIR, { recursive: true });
        execSync(`cp -r "${BIN_SRC}/." "${WORK_DIR}"`, { stdio: 'inherit' });
        makeExecutable(WORK_DIR);
      }

      // 2. Resolve public URL from Vercel env vars.
      let publicUrl = process.env.PUBLIC_URL || '';
      if (!publicUrl) {
        if (process.env.VERCEL_PROJECT_PRODUCTION_URL) {
          publicUrl = `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
        } else if (process.env.VERCEL_URL) {
          publicUrl = `https://${process.env.VERCEL_URL}`;
        } else {
          publicUrl = `http://localhost:${THUNDER_PORT}`;
        }
      }
      const publicHost = publicUrl.replace(/^https?:\/\//, '').replace(/[:/].*/, '');

      // 3. Fill placeholders in deployment.yaml.
      const yamlPath = path.join(WORK_DIR, 'deployment.yaml');
      let yaml = fs.readFileSync(yamlPath, 'utf8');
      yaml = yaml
        .replace(/__PUBLIC_URL__/g, publicUrl)
        .replace(/__PUBLIC_HOST__/g, publicHost);
      fs.writeFileSync(yamlPath, yaml);

      // 4. Patch frontend config.js files with the resolved host.
      if (publicHost !== 'localhost') {
        for (const rel of ['apps/console/config.js', 'apps/gate/config.js']) {
          const cfgPath = path.join(WORK_DIR, rel);
          if (fs.existsSync(cfgPath)) {
            let cfg = fs.readFileSync(cfgPath, 'utf8');
            cfg = cfg
              .replace(/hostname: '[^']*'/g, `hostname: '${publicHost}'`)
              .replace(/port: \d+/g, 'port: 443');
            fs.writeFileSync(cfgPath, cfg);
          }
        }
      }

      // 5. Start the server (databases already initialized at build time).
      console.log('[thunderid] Starting server...');
      const proc = spawn('bash', ['start.sh', '--without-consent'], {
        cwd: WORK_DIR,
        env: { ...process.env, BACKEND_PORT: String(THUNDER_PORT) },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      });
      proc.stdout.on('data', d => process.stdout.write(`[thunderid] ${d}`));
      proc.stderr.on('data', d => process.stderr.write(`[thunderid] ${d}`));
      proc.unref();

      // 6. Poll until ready.
      await pollUntilReady(THUNDER_PORT);
      console.log('[thunderid] Ready ✓');
    } catch (err) {
      status = 'failed';
      startError = err.message;
      console.error('[thunderid] Boot failed:', err);
    }
  })();
}

// ── Proxy ─────────────────────────────────────────────────────────────────────
function proxy(req, res) {
  const opts = {
    hostname: '127.0.0.1',
    port: THUNDER_PORT,
    path: req.url,
    method: req.method,
    headers: { ...req.headers, host: `localhost:${THUNDER_PORT}` },
    rejectUnauthorized: false, // ThunderID uses a self-signed cert on localhost
  };
  const upstream = https.request(opts, r => {
    res.writeHead(r.statusCode, r.headers);
    r.pipe(res, { end: true });
  });
  upstream.on('error', () => {
    if (!res.headersSent) res.writeHead(502);
    res.end('Bad Gateway');
  });
  req.pipe(upstream, { end: true });
}

// ── Loading page ──────────────────────────────────────────────────────────────
const LOADING_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="refresh" content="5">
<title>ThunderID — Starting…</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:#05213F;color:#fff;font-family:system-ui,sans-serif;
       display:flex;align-items:center;justify-content:center;min-height:100vh}
  .card{text-align:center;padding:2rem}
  .bolt{font-size:4rem;display:inline-block;animation:pulse 1.2s ease-in-out infinite}
  @keyframes pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.6;transform:scale(.9)}}
  h2{margin:.75rem 0 .5rem;font-size:1.5rem}
  p{color:#9ab;font-size:.9rem}
</style>
</head>
<body>
<div class="card">
  <div class="bolt">⚡</div>
  <h2>ThunderID is starting up…</h2>
  <p>First start takes 1–2 minutes. This page refreshes automatically.</p>
</div>
</body>
</html>`;

// ── Vercel handler ────────────────────────────────────────────────────────────
module.exports = (req, res) => {
  if (status === 'idle') boot();

  if (status === 'ready') {
    proxy(req, res);
    return;
  }

  if (status === 'failed') {
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end(`ThunderID failed to start: ${startError}\nCheck function logs.`);
    return;
  }

  // starting — return auto-refresh loading page
  res.writeHead(503, { 'Content-Type': 'text/html', 'Retry-After': '5' });
  res.end(LOADING_HTML);
};
