# ai-sandbox-demo

An AI code interpreter: a chat UI where Claude writes JavaScript and runs it in a
disposable, isolated sandbox, then reads the output to answer.

## Structure

```
apps/web/            ← the deployable app (one Vercel project)
  src/               React + shadcn frontend
  api/chat.ts        Vercel Function (production API)
  server/            runChat, agent (Claude tool loop), sandbox backends
    dev.ts           local Express dev server (npm run api)
    docker/          DockerManager  (self-hosted containers)
    sandbox/         VercelSandboxManager (Firecracker microVMs) + interface
  shared/types.ts    contract shared by frontend + backend
Dockerfile           the sandbox image for the Docker backend
```

The backend depends only on the `SandboxBackend` interface, so the execution
engine is swappable via `SANDBOX_BACKEND` (`docker` | `vercel`).

## Run locally

```bash
cd apps/web
cp .env.example .env      # add ANTHROPIC_API_KEY (optional — omit for free mock mode)
npm install

npm run api               # terminal 1: API on http://localhost:3001
npm run dev               # terminal 2: UI on http://localhost:5173
```

- **Docker backend** (default): needs Docker (e.g. Colima) + the `ai-sandbox` image.
- **Vercel backend**: `SANDBOX_BACKEND=vercel`, then `vercel link` && `vercel env pull .env.local`.
- **Mock mode**: with no real `ANTHROPIC_API_KEY`, the pipeline runs the sandbox
  without calling Claude (no cost).

## Deploy (Vercel)

One project, everything on Vercel (frontend + API function + managed sandbox):

1. Import the repo in Vercel; set **Root Directory = `apps/web`**.
2. Add env vars: `ANTHROPIC_API_KEY` and `SANDBOX_BACKEND=vercel`.
3. Deploy. `@vercel/sandbox` authenticates automatically in production (OIDC).
