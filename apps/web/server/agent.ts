import Anthropic from "@anthropic-ai/sdk";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import type { SandboxBackend, SandboxHandle } from "./sandbox/SandboxBackend.js";
import type { ChatMessage, ToolRun, ChatResult, ProgressEvent } from "../shared/types.js";

/**
 * Callback the transport passes in to receive live progress. The agent calls
 * it with a `status` event at each phase and a `tool` event after every tool
 * call, so the UI can render steps as they happen. A no-op by default keeps
 * the non-streaming callers working unchanged.
 */
export type OnEvent = (event: ProgressEvent) => void;
const noop: OnEvent = () => {};
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
- GitHub tools (via the "github" MCP server, when available): use these to
  UNDERSTAND the repo before you change it — read issues, browse files, search
  code, check the default branch. Use them for context/reading; still make code
  changes in the sandbox (write_file / run_command) and push with git.

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
  onEvent: OnEvent = noop,
): Promise<ChatResult> {
  const lastUser = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
  const target = parseRepo(lastUser);

  // No repo named in chat, or no token → minimal liveness check.
  if (!target || !gh) {
    const result = await backend.exec(sandbox, "git", ["--version"]);
    onEvent({
      type: "tool",
      run: { tool: "run_command", summary: "$ git --version", output: formatOutput(result) },
    });
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

  // Record every step (incl. exit/stdout/stderr) so a failure is fully visible
  // in the UI instead of a bare 500. `run` never throws; `mustPass` throws with
  // the FULL output (git writes "nothing to commit" to stdout, not stderr).
  const run = async (cmd: string, args: string[], cwd?: string) => {
    const out = await backend.exec(sandbox, cmd, args, cwd ? { cwd } : {});
    const runRecord: ToolRun = {
      tool: "run_command",
      summary: `$ ${cmd} ${args.join(" ")}${cwd ? `   (in ${cwd})` : ""}`,
      output: formatOutput(out),
    };
    runs.push(runRecord);
    onEvent({ type: "tool", run: runRecord });
    return out;
  };
  const mustPass = async (cmd: string, args: string[], cwd?: string) => {
    const out = await run(cmd, args, cwd);
    if (out.exitCode !== 0) {
      throw new Error(
        `${cmd} ${args.join(" ")} exited ${out.exitCode}\nstdout: ${out.stdout}\nstderr: ${out.stderr}`,
      );
    }
    return out;
  };

  try {
    await mustPass("git", ["clone", `https://github.com/${owner}/${repo}`, "work"], ".");

    // Resolve the repo's ABSOLUTE path and use it for every step. On Vercel,
    // writeFiles and a cwd-less runCommand use a different base dir than a
    // runCommand WITH a cwd — so a relative "work/…" file lands where git can't
    // see it. Absolute paths remove that ambiguity on both backends.
    const repoAbs = (await run("pwd", [], "work")).stdout.trim();

    await mustPass("git", ["checkout", "-b", branch], repoAbs);

    const content = `# Sandbox run\n\nCreated at: ${new Date().toString()}\nBranch: ${branch}\n`;
    await backend.writeFile(sandbox, `${repoAbs}/${file}`, content);
    const writeRun: ToolRun = { tool: "write_file", summary: `wrote ${file}`, output: content };
    runs.push(writeRun);
    onEvent({ type: "tool", run: writeRun });

    // Confirm the file landed where git will see it.
    await run("git", ["status", "--porcelain"], repoAbs);

    await mustPass("git", ["add", "-A"], repoAbs);
    await mustPass("git", ["commit", "-m", `Sandbox run ${stamp}`], repoAbs);
    await mustPass("git", ["push", "-u", "origin", branch], repoAbs);

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
    const prRun: ToolRun = { tool: "open_pull_request", summary: `opened PR: ${url}`, output: url };
    runs.push(prRun);
    onEvent({ type: "tool", run: prRun });
    onEvent({ type: "status", message: `🔗 Pull request opened: ${url}` });

    return {
      reply:
        `🔌 Mock mode (no Claude) — but this was a REAL run against ${owner}/${repo}: cloned, ` +
        `created ${file}, pushed branch ${branch}, and opened a pull request:\n\n${url}`,
      toolRuns: runs,
    };
  } catch (err) {
    return {
      reply:
        `⚠️ Mock run against ${owner}/${repo} failed: ${(err as Error).message}\n\n` +
        `The steps above show exactly where — check the last one.`,
      toolRuns: runs,
    };
  }
}

/** Real mode: let Claude drive the sandbox to clone, edit, and open a PR. */
async function runWithClaude(
  backend: SandboxBackend,
  messages: ChatMessage[],
  sandbox: SandboxHandle,
  gh: GitHubConfig | null,
  onEvent: OnEvent = noop,
): Promise<ChatResult> {
  const anthropic = new Anthropic(); // reads ANTHROPIC_API_KEY from the environment
  const toolRuns: ToolRun[] = [];

  // Record a tool call once: keep it for the final result AND stream it to the
  // UI so the step shows up the moment Claude makes it, not at the very end.
  const record = (run: ToolRun) => {
    toolRuns.push(run);
    onEvent({ type: "tool", run });
  };

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
      record({ tool: "run_command", summary: label, output });
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
      record({ tool: "write_file", summary: `wrote ${path}`, output });
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
        record({ tool: "read_file", summary: `read ${path}`, output: content });
        return content;
      } catch (err) {
        const msg = `error reading ${path}: ${(err as Error).message}`;
        record({ tool: "read_file", summary: `read ${path} (failed)`, output: msg });
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
        record({ tool: "open_pull_request", summary: "open PR (no token)", output: msg });
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
        record({ tool: "open_pull_request", summary: `opened PR: ${url}`, output: url });
        // Surface the PR link in the chat the moment it exists, instead of
        // waiting for the model's final wrap-up message.
        onEvent({ type: "status", message: `🔗 Pull request opened: ${url}` });
        return `Pull request opened: ${url}`;
      } catch (err) {
        const msg = `Failed to open PR: ${(err as Error).message}`;
        record({ tool: "open_pull_request", summary: "open PR (failed)", output: msg });
        return msg;
      }
    },
  });

  // When a GitHub token is configured, connect the official GitHub MCP server
  // so the model gets first-class GitHub tools (read issues, browse/search
  // files, inspect branches) for understanding the repo. Auth is handled
  // server-side by the Anthropic MCP connector — the token is passed here and
  // never reaches the model or the sandbox. The connector needs its own beta.
  const github = gh
    ? {
        mcp_servers: [
          {
            type: "url" as const,
            name: "github",
            url: "https://api.githubcopilot.com/mcp/",
            authorization_token: gh.token,
          },
        ],
        // `mcp_toolset` isn't a runnable tool (no run fn) — it tells the model
        // the "github" server's tools are available. Cast past the toolRunner's
        // runnable-tool typing; the SDK accepts it as a passthrough tool entry.
        tools: [{ type: "mcp_toolset", mcp_server_name: "github" }],
        betas: ["mcp-client-2025-11-20"],
      }
    : null;

  const finalMessage = await anthropic.beta.messages.toolRunner({
    // Cheapest model — quality isn't a priority for this tool right now.
    model: "claude-haiku-4-5",
    max_tokens: 16000,
    // Prompt caching: this is an agentic tool loop, so every iteration resends
    // the full prefix (system + tools + all prior messages). Top-level
    // cache_control auto-places an ephemeral breakpoint on the last cacheable
    // block of each request, so the stable prefix and the accumulating history
    // are read from cache (~0.1x input cost) instead of reprocessed each turn.
    // Note: Haiku 4.5's minimum cacheable prefix is 4096 tokens — short early
    // turns silently won't cache (usage.cache_read_input_tokens stays 0), but
    // the history quickly crosses that threshold in a multi-tool run.
    cache_control: { type: "ephemeral" },
    system: SYSTEM_PROMPT,
    tools: [runCommand, writeFile, readFile, openPr, ...(github?.tools ?? [])] as any,
    ...(github ? { mcp_servers: github.mcp_servers, betas: github.betas } : {}),
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
export async function runChat(messages: ChatMessage[], onEvent: OnEvent = noop): Promise<ChatResult> {
  const backend = await getBackend();
  const gh = getGitHubConfig();

  onEvent({ type: "status", message: "Creating a fresh sandbox…" });
  const sandbox = await backend.createSandbox();
  try {
    if (gh) {
      onEvent({ type: "status", message: "Configuring git credentials…" });
      await setupGit(backend, sandbox, gh);
    }
    onEvent({
      type: "status",
      message: hasApiKey() ? "Claude is working in the sandbox…" : "Running mock pipeline…",
    });
    return hasApiKey()
      ? await runWithClaude(backend, messages, sandbox, gh, onEvent)
      : await runMock(backend, messages, sandbox, gh, onEvent);
  } finally {
    await backend.destroySandbox(sandbox);
  }
}
