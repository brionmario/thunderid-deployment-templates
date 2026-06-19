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
  fs.writeFileSync(path.join(OUT_DIR, 'deployment.yaml'), DEPLOYMENT_YAML);

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
      // Insert temp-file population before each matching while loop
      src = src.replace(/while IFS= read -r line; do/g,
        'echo "$BODY" | grep -o \'{[^}]*"id":"[^"]*"[^}]*"handle":"[^"]*"[^}]*}\' > /tmp/_thunder_psub\nwhile IFS= read -r line; do');
      fs.writeFileSync(bootstrapScript, src);
      console.log('Patched 01-default-resources.sh (replaced process substitution with temp files)');
    }
  }

  // Run setup at build time so the function only needs to start the server.
  console.log('Running ThunderID setup (build-time)...');
  const setupYaml = DEPLOYMENT_YAML
    .replace(/__PUBLIC_URL__/g, 'http://localhost:8090')
    .replace(/__PUBLIC_HOST__/g, 'localhost')
    .replace('hostname: "0.0.0.0"', 'hostname: "localhost"');
  fs.writeFileSync(path.join(OUT_DIR, 'deployment.yaml'), setupYaml);

  execSync('bash setup.sh', {
    cwd: OUT_DIR,
    stdio: 'inherit',
    env: {
      ...process.env,
      ADMIN_USERNAME: process.env.ADMIN_USERNAME || 'admin',
      ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || 'admin',
      THUNDER_SKIP_SECURITY: 'true',
    },
  });

  // Kill any process setup.sh left running
  try { execSync('pkill -f thunderid', { stdio: 'pipe' }); } catch {}
  try { execSync('fuser -k 8090/tcp 2>/dev/null', { stdio: 'pipe' }); } catch {}
  try { execSync('fuser -k 9090/tcp 2>/dev/null', { stdio: 'pipe' }); } catch {}

  // Restore placeholder template — server.js fills the actual URL at cold-start
  fs.writeFileSync(path.join(OUT_DIR, 'deployment.yaml'), DEPLOYMENT_YAML);
  console.log(`ThunderID ${tag} ready in thunderid-bin/ (databases pre-initialized)`);
}

main().catch(err => { console.error(err); process.exit(1); });
