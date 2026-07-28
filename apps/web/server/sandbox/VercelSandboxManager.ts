import { Sandbox } from "@vercel/sandbox";
import type { ExecResult, SandboxBackend, SandboxHandle } from "./SandboxBackend";

/**
 * A SandboxBackend backed by Vercel Sandbox — managed Firecracker microVMs.
 *
 * Auth (when running locally / outside Vercel): run `vercel link` then
 * `vercel env pull` to obtain VERCEL_OIDC_TOKEN, or set VERCEL_TOKEN +
 * VERCEL_TEAM_ID + VERCEL_PROJECT_ID. The SDK reads these from the environment.
 */
export class VercelSandboxManager implements SandboxBackend {
  // Map our handle id -> the live Sandbox object.
  private readonly sandboxes = new Map<string, Sandbox>();

  async createSandbox(): Promise<SandboxHandle> {
    const sandbox = await Sandbox.create({
      runtime: "node24",   // Node is built in; Amazon Linux 2023 also ships python3
      timeout: 300_000,    // 5 min max session
      persistent: false,   // throwaway per request — no snapshot on stop
    });

    this.sandboxes.set(sandbox.name, sandbox);
    return { id: sandbox.name };
  }

  async runCode(handle: SandboxHandle, code: string): Promise<ExecResult> {
    const sandbox = this.get(handle);

    // Paths are relative to the default working dir (/vercel/sandbox).
    await sandbox.writeFiles([{ path: "main.js", content: Buffer.from(code) }]);
    const result = await sandbox.runCommand({ cmd: "node", args: ["main.js"] });

    return {
      stdout: await result.stdout(),
      stderr: await result.stderr(),
      exitCode: result.exitCode,
    };
  }

  async destroySandbox(handle: SandboxHandle): Promise<void> {
    const sandbox = this.sandboxes.get(handle.id);
    if (!sandbox) return;
    await sandbox.stop();
    this.sandboxes.delete(handle.id);
  }

  private get(handle: SandboxHandle): Sandbox {
    const sandbox = this.sandboxes.get(handle.id);
    if (!sandbox) throw new Error(`Unknown sandbox: ${handle.id}`);
    return sandbox;
  }
}
