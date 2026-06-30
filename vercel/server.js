/**
 * Copyright (c) 2026, WSO2 LLC. (https://www.wso2.com).
 * Apache License, Version 2.0
 *
 * Vercel serverless handler for ThunderID.
 *
 * Cold-start flow (once per Lambda container):
 *   1. Copy thunderid-bin/ (bundled at build time, pre-initialized) to /tmp/thunderid/
 *   2. Resolve public URL from Vercel env vars
 *   3. Write repository/conf/deployment.yaml with runtime URL, CORS, TLS config,
 *      and database config (PostgreSQL/Supabase when SUPABASE_HOST+SUPABASE_PASSWORD
 *      are set; otherwise bundled SQLite)
 *   4. SQLite only: update console app redirect URI in configdb.db (sqlite3, if available)
 *   5. Patch apps/console/config.js and apps/gate/config.js with public hostname
 *   6. Spawn `bash start.sh --without-consent` in the background
 *   7. Poll until port 8090 accepts connections
 *
 * Requests that arrive while ThunderID is starting wait inline (async) until
 * it is ready, then get proxied. No loading-page redirect loop.
 */

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

// ── PostgreSQL / Supabase runtime detection ────────────────────────────────────
// Set DATABASE_URL to a full PostgreSQL connection string (preferred — supports the
// Supabase connection pooler which resolves to IPv4).
// Alternatively set individual SUPABASE_* env vars.
function parsePgConfig() {
  if (process.env.DATABASE_URL) {
    const raw = process.env.DATABASE_URL;
    const u = new URL(raw.replace(/^postgres:\/\//, 'postgresql://'));
    return {
      host:     u.hostname,
      port:     parseInt(u.port || '5432', 10),
      database: u.pathname.replace(/^\//, '') || 'postgres',
      user:     decodeURIComponent(u.username),
      password: decodeURIComponent(u.password),
      sslMode:  'require',
    };
  }
  return {
    host:     process.env.SUPABASE_HOST     || '',
    port:     parseInt(process.env.SUPABASE_PORT || '5432', 10),
    database: process.env.SUPABASE_DB       || 'postgres',
    user:     process.env.SUPABASE_USER     || 'postgres',
    password: process.env.SUPABASE_PASSWORD || '',
    sslMode:  process.env.SUPABASE_SSL_MODE || 'require',
  };
}

const pgCfg         = parsePgConfig();
const USE_SUPABASE  = !!(pgCfg.host && pgCfg.password);
const SUPABASE_HOST = pgCfg.host;
const SUPABASE_PORT = pgCfg.port;
const SUPABASE_DB   = pgCfg.database;
const SUPABASE_USER = pgCfg.user;
const SUPABASE_PASSWORD = pgCfg.password;
const SUPABASE_SSL_MODE = pgCfg.sslMode;

// Auto-switch from Supabase direct host (IPv6-only) to the connection pooler (IPv4).
// Identical logic to build.js — any regional pooler routes connections via username.
async function resolveEffectivePostgres(host, user) {
  const { resolve4 } = require('dns').promises;
  try {
    await resolve4(host);
    return { yamlHost: host, user };
  } catch {}

  const match = host.match(/^db\.([a-z0-9]+)\.supabase\.co$/i);
  if (!match) return { yamlHost: host, user };

  const ref = match[1];
  const poolerUser = (user === 'postgres' || !user.includes('.')) ? `postgres.${ref}` : user;
  const regions = [
    'us-east-1', 'ap-southeast-1', 'ap-south-1', 'eu-west-1', 'us-west-1',
    'ap-northeast-1', 'eu-central-1', 'sa-east-1', 'ap-southeast-2',
  ];
  for (const region of regions) {
    for (const prefix of ['aws-0', 'aws-1']) {
      const poolerHost = `${prefix}-${region}.pooler.supabase.com`;
      try {
        await resolve4(poolerHost);
        console.log(`[thunderid] Direct host is IPv6-only — auto-using pooler ${poolerHost} (user: ${poolerUser})`);
        return { yamlHost: poolerHost, user: poolerUser };
      } catch {}
    }
  }
  return { yamlHost: host, user };
}

function postgresBlock(host, port, dbName, user, password, sslMode) {
  return `type: "postgres"
    postgres:
      hostname: "${host}"
      port: ${port}
      name: "${dbName}"
      username: "${user}"
      password: "${password}"
      sslmode: "${sslMode}"
      max_open_conns: 5
      max_idle_conns: 2
      conn_max_lifetime: 3600
      max_retries: 3
      min_retry_backoff_ms: 50
      max_retry_backoff_ms: 2000`;
}

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
let resolvedPublicUrl = '';
// The redirect URI that was registered in the database at build time.
// If it differs from the runtime Vercel URL, the proxy rewrites OIDC params.
let registeredConsoleUri = '';

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
      resolvedPublicUrl = publicUrl;
      console.log('[thunderid] Public URL:', publicUrl);

      // 3. Write repository/conf/deployment.yaml — ThunderID reads THIS file at startup.
      //    Database config depends on whether Supabase env vars are set.
      let dbSection;
      if (USE_SUPABASE) {
        const { yamlHost: pgHost, user: pgUser } =
          await resolveEffectivePostgres(SUPABASE_HOST, SUPABASE_USER);
        const pg = postgresBlock(pgHost, SUPABASE_PORT, SUPABASE_DB, pgUser, SUPABASE_PASSWORD, SUPABASE_SSL_MODE);
        dbSection = `database:
  config:
    ${pg}
  runtime:
    ${pg}
  user:
    ${pg}`;
        console.log(`[thunderid] Using Supabase (PostgreSQL) at ${pgHost}:${SUPABASE_PORT}`);
      } else {
        dbSection = `database:
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
      conn_max_lifetime: 3600`;
      }

      const repoConfYaml = `server:
  hostname: "localhost"
  port: ${THUNDER_PORT}
  public_url: "${publicUrl}"

tls:
  min_version: "1.3"
  cert_file: "repository/resources/security/server.cert"
  key_file: "repository/resources/security/server.key"

${dbSection}

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

      // 4. Redirect URI reconciliation.
      //    With Supabase the redirect URI is stored in the external DB and was registered
      //    at build time; no local patching is needed.
      //    With SQLite we may need to patch the bundled configdb.db.
      const setupUrlFile = path.join(WORK_DIR, '.vercel-setup-url');
      const runtimeUri = `${publicUrl}/console`;

      if (!USE_SUPABASE) {
        const dbPath = path.join(WORK_DIR, 'repository', 'database', 'configdb.db');
        const setupUrl = fs.existsSync(setupUrlFile)
          ? fs.readFileSync(setupUrlFile, 'utf8').trim()
          : 'https://localhost:8090';
        const registeredUri = `${setupUrl}/console`;

        if (registeredUri !== runtimeUri) {
          let dbFixed = false;
          if (fs.existsSync(dbPath)) {
            const sql = `UPDATE OAUTH_INBOUND_PROFILE SET OAUTH_CONFIG = json_set(OAUTH_CONFIG, '$.redirectUris[0]', '${runtimeUri}') WHERE json_extract(OAUTH_CONFIG, '$.clientId') = 'CONSOLE';`;
            try {
              execSync(`sqlite3 "${dbPath}" "${sql}"`, { stdio: 'pipe' });
              console.log('[thunderid] Updated console redirect URI to', runtimeUri);
              dbFixed = true;
            } catch (e) {
              console.log('[thunderid] sqlite3 not available:', (e.message || '').split('\n')[0]);
            }
          }
          if (!dbFixed) {
            registeredConsoleUri = registeredUri;
            console.log('[thunderid] Proxy will rewrite redirect_uri:', registeredUri, '↔', runtimeUri);
          }
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
// When registeredConsoleUri differs from the runtime URL (old builds), the proxy
// rewrites redirect_uri in OIDC authorization/token requests so ThunderID sees
// the URI it has registered, and rewrites localhost in responses back to the
// public Vercel URL. This is a no-op once build.js registers the correct URI.
function proxy(req, res) {
  // URL-encoded forms of the two URIs (only set when rewriting is needed).
  const fromEnc = registeredConsoleUri ? encodeURIComponent(`${resolvedPublicUrl}/console`) : null;
  const toEnc   = registeredConsoleUri ? encodeURIComponent(registeredConsoleUri) : null;

  // Rewrite redirect_uri in GET query strings (e.g. /oauth2/authorize).
  const reqPath = fromEnc && req.url.includes(fromEnc)
    ? req.url.split(fromEnc).join(toEnc)
    : req.url;

  const makeUpstream = (bodyBuf) => {
    const headers = { ...req.headers };
    if (bodyBuf !== null) {
      // We've buffered and potentially rewritten the body; set the correct length.
      headers['content-length'] = String(bodyBuf.length);
      delete headers['transfer-encoding'];
    }
    const opts = {
      hostname: '127.0.0.1',
      port: THUNDER_PORT,
      path: reqPath,
      method: req.method,
      headers,
      rejectUnauthorized: false, // ThunderID uses a self-signed cert on localhost
    };
    const upstream = https.request(opts, r => {
      const respHeaders = { ...r.headers };
      // Rewrite any localhost URLs in Location headers back to the public URL.
      if (respHeaders.location && resolvedPublicUrl) {
        respHeaders.location = respHeaders.location
          .replace(/https?:\/\/localhost(?::\d+)?/g, resolvedPublicUrl);
      }
      res.writeHead(r.statusCode, respHeaders);
      r.pipe(res, { end: true });
    });
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502);
      res.end('Bad Gateway');
    });
    if (bodyBuf !== null) {
      upstream.write(bodyBuf);
      upstream.end();
    } else {
      req.pipe(upstream, { end: true });
    }
  };

  // Buffer POST bodies to /oauth2/token so we can rewrite redirect_uri there too.
  if (req.method === 'POST' && fromEnc && req.url.startsWith('/oauth2/token')) {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      let body = Buffer.concat(chunks).toString('utf8');
      if (body.includes(fromEnc)) body = body.split(fromEnc).join(toEnc);
      makeUpstream(Buffer.from(body, 'utf8'));
    });
  } else {
    makeUpstream(null);
  }
}

// ── Vercel handler ────────────────────────────────────────────────────────────
// Async so we can wait inline for ThunderID to finish starting instead of
// returning a 503 loading page (which spawns extra cold-start containers).
module.exports = async (req, res) => {
  if (status === 'idle') boot();

  // Wait up to 90 s for ThunderID to become ready. ThunderID typically starts
  // in ~6 s; 90 s gives plenty of headroom without hitting the 300 s limit.
  if (status === 'starting') {
    const deadline = Date.now() + 90000;
    while (status === 'starting' && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 250));
    }
  }

  if (status === 'ready') {
    proxy(req, res);
    return;
  }

  if (status === 'failed') {
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end(`ThunderID failed to start: ${startError}\nCheck function logs.`);
    return;
  }

  // Timed out waiting (should be rare) — give the browser a plain retry page.
  res.writeHead(503, { 'Content-Type': 'text/html', 'Retry-After': '10' });
  res.end(`<!DOCTYPE html><html><head><meta charset="utf-8">
<meta http-equiv="refresh" content="10">
<title>ThunderID — Starting…</title>
<style>body{background:#05213F;color:#fff;font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.c{text-align:center}.b{font-size:4rem;animation:p 1.2s ease-in-out infinite}
@keyframes p{0%,100%{opacity:1}50%{opacity:.4}}h2{margin:.5rem 0}p{color:#9ab}</style>
</head><body><div class="c"><div class="b">⚡</div>
<h2>ThunderID is starting…</h2><p>This page refreshes automatically.</p></div></body></html>`);
};
