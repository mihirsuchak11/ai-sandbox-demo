import Anthropic from "@anthropic-ai/sdk";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import type { SandboxBackend, SandboxHandle } from "./sandbox/SandboxBackend";
import type { ChatMessage, ToolRun, ChatResult } from "../shared/types";

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
        const { VercelSandboxManager } = await import("./sandbox/VercelSandboxManager");
        console.log("🧰 Sandbox backend: vercel");
        return new VercelSandboxManager();
      }
      // Docker path — only reached (and only imported) off Vercel.
      const [{ default: Docker }, { DockerManager }, { resolveDockerSocketPath, SANDBOX_IMAGE }] =
        await Promise.all([
          import("dockerode"),
          import("./docker/DockerManager"),
          import("./config"),
        ]);
      console.log("🧰 Sandbox backend: docker");
      return new DockerManager(new Docker({ socketPath: resolveDockerSocketPath() }), SANDBOX_IMAGE);
    })();
  }
  return backendPromise;
}

const SYSTEM_PROMPT = `You are an AI code interpreter with access to a secure sandbox.

When a question requires computation, data processing, testing code, or any factual
result you cannot be certain of, WRITE AND RUN JavaScript with the run_code tool
instead of guessing. The code runs in Node.js. Read the tool's output (stdout,
stderr, exit code) and use it to answer. If the code fails, read the error and fix
it. Keep answers concise and explain what the code did.`;

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
 * Mock mode: no ANTHROPIC_API_KEY, so we DON'T call Claude (no cost). We still
 * exercise the real sandbox end-to-end so the pipeline is fully testable.
 */
async function runMock(
  backend: SandboxBackend,
  messages: ChatMessage[],
  sandbox: SandboxHandle,
): Promise<ChatResult> {
  const lastUser = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
  const code = `console.log("sandbox is alive — you said:", ${JSON.stringify(lastUser)});`;
  const result = await backend.runCode(sandbox, code);

  return {
    reply:
      "🔌 Mock mode — no ANTHROPIC_API_KEY set, so Claude was NOT called (saving money). " +
      "But your message ran through the real sandbox above, proving the full pipeline works.",
    toolRuns: [{ language: "node", code, output: formatOutput(result) }],
  };
}

/** Real mode: let Claude drive the sandbox via the run_code tool. */
async function runWithClaude(
  backend: SandboxBackend,
  messages: ChatMessage[],
  sandbox: SandboxHandle,
): Promise<ChatResult> {
  const anthropic = new Anthropic(); // reads ANTHROPIC_API_KEY from the environment
  const toolRuns: ToolRun[] = [];

  const runCode = betaZodTool({
    name: "run_code",
    description:
      "Execute a complete JavaScript (Node.js) program in a secure sandbox and return " +
      "its stdout, stderr, and exit code. Use this whenever the answer requires " +
      "computation, data processing, or verifying that code works.",
    inputSchema: z.object({
      code: z.string().describe("The complete Node.js program to run."),
    }),
    run: async ({ code }) => {
      const output = formatOutput(await backend.runCode(sandbox, code));
      toolRuns.push({ language: "node", code, output });
      return output; // goes back to Claude as the tool result
    },
  });

  const finalMessage = await anthropic.beta.messages.toolRunner({
    model: "claude-opus-4-8",
    max_tokens: 16000,
    system: SYSTEM_PROMPT,
    tools: [runCode],
    messages,
  });

  const reply = finalMessage.content
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("")
    .trim();

  return { reply, toolRuns };
}

/**
 * Run one chat turn. Creates a fresh sandbox, runs the turn (mock or real),
 * then always destroys the sandbox.
 */
export async function runChat(messages: ChatMessage[]): Promise<ChatResult> {
  const backend = await getBackend();
  const sandbox = await backend.createSandbox();
  try {
    return hasApiKey()
      ? await runWithClaude(backend, messages, sandbox)
      : await runMock(backend, messages, sandbox);
  } finally {
    await backend.destroySandbox(sandbox);
  }
}
