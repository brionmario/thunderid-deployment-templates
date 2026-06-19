/**
 * Copyright (c) 2026, WSO2 LLC. (https://www.wso2.com).
 * Apache License, Version 2.0
 *
 * Vercel serverless handler for ThunderID.
 *
 * Cold-start flow (once per Lambda container):
 *   1. Copy thunderid-bin/ (bundled at build time, pre-initialized) to /tmp/thunderid/
 *   2. Resolve public URL from Vercel env vars
 *   3. Write repository/conf/deployment.yaml with runtime URL, CORS, and TLS config
 *   4. Update console app redirect URI in configdb.db (sqlite3)
 *   5. Patch apps/console/config.js and apps/gate/config.js with public hostname
 *   6. Spawn `bash start.sh --without-consent` in the background
 *   7. Poll until port 8090 accepts connections
 *
 * While starting up, every incoming request gets a lightweight "warming up" page
 * that auto-refreshes every 5 seconds so the cold start can finish without hitting
 * Vercel's function timeout.
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

// ThunderID reads this path for its runtime config (not the root deployment.yaml).
const REPO_CONF = path.join(WORK_DIR, 'repository', 'conf', 'deployment.yaml');

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
      // 1. Copy bundled binary to /tmp (writable in Lambda).
      if (!fs.existsSync(WORK_DIR)) {
        console.log('[thunderid] Copying binary to /tmp...');
        fs.mkdirSync(WORK_DIR, { recursive: true });
        execSync(`cp -r "${BIN_SRC}/." "${WORK_DIR}"`, { stdio: 'inherit' });
        makeExecutable(WORK_DIR);
      }

      // 2. Resolve public URL from Vercel environment.
      let publicUrl = process.env.PUBLIC_URL || '';
      if (!publicUrl) {
        if (process.env.VERCEL_PROJECT_PRODUCTION_URL) {
          publicUrl = `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
        } else if (process.env.VERCEL_URL) {
          publicUrl = `https://${process.env.VERCEL_URL}`;
        } else {
          publicUrl = `https://localhost:${THUNDER_PORT}`;
        }
      }
      const publicHost = publicUrl.replace(/^https?:\/\//, '').replace(/[:/].*/, '');
      console.log('[thunderid] Public URL:', publicUrl);

      // 3. Write repository/conf/deployment.yaml — ThunderID reads THIS file at startup,
      //    not the root deployment.yaml. We overwrite it with the runtime public URL,
      //    CORS, and passkey settings while preserving TLS cert paths.
      const repoConfYaml = `server:
  hostname: "localhost"
  port: ${THUNDER_PORT}
  public_url: "${publicUrl}"

tls:
  min_version: "1.3"
  cert_file: "repository/resources/security/server.cert"
  key_file: "repository/resources/security/server.key"

database:
  config:
    type: "sqlite"
    sqlite:
      path: "repository/database/configdb.db"
      options: "_journal_mode=WAL&_busy_timeout=5000&_pragma=foreign_keys(1)"
      max_open_conns: 500
      max_idle_conns: 100
      conn_max_lifetime: 3600
  runtime:
    type: "sqlite"
    sqlite:
      path: "repository/database/runtimedb.db"
      options: "_journal_mode=WAL&_busy_timeout=5000&_pragma=foreign_keys(1)"
      max_open_conns: 500
      max_idle_conns: 100
      conn_max_lifetime: 3600
  user:
    type: "sqlite"
    sqlite:
      path: "repository/database/userdb.db"
      options: "_journal_mode=WAL&_busy_timeout=5000&_pragma=foreign_keys(1)"
      max_open_conns: 500
      max_idle_conns: 100
      conn_max_lifetime: 3600

crypto:
  encryption:
    key: "file://repository/resources/security/crypto.key"
  password_hashing:
    algorithm: "PBKDF2"
  keys:
    - id: "default-key"
      cert_file: "repository/resources/security/signing.cert"
      key_file: "repository/resources/security/signing.key"

jwt:
    preferred_key_id: "default-key"

cors:
  allowed_origins:
    - "${publicUrl}"

passkey:
  allowed_origins:
    - "${publicUrl}"

consent:
  enabled: false
`;
      fs.writeFileSync(REPO_CONF, repoConfYaml);
      console.log('[thunderid] Wrote runtime repository/conf/deployment.yaml');

      // 4. Update the Console application's redirect URI in configdb.db.
      //    During build-time setup, the redirect URI was registered as
      //    https://localhost:8090/console. At runtime on Vercel, the browser
      //    sends the Vercel URL as redirect_uri, which causes an OIDC mismatch.
      //    We patch the stored URI before ThunderID starts so it validates correctly.
      const dbPath = path.join(WORK_DIR, 'repository', 'database', 'configdb.db');
      if (fs.existsSync(dbPath) && publicUrl !== 'https://localhost:8090') {
        const runtimeUri = `${publicUrl}/console`;
        const sql = `UPDATE OAUTH_INBOUND_PROFILE SET OAUTH_CONFIG = json_set(OAUTH_CONFIG, '$.redirectUris[0]', '${runtimeUri}') WHERE json_extract(OAUTH_CONFIG, '$.clientId') = 'CONSOLE';`;
        try {
          execSync(`sqlite3 "${dbPath}" "${sql}"`, { stdio: 'pipe' });
          console.log('[thunderid] Updated console redirect URI to', runtimeUri);
        } catch (e) {
          console.log('[thunderid] sqlite3 redirect URI update skipped:', (e.message || '').split('\n')[0]);
        }
      }

      // 5. Patch frontend config.js files so the browser talks to the Vercel URL.
      for (const rel of ['apps/console/config.js', 'apps/gate/config.js']) {
        const cfgPath = path.join(WORK_DIR, rel);
        if (fs.existsSync(cfgPath)) {
          let cfg = fs.readFileSync(cfgPath, 'utf8');
          cfg = cfg
            .replace(/hostname: '[^']*'/g, `hostname: '${publicHost}'`)
            .replace(/port: \d+/g, 'port: 443')
            .replace(/http_only: (true|false)/g, 'http_only: false');
          fs.writeFileSync(cfgPath, cfg);
          console.log('[thunderid] Patched', rel);
        }
      }

      // 6. Start the server (databases already initialized at build time).
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

      // 7. Poll until port 8090 accepts connections.
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
