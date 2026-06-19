# ThunderID on Vercel

Deploy [ThunderID](https://thunderid.dev) — the high-performance open-source identity stack — to Vercel using Docker.

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/brionmario/thunderid-deployment-templates&root=vercel)

---

## How it works

This repo extends the official `ghcr.io/thunder-id/thunderid` Docker image with a thin entrypoint script that configures ThunderID from Vercel's injected environment variables before starting the server.

Vercel terminates TLS at the edge, so ThunderID runs in HTTP-only mode internally and the frontend apps are patched at startup to reach the server through the resolved public domain.

## Requirements

- Vercel account (any plan that supports Docker container deployments)
- `vercel` CLI (optional — for manual deploys)

## Quickstart

### Option A — Deploy to Vercel button

Click the button above. Vercel will clone this repo and walk you through environment variable setup.

### Option B — CLI deploy

```bash
git clone https://github.com/brionmario/thunderid-deployment-templates
cd thunderid-deployment-templates/vercel
vercel --prod
```

## Environment variables

Set these in the Vercel dashboard under **Settings → Environment Variables** before the first deploy.

| Variable | Required | Default | Description |
|---|---|---|---|
| `ADMIN_USERNAME` | No | `admin` | Initial admin account username |
| `ADMIN_PASSWORD` | No | `admin` | Initial admin account password — **change this** |
| `PUBLIC_URL` | No | auto-detected | Override the public URL (e.g. `https://auth.example.com`) if you use a custom domain |

> **Vercel auto-sets `VERCEL_PROJECT_PRODUCTION_URL` and `PORT`** — the entrypoint reads these automatically, so you do not need to set them.

## Important limitations

### SQLite is ephemeral on Vercel

Vercel containers do not have a persistent filesystem. **Every new deployment or cold start wipes the SQLite databases**, including all users and configuration created during setup.

This is acceptable for demos and testing. For a durable deployment, self-host ThunderID on a platform with persistent volumes (Railway, Fly.io, or your own server) or wait for the Vercel Postgres integration guide.

### First-request latency

ThunderID runs a one-time setup script on every container cold start (≈ 30–90 seconds depending on Vercel's hardware). Subsequent requests within the same container instance are fast. Vercel may show a deployment timeout on the very first deploy — wait a moment and reload.

### Custom domains

Add your custom domain in the Vercel dashboard, then set `PUBLIC_URL=https://your-domain.com` in the environment variables and redeploy. This ensures CORS, passkeys, and OAuth redirect URIs are registered against the correct origin.

## Local testing

You can test the Docker image locally before deploying:

```bash
docker build -t thunderid-vercel .
docker run -p 8090:8090 \
  -e PUBLIC_URL=http://localhost:8090 \
  -e ADMIN_USERNAME=admin \
  -e ADMIN_PASSWORD=changeme \
  thunderid-vercel
```

Open [http://localhost:8090](http://localhost:8090) once setup completes.

## File reference

| Path | Purpose |
|---|---|
| `Dockerfile` | Extends `ghcr.io/thunder-id/thunderid` with the Vercel entrypoint |
| `.thunderdeploy/deployment.yaml` | Server config template; placeholders are filled by the entrypoint |
| `.thunderdeploy/entrypoint.sh` | Startup script — resolves Vercel env vars, runs setup, starts the server |
| `vercel.json` | Minimal Vercel project config |

## License

Apache 2.0 — see [LICENSE](./LICENSE).
