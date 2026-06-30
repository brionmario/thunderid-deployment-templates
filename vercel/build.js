/**
 * Copyright (c) 2026, WSO2 LLC. (https://www.wso2.com).
 * Apache License, Version 2.0
 *
 * Vercel build-time script.
 * Downloads the latest ThunderID Linux x64 release and extracts it to
 * ./thunderid-bin/ so it can be bundled into the serverless function via
 * vercel.json's `includeFiles`.  Runs during `vercel build` — never at
 * request time.
 */

const https = require('https');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const RELEASES_URL = 'https://brionmario.github.io/thunderid/data/releases.json';
const OUT_DIR = path.join(__dirname, 'thunderid-bin');

// ── PostgreSQL / Supabase support ─────────────────────────────────────────────
// Set DATABASE_URL to a full PostgreSQL connection string (preferred — supports the
// Supabase connection pooler which resolves to IPv4, avoiding ENETUNREACH on Vercel).
// Alternatively set individual SUPABASE_* vars (only works if the host has an A record).
//
// In the Supabase dashboard go to Settings → Database → Connection String → URI and
// choose the "Session mode" pooler URL:
//   postgres://postgres.[ref]:[password]@aws-0-[region].pooler.supabase.com:5432/postgres
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

const pgCfg        = parsePgConfig();
const USE_SUPABASE = !!(pgCfg.host && pgCfg.password);
// Convenience aliases kept for the rest of the file
const SUPABASE_HOST     = pgCfg.host;
const SUPABASE_PORT     = pgCfg.port;
const SUPABASE_DB       = pgCfg.database;
const SUPABASE_USER     = pgCfg.user;
const SUPABASE_PASSWORD = pgCfg.password;
const SUPABASE_SSL_MODE = pgCfg.sslMode;

// Shared postgres block for all three logical databases (they share one Supabase instance
// but have non-overlapping table names, so the same connection details work for all).
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

// Vercel-aware deployment.yaml — placeholders filled at runtime by server.js.
const DEPLOYMENT_YAML = `server:
  hostname: "0.0.0.0"
  port: 8090
  http_only: true
  public_url: "__PUBLIC_URL__"

gate_client:
  hostname: "__PUBLIC_HOST__"
  port: 443
  scheme: "https"
  path: "/gate"

database:
  config:
    type: "sqlite"
    sqlite:
      path: "database/configdb.db"
      options: "_journal_mode=WAL&_busy_timeout=5000&_pragma=foreign_keys(1)"
      max_open_conns: 500
      max_idle_conns: 100
      conn_max_lifetime: 3600
  runtime:
    type: "sqlite"
    sqlite:
      path: "database/runtimedb.db"
      options: "_journal_mode=WAL&_busy_timeout=5000&_pragma=foreign_keys(1)"
      max_open_conns: 500
      max_idle_conns: 100
      conn_max_lifetime: 3600
  user:
    type: "sqlite"
    sqlite:
      path: "database/userdb.db"
      options: "_journal_mode=WAL&_busy_timeout=5000&_pragma=foreign_keys(1)"
      max_open_conns: 500
      max_idle_conns: 100
      conn_max_lifetime: 3600

crypto:
  encryption:
    key: "file://config/certs/crypto.key"
  password_hashing:
    algorithm: "PBKDF2"
  keys:
    - id: "default-key"
      cert_file: "config/certs/signing.cert"
      key_file: "config/certs/signing.key"

jwt:
  preferred_key_id: "default-key"

cors:
  allowed_origins:
    - "__PUBLIC_URL__"

passkey:
  allowed_origins:
    - "__PUBLIC_URL__"

consent:
  enabled: false
`;

// Deployment YAML template for PostgreSQL/Supabase mode.
// Unlike the SQLite template, database credentials come from env vars at runtime
// (server.js builds this YAML dynamically), so this is just a sentinel marker.
const DEPLOYMENT_YAML_POSTGRES_SENTINEL = '# thunderid-db-mode: postgres\n';

// Supabase direct-connection hostnames (db.{ref}.supabase.co) have no IPv4 A record —
// only AAAA (IPv6). Vercel build/lambda containers can't route IPv6 → ENETUNREACH.
// When we detect this, auto-switch to the Supabase connection pooler, which has IPv4.
// The pooler routes by username (postgres.{ref}), so any regional endpoint works.
async function resolveEffectivePostgres(host, user) {
  const { resolve4 } = require('dns').promises;

  try {
    await resolve4(host);
    return { clientHost: host, yamlHost: host, user };
  } catch {}

  const match = host.match(/^db\.([a-z0-9]+)\.supabase\.co$/i);
  if (!match) {
    console.warn(`[supabase] Warning: ${host} has no IPv4 A record — connection may fail`);
    return { clientHost: host, yamlHost: host, user };
  }

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
        const [ipv4] = await resolve4(poolerHost);
        console.log(`[supabase] Direct host is IPv6-only — auto-using pooler ${poolerHost} (user: ${poolerUser})`);
        return { clientHost: ipv4, yamlHost: poolerHost, user: poolerUser };
      } catch {}
    }
  }

  console.warn(`[supabase] Warning: no IPv4 pooler found for project ${ref} — connection may fail`);
  return { clientHost: host, yamlHost: host, user };
}

// Runs the three postgres.sql migration scripts from the extracted release bundle
// against Supabase. Each CREATE TABLE / INDEX is prefixed with IF NOT EXISTS so
// re-deploys are safe. Returns { yamlHost, effectiveUser } for use in deployment YAML.
async function runSupabaseMigrations() {
  const { Client } = require('pg');

  const { clientHost, yamlHost, user: effectiveUser } =
    await resolveEffectivePostgres(SUPABASE_HOST, SUPABASE_USER);

  const client = new Client({
    host: clientHost,
    port: SUPABASE_PORT,
    database: SUPABASE_DB,
    user: effectiveUser,
    password: SUPABASE_PASSWORD,
    ssl: { rejectUnauthorized: false },
  });

  await client.connect();
  console.log('[supabase] Connected — running database migrations...');

  // Order matters: userdb has no cross-db FK deps; configdb references nothing in runtime.
  const scripts = [
    path.join(OUT_DIR, 'dbscripts', 'userdb',    'postgres.sql'),
    path.join(OUT_DIR, 'dbscripts', 'runtimedb', 'postgres.sql'),
    path.join(OUT_DIR, 'dbscripts', 'configdb',  'postgres.sql'),
  ];

  try {
    for (const sqlPath of scripts) {
      const label = `${path.basename(path.dirname(sqlPath))}/postgres.sql`;
      console.log(`[supabase] Applying ${label}...`);
      // Make every CREATE TABLE and CREATE INDEX idempotent so re-deploys don't error.
      const sql = fs.readFileSync(sqlPath, 'utf8')
        .replace(/CREATE TABLE "/g,        'CREATE TABLE IF NOT EXISTS "')
        .replace(/CREATE INDEX /g,         'CREATE INDEX IF NOT EXISTS ')
        .replace(/CREATE UNIQUE INDEX /g,  'CREATE UNIQUE INDEX IF NOT EXISTS ');
      await client.query(sql);
      console.log(`[supabase] ✓ ${label}`);
    }
  } finally {
    await client.end();
  }

  console.log('[supabase] All migrations applied.');
  return { yamlHost, effectiveUser };
}

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'thunderid-vercel-build' } }, res => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return get(res.headers.location).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

async function main() {
  console.log('Fetching ThunderID release metadata...');
  const data = JSON.parse(await get(RELEASES_URL));
  const tag = data.latestRelease.tagName;
  const version = tag.replace(/^v/, '');
  const assetName = `thunderid-${version}-linux-x64.zip`;
  const asset = data.latestRelease.assets.find(a => a.name === assetName);

  if (!asset) {
    throw new Error(`Asset ${assetName} not found in release ${tag}`);
  }

  console.log(`Downloading ThunderID ${tag} (${assetName})...`);
  const zipBuf = await get(asset.downloadUrl);
  const zipPath = path.join(__dirname, assetName);
  fs.writeFileSync(zipPath, zipBuf);
  console.log(`Downloaded ${(zipBuf.length / 1024 / 1024).toFixed(1)} MB`);

  if (fs.existsSync(OUT_DIR)) {
    fs.rmSync(OUT_DIR, { recursive: true });
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });

  console.log('Extracting...');
  execSync(`unzip -q "${zipPath}" -d "${OUT_DIR}"`, { stdio: 'inherit' });

  // The zip contains a single top-level directory; flatten it.
  const [inner] = fs.readdirSync(OUT_DIR);
  const innerPath = path.join(OUT_DIR, inner);
  for (const entry of fs.readdirSync(innerPath)) {
    fs.renameSync(path.join(innerPath, entry), path.join(OUT_DIR, entry));
  }
  fs.rmdirSync(innerPath);

  // Replace the bundled deployment.yaml with the Vercel-aware template.
  // In postgres mode we use a sentinel — server.js builds the real YAML at runtime.
  fs.writeFileSync(
    path.join(OUT_DIR, 'deployment.yaml'),
    USE_SUPABASE ? DEPLOYMENT_YAML_POSTGRES_SENTINEL : DEPLOYMENT_YAML,
  );

  // Ensure scripts and binary are executable.
  for (const f of ['thunderid', 'setup.sh', 'start.sh']) {
    const p = path.join(OUT_DIR, f);
    if (fs.existsSync(p)) fs.chmodSync(p, 0o755);
  }
  for (const f of fs.readdirSync(path.join(OUT_DIR, 'bootstrap') )) {
    fs.chmodSync(path.join(OUT_DIR, 'bootstrap', f), 0o755);
  }

  fs.unlinkSync(zipPath);

  // /dev/fd is needed by bash process substitution (<(...)).
  // Try to create it as a symlink to /proc/self/fd (works if /dev is writable).
  // If that fails, fall back to patching bootstrap scripts directly.
  const devFdOk = fs.existsSync('/dev/fd');
  console.log(`/dev/fd: ${devFdOk ? 'present' : 'missing'}, /proc/self/fd: ${fs.existsSync('/proc/self/fd') ? 'present' : 'missing'}`);
  if (!devFdOk) {
    try {
      execSync('ln -sf /proc/self/fd /dev/fd', { stdio: 'pipe' });
      console.log('Created /dev/fd -> /proc/self/fd');
    } catch (e) {
      console.log('Could not create /dev/fd:', e.message.split('\n')[0]);
    }
  }

  // Patch bootstrap script — replace bash process substitution with temp-file reads.
  // Runs regardless of /dev/fd status as a belt-and-suspenders fix.
  const bootstrapScript = path.join(OUT_DIR, 'bootstrap', '01-default-resources.sh');
  if (fs.existsSync(bootstrapScript)) {
    let src = fs.readFileSync(bootstrapScript, 'utf8');
    const MARKER = 'done < <(echo "$BODY"';
    console.log(`Bootstrap script process substitution present: ${src.includes(MARKER)}`);
    if (src.includes(MARKER)) {
      // Replace each: done < <(echo "$BODY" | grep -o '...')
      // With:         done < /tmp/_thunder_psub
      src = src.replace(/done < <\(echo "\$BODY"[^)]+\)/g, 'done < /tmp/_thunder_psub');
      // Insert temp-file population before each matching while loop.
      // The `|| true` is critical: grep exits 1 when no matches found, which
      // would kill the script under `set -e`. The original process substitution
      // returned an empty stream silently; we must replicate that behaviour.
      src = src.replace(/while IFS= read -r line; do/g,
        'echo "$BODY" | grep -o \'{[^}]*"id":"[^"]*"[^}]*"handle":"[^"]*"[^}]*}\' > /tmp/_thunder_psub || true\nwhile IFS= read -r line; do');
      fs.writeFileSync(bootstrapScript, src);
      console.log('Patched 01-default-resources.sh (replaced process substitution with temp files)');
    }
  }

  // Run setup at build time so the function only needs to start the server.
  console.log('Running ThunderID setup (build-time)...');

  // PUBLIC_URL tells setup.sh what URL to register for the Console app's redirect URI.
  const setupPublicUrl = process.env.VERCEL_PROJECT_PRODUCTION_URL
    ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
    : '';
  if (setupPublicUrl) {
    console.log(`Using PUBLIC_URL for setup: ${setupPublicUrl}`);
  }

  if (USE_SUPABASE) {
    // ── PostgreSQL / Supabase setup ──────────────────────────────────────────
    // 1. Apply schema migrations (idempotent — safe to re-run on every deploy).
    //    resolveEffectivePostgres auto-switches to the pooler if the direct host
    //    is IPv6-only (db.{ref}.supabase.co) and Vercel can't route IPv6.
    console.log(`[supabase] Using PostgreSQL at ${SUPABASE_HOST}:${SUPABASE_PORT}/${SUPABASE_DB}`);
    const { yamlHost: pgYamlHost, effectiveUser: pgEffectiveUser } = await runSupabaseMigrations();

    // 2. Configure deployment.yaml to use Supabase so setup.sh seeds the external DB.
    const pg = postgresBlock(pgYamlHost, SUPABASE_PORT, SUPABASE_DB, pgEffectiveUser, SUPABASE_PASSWORD, SUPABASE_SSL_MODE);
    const setupYamlPg = `server:
  hostname: "localhost"
  port: 8090
  http_only: true
  public_url: "${setupPublicUrl || 'http://localhost:8090'}"

gate_client:
  hostname: "${setupPublicUrl ? setupPublicUrl.replace(/^https?:\/\//, '') : 'localhost'}"
  port: ${setupPublicUrl ? 443 : 8090}
  scheme: "${setupPublicUrl ? 'https' : 'http'}"
  path: "/gate"

database:
  config:
    ${pg}
  runtime:
    ${pg}
  user:
    ${pg}

crypto:
  encryption:
    key: "file://config/certs/crypto.key"
  password_hashing:
    algorithm: "PBKDF2"
  keys:
    - id: "default-key"
      cert_file: "config/certs/signing.cert"
      key_file: "config/certs/signing.key"

jwt:
  preferred_key_id: "default-key"

cors:
  allowed_origins:
    - "${setupPublicUrl || 'http://localhost:8090'}"

consent:
  enabled: false
`;
    fs.writeFileSync(path.join(OUT_DIR, 'deployment.yaml'), setupYamlPg);
  } else {
    // ── SQLite setup ─────────────────────────────────────────────────────────
    const setupYaml = DEPLOYMENT_YAML
      .replace(/__PUBLIC_URL__/g, 'http://localhost:8090')
      .replace(/__PUBLIC_HOST__/g, 'localhost')
      .replace('hostname: "0.0.0.0"', 'hostname: "localhost"');
    fs.writeFileSync(path.join(OUT_DIR, 'deployment.yaml'), setupYaml);
  }

  execSync('bash setup.sh', {
    cwd: OUT_DIR,
    stdio: 'inherit',
    env: {
      ...process.env,
      ADMIN_USERNAME: process.env.ADMIN_USERNAME || 'admin',
      ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || 'admin',
      THUNDER_SKIP_SECURITY: 'true',
      ...(setupPublicUrl ? { PUBLIC_URL: setupPublicUrl } : {}),
    },
  });

  // Kill any process setup.sh left running
  try { execSync('pkill -f thunderid', { stdio: 'pipe' }); } catch {}
  try { execSync('fuser -k 8090/tcp 2>/dev/null', { stdio: 'pipe' }); } catch {}
  try { execSync('fuser -k 9090/tcp 2>/dev/null', { stdio: 'pipe' }); } catch {}

  if (USE_SUPABASE) {
    // ── PostgreSQL post-setup ────────────────────────────────────────────────
    // Data is in Supabase — no local SQLite files to patch.
    // Record db mode so server.js uses postgres at runtime.
    fs.writeFileSync(path.join(OUT_DIR, '.vercel-db-mode'), 'postgres');
    fs.writeFileSync(path.join(OUT_DIR, '.vercel-setup-url'), setupPublicUrl || 'http://localhost:8090');
    // Restore the postgres sentinel as the bundled deployment.yaml.
    fs.writeFileSync(path.join(OUT_DIR, 'deployment.yaml'), DEPLOYMENT_YAML_POSTGRES_SENTINEL);
    console.log('[supabase] Supabase seeded successfully — SQLite databases not bundled.');
  } else {
    // ── SQLite post-setup ────────────────────────────────────────────────────
    // setup.sh always registers https://localhost:8090/console because it reads
    // repository/conf/deployment.yaml (the binary's default TLS+localhost config).
    // Fix: patch the database directly at build time (build containers have sqlite3).
    // .vercel-setup-url records what's actually in the DB so server.js knows whether
    // proxy rewriting is needed at cold-start.
    let setupUrlActual = 'https://localhost:8090';
    if (setupPublicUrl) {
      const dbPath = path.join(OUT_DIR, 'repository', 'database', 'configdb.db');
      const runtimeUri = `${setupPublicUrl}/console`;
      const sql = `UPDATE OAUTH_INBOUND_PROFILE SET OAUTH_CONFIG = json_set(OAUTH_CONFIG, '$.redirectUris[0]', '${runtimeUri}') WHERE json_extract(OAUTH_CONFIG, '$.clientId') = 'CONSOLE';`;
      try {
        execSync(`sqlite3 "${dbPath}" "${sql}"`, { stdio: 'pipe' });
        console.log(`Updated console redirect URI in database to ${runtimeUri}`);
        setupUrlActual = setupPublicUrl;
      } catch (e) {
        console.log('sqlite3 not available at build time:', (e.message || '').split('\n')[0]);
        console.log('server.js will handle redirect URI rewriting at cold-start.');
      }
    }
    fs.writeFileSync(path.join(OUT_DIR, '.vercel-db-mode'), 'sqlite');
    fs.writeFileSync(path.join(OUT_DIR, '.vercel-setup-url'), setupUrlActual);
    console.log(`Setup URL recorded: ${setupUrlActual}`);
    // Restore placeholder template — server.js fills the actual URL at cold-start
    fs.writeFileSync(path.join(OUT_DIR, 'deployment.yaml'), DEPLOYMENT_YAML);
  }

  console.log(`ThunderID ${tag} ready in thunderid-bin/ (databases ${USE_SUPABASE ? 'seeded in Supabase' : 'pre-initialized in SQLite'})`);
}

main().catch(err => { console.error(err); process.exit(1); });
