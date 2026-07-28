# ai-sandbox-demo

An AI code interpreter: a chat UI where Claude writes code and runs it in a
disposable, isolated sandbox, then reads the output to answer.

## Architecture

```
web/ (React + shadcn)  →  Express API  →  SandboxBackend
                                            ├── DockerManager (self-hosted containers)
                                            └── VercelSandboxManager (Firecracker microVMs)
```

The backend depends only on the `SandboxBackend` interface, so the execution
engine is swappable via the `SANDBOX_BACKEND` env var (`docker` | `vercel`).

## Run locally

```bash
# 1. Backend (from repo root)
cp .env.example .env      # add your ANTHROPIC_API_KEY (optional — omit for free mock mode)
npm install
npm run api               # http://localhost:3001

# 2. Frontend (in another terminal)
cd web && npm install && npm run dev   # http://localhost:5173
```

- **Docker backend** (default): requires Docker (e.g. Colima) and the `ai-sandbox` image.
- **Vercel backend**: `SANDBOX_BACKEND=vercel` + `vercel link` && `vercel env pull .env.local`.
- **Mock mode**: with no real `ANTHROPIC_API_KEY`, the pipeline runs the sandbox
  without calling Claude (no cost).

## Layout

- `src/` — Express API, agent (Claude tool-use loop), sandbox backends
- `web/` — Vite + React + Tailwind + shadcn chat UI
- `Dockerfile` — the sandbox image (Node + tooling)
