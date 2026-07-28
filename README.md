# ai-sandbox-demo

An AI **coding agent**: a chat UI where you ask Claude to clone a GitHub repo,
make a change, and open a pull request. Claude works inside a disposable,
isolated sandbox — running git, editing files, and running tests — then opens
the PR for you.

**Sandbox lifecycle:** each task gets ONE fresh, throwaway sandbox that persists
across every tool call in that task (clone → edit → test → push → PR), then is
destroyed. Nothing carries over between tasks — every request starts clean.

## Structure

```
apps/web/            ← the deployable app (one Vercel project)
  src/               React + shadcn frontend
  api/chat.ts        Vercel Function (production API)
  server/            runChat, agent (Claude tool loop), sandbox backends
    agent.ts         the coding agent: run_command / write_file / read_file / open_pull_request
    github.ts        server-side GitHub REST (open PR) — the token never leaves the server
    dev.ts           local Express dev server (npm run api)
    docker/          DockerManager  (self-hosted containers)
    sandbox/         VercelSandboxManager (Firecracker microVMs) + interface
  shared/types.ts    contract shared by frontend + backend
Dockerfile           the sandbox image for the Docker backend (git + python)
```

The backend depends only on the `SandboxBackend` interface (`exec` / `writeFile`
/ `readFile`), so the execution engine is swappable via `SANDBOX_BACKEND`
(`docker` | `vercel`).

### GitHub auth (how the PR gets opened)

Set `GITHUB_TOKEN` to a fine-grained PAT (Contents + Pull requests: read/write,
scoped to the repos you allow). At the start of each task the server writes those
credentials into the sandbox's git config — **the token is never passed to the
model or shown in the UI**; Claude just runs plain `git clone/push`. The PR
itself is opened by `server/github.ts` using the server-held token. Without a
token the agent can still clone/build public repos, but can't push or open PRs.

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
2. Add env vars: `ANTHROPIC_API_KEY`, `SANDBOX_BACKEND=vercel`, and `GITHUB_TOKEN`.
3. Deploy. `@vercel/sandbox` authenticates automatically in production (OIDC).
