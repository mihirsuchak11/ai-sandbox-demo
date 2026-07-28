import Anthropic from "@anthropic-ai/sdk";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import type { SandboxBackend, SandboxHandle } from "./sandbox/SandboxBackend.js";
import type { ChatMessage, ToolRun, ChatResult } from "../shared/types.js";
import { getGitHubConfig, type GitHubConfig } from "./config.js";
import { getDefaultBranch, openPullRequest } from "./github.js";

/**
 * Lazily build the sandbox backend on first use — NOT at module load.
 *
 * This matters on Vercel: `dockerode` pulls in native deps (ssh2, cpu-features)
 * that crash the serverless function if loaded. By dynamic-importing the Docker
 * backend only when SANDBOX_BACKEND !== "vercel", the Vercel path never touches
 * dockerode at all.
 */
let backendPromise: Promise<SandboxBackend> | null = null;

function getBackend(): Promise<SandboxBackend> {
  if (!backendPromise) {
    backendPromise = (async () => {
      if (process.env.SANDBOX_BACKEND === "vercel") {
        const { VercelSandboxManager } = await import("./sandbox/VercelSandboxManager.js");
        console.log("🧰 Sandbox backend: vercel");
        return new VercelSandboxManager();
      }
      // Docker path — only reached (and only imported) off Vercel.
      const [{ default: Docker }, { DockerManager }, { resolveDockerSocketPath, SANDBOX_IMAGE }] =
        await Promise.all([
          import("dockerode"),
          import("./docker/DockerManager.js"),
          import("./config.js"),
        ]);
      console.log("🧰 Sandbox backend: docker");
      return new DockerManager(new Docker({ socketPath: resolveDockerSocketPath() }), SANDBOX_IMAGE);
    })();
  }
  return backendPromise;
}

const SYSTEM_PROMPT = `You are a coding agent working inside a fresh, isolated,
disposable Linux sandbox. Your job: clone a GitHub repository, make the requested
change, and open a pull request.

Tools:
- run_command: run any shell command (git, npm, ls, cat, running tests…). Pass
  "cwd" (relative to the sandbox root) to run inside the checked-out repo.
- write_file / read_file: create or inspect files by path.
- open_pull_request: open the PR once your branch is pushed.

Standard workflow:
1. Clone into a folder named "work":
     run_command git clone https://github.com/<owner>/<repo> work
   (Auth is already configured — use plain https URLs; never put a token in a URL.)
2. Create a feature branch:  run_command git checkout -b <branch>   (cwd: "work")
3. Make the change (write_file / read_file / run_command), and run the project's
   tests or build if there are any, to check your work.
4. Commit:  git add -A  then  git commit -m "<message>"   (cwd: "work")
5. Push the branch:  git push -u origin <branch>   (cwd: "work")
6. Call open_pull_request with the owner, repo, head branch, title and body.

Rules:
- Git credentials are pre-configured. Do NOT read, print, or echo credential
  files (e.g. ~/.git-credentials) and never embed a token in a command.
- Never push to the default branch; always work on a new branch and open a PR.
- If a command fails, read stderr and fix it. If you're blocked (missing repo
  name, no push access, ambiguous request), stop and explain what you need.
- Keep the final message concise: what you changed and the PR link.`;

/** True only when a real-looking key is present (ignores the .env placeholder). */
function hasApiKey(): boolean {
  const key = process.env.ANTHROPIC_API_KEY;
  return !!key && key.startsWith("sk-ant-") && !key.includes("replace");
}

/** Format an exec result the way both Claude and the UI expect. */
function formatOutput(result: { exitCode: number; stdout: string; stderr: string }): string {
  return (
    `exit code: ${result.exitCode}\n` +
    `--- stdout ---\n${result.stdout}\n` +
    `--- stderr ---\n${result.stderr}`
  );
}

/**
 * Configure git identity + credentials INSIDE the sandbox, server-side.
 *
 * The token is written to a credentials file by us (the trusted server); it
 * never appears in any tool argument, tool output, or UI. From here on the
 * model runs plain `git clone/push` and auth just works.
 */
async function setupGit(
  backend: SandboxBackend,
  sandbox: SandboxHandle,
  gh: GitHubConfig,
): Promise<void> {
  // Find the real HOME so config lands where EVERY later git command reads it.
  // `git config --global` relies on $HOME being set consistently across each
  // microVM command — which held on Docker but not on Vercel, leaving commits
  // with no identity. Writing the files directly is backend-agnostic.
  const homeRes = await backend.exec(sandbox, "sh", ["-c", "echo -n $HOME"]);
  const home = homeRes.stdout.trim() || "/root";

  // Credentials file — the token is written by us (the trusted server) and never
  // appears in any tool argument, tool output, or UI. `helper = store` reads it.
  await backend.writeFile(
    sandbox,
    `${home}/.git-credentials`,
    `https://x-access-token:${gh.token}@github.com\n`,
  );

  await backend.writeFile(
    sandbox,
    `${home}/.gitconfig`,
    `[user]\n\tname = ${gh.authorName}\n\temail = ${gh.authorEmail}\n` +
      `[credential]\n\thelper = store\n` +
      `[safe]\n\tdirectory = *\n`,
  );
}

/**
 * Parse a GitHub repo out of the user's chat message — the SAME source the real
 * agent uses (the git URL you type). Accepts a full URL or a bare "owner/repo".
 */
function parseRepo(text: string): { owner: string; repo: string } | null {
  const m =
    text.match(/github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[/\s#?]|$)/i) ??
    text.match(/(?:^|\s)([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[/\s#?]|$)/);
  if (!m) return null;
  return { owner: m[1], repo: m[2] };
}

/**
 * Mock mode: no ANTHROPIC_API_KEY, so we DON'T call Claude (no cost).
 *
 * If the chat message names a repo AND a GITHUB_TOKEN is set, we run the WHOLE
 * clone→commit→push→PR pipeline for real — but the "change" is a scripted dummy
 * file named with a timestamp, instead of Claude deciding what to do. The repo
 * comes from the chat message, exactly like the real agent. This lets you verify
 * the entire git/PR half end-to-end with only a (free) GitHub token.
 *
 * Otherwise we fall back to just running `git --version` to prove the sandbox is
 * alive.
 */
async function runMock(
  backend: SandboxBackend,
  messages: ChatMessage[],
  sandbox: SandboxHandle,
  gh: GitHubConfig | null,
): Promise<ChatResult> {
  const lastUser = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
  const target = parseRepo(lastUser);

  // No repo named in chat, or no token → minimal liveness check.
  if (!target || !gh) {
    const result = await backend.exec(sandbox, "git", ["--version"]);
    return {
      reply:
        "🔌 Mock mode — no ANTHROPIC_API_KEY, so Claude was NOT called. Name a repo in your " +
        "message (e.g. github.com/you/your-repo) with a GITHUB_TOKEN set, and this will really " +
        `clone→commit→push→open a PR. You asked: "${lastUser}"`,
      toolRuns: [{ tool: "run_command", summary: "$ git --version", output: formatOutput(result) }],
    };
  }

  const { owner, repo } = target;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-"); // 2026-07-28T15-30-00-000Z
  const branch = `sandbox-run/${stamp}`;
  const file = `sandbox-runs/run-${stamp}.md`;
  const runs: ToolRun[] = [];

  // Helper: run a git command in the repo, record it, throw on failure.
  const git = async (args: string[], cwd = "work") => {
    const out = await backend.exec(sandbox, "git", args, { cwd });
    runs.push({ tool: "run_command", summary: `$ git ${args.join(" ")}`, output: formatOutput(out) });
    if (out.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed:\n${out.stderr}`);
    return out;
  };

  // 1. Clone (auth already set up by setupGit).
  await git(["clone", `https://github.com/${owner}/${repo}`, "work"], ".");
  // 2. New branch.
  await git(["checkout", "-b", branch]);
  // 3. Scripted change: a dummy file with a human-readable timestamp.
  const content = `# Sandbox run\n\nCreated at: ${new Date().toString()}\nBranch: ${branch}\n`;
  await backend.writeFile(sandbox, `work/${file}`, content);
  runs.push({ tool: "write_file", summary: `wrote ${file}`, output: content });
  // 4. Commit + push.
  await git(["add", "-A"]);
  await git(["commit", "-m", `Sandbox run ${stamp}`]);
  await git(["push", "-u", "origin", branch]);
  // 5. Open the PR via the server-held token.
  const base = await getDefaultBranch(gh.token, owner, repo);
  const url = await openPullRequest({
    token: gh.token,
    owner,
    repo,
    head: branch,
    base,
    title: `Sandbox run ${stamp}`,
    body: `Automated mock run — added \`${file}\`. No Claude involved; this exercises the real clone→push→PR path.`,
  });
  runs.push({ tool: "open_pull_request", summary: `opened PR: ${url}`, output: url });

  return {
    reply:
      `🔌 Mock mode (no Claude) — but this was a REAL run against ${owner}/${repo}: cloned, ` +
      `created ${file}, pushed branch ${branch}, and opened a pull request:\n\n${url}`,
    toolRuns: runs,
  };
}

/** Real mode: let Claude drive the sandbox to clone, edit, and open a PR. */
async function runWithClaude(
  backend: SandboxBackend,
  messages: ChatMessage[],
  sandbox: SandboxHandle,
  gh: GitHubConfig | null,
): Promise<ChatResult> {
  const anthropic = new Anthropic(); // reads ANTHROPIC_API_KEY from the environment
  const toolRuns: ToolRun[] = [];

  const runCommand = betaZodTool({
    name: "run_command",
    description:
      "Run a shell command in the sandbox and return stdout, stderr, and exit code. " +
      "Use for git, npm, running tests, ls, cat, etc. Set cwd to run inside a subdirectory " +
      "(e.g. the cloned repo folder 'work').",
    inputSchema: z.object({
      cmd: z.string().describe('The program to run, e.g. "git".'),
      args: z.array(z.string()).default([]).describe('Arguments, e.g. ["clone", url, "work"].'),
      cwd: z.string().optional().describe('Directory to run in, relative to the sandbox root.'),
    }),
    run: async ({ cmd, args, cwd }) => {
      const output = formatOutput(await backend.exec(sandbox, cmd, args, { cwd }));
      const label = `$ ${[cmd, ...args].join(" ")}${cwd ? `   (in ${cwd})` : ""}`;
      toolRuns.push({ tool: "run_command", summary: label, output });
      return output;
    },
  });

  const writeFile = betaZodTool({
    name: "write_file",
    description: "Create or overwrite a file in the sandbox with the given contents.",
    inputSchema: z.object({
      path: z.string().describe("File path, relative to the sandbox root or absolute."),
      content: z.string().describe("The full file contents to write."),
    }),
    run: async ({ path, content }) => {
      await backend.writeFile(sandbox, path, content);
      const output = `wrote ${content.length} bytes to ${path}`;
      toolRuns.push({ tool: "write_file", summary: `wrote ${path}`, output });
      return output;
    },
  });

  const readFile = betaZodTool({
    name: "read_file",
    description: "Read a file's contents from the sandbox.",
    inputSchema: z.object({
      path: z.string().describe("File path, relative to the sandbox root or absolute."),
    }),
    run: async ({ path }) => {
      try {
        const content = await backend.readFile(sandbox, path);
        toolRuns.push({ tool: "read_file", summary: `read ${path}`, output: content });
        return content;
      } catch (err) {
        const msg = `error reading ${path}: ${(err as Error).message}`;
        toolRuns.push({ tool: "read_file", summary: `read ${path} (failed)`, output: msg });
        return msg;
      }
    },
  });

  const openPr = betaZodTool({
    name: "open_pull_request",
    description:
      "Open a GitHub pull request for a branch you have already pushed. " +
      "Returns the PR URL. Omit base to target the repo's default branch.",
    inputSchema: z.object({
      owner: z.string().describe("Repository owner (user or org)."),
      repo: z.string().describe("Repository name."),
      head: z.string().describe("The branch containing your changes (already pushed)."),
      title: z.string().describe("PR title."),
      body: z.string().default("").describe("PR description (markdown)."),
      base: z.string().optional().describe("Branch to merge into; defaults to the repo default."),
    }),
    run: async ({ owner, repo, head, title, body, base }) => {
      if (!gh) {
        const msg = "Cannot open a PR: no GITHUB_TOKEN configured on the server.";
        toolRuns.push({ tool: "open_pull_request", summary: "open PR (no token)", output: msg });
        return msg;
      }
      try {
        const targetBase = base ?? (await getDefaultBranch(gh.token, owner, repo));
        const url = await openPullRequest({
          token: gh.token,
          owner,
          repo,
          head,
          base: targetBase,
          title,
          body,
        });
        toolRuns.push({ tool: "open_pull_request", summary: `opened PR: ${url}`, output: url });
        return `Pull request opened: ${url}`;
      } catch (err) {
        const msg = `Failed to open PR: ${(err as Error).message}`;
        toolRuns.push({ tool: "open_pull_request", summary: "open PR (failed)", output: msg });
        return msg;
      }
    },
  });

  const finalMessage = await anthropic.beta.messages.toolRunner({
    model: "claude-opus-4-8",
    max_tokens: 16000,
    system: SYSTEM_PROMPT,
    tools: [runCommand, writeFile, readFile, openPr],
    messages,
  });

  const reply = finalMessage.content
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("")
    .trim();

  return { reply, toolRuns };
}

/**
 * Run one task. Creates a fresh sandbox that PERSISTS across every tool call in
 * the task (clone → edit → test → push → PR), then always destroys it.
 */
export async function runChat(messages: ChatMessage[]): Promise<ChatResult> {
  const backend = await getBackend();
  const gh = getGitHubConfig();
  const sandbox = await backend.createSandbox();
  try {
    if (gh) await setupGit(backend, sandbox, gh);
    return hasApiKey()
      ? await runWithClaude(backend, messages, sandbox, gh)
      : await runMock(backend, messages, sandbox, gh);
  } finally {
    await backend.destroySandbox(sandbox);
  }
}
