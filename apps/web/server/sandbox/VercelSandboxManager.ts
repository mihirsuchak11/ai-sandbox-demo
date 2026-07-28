import { Sandbox } from "@vercel/sandbox";
import type {
  ExecOptions,
  ExecResult,
  SandboxBackend,
  SandboxHandle,
} from "./SandboxBackend.js";

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
      runtime: "node24", // Node + git are built in; Amazon Linux 2023
      timeout: 600_000, // 10 min — a clone→edit→test→push task takes minutes
      persistent: false, // throwaway per task — no snapshot on stop
    });

    this.sandboxes.set(sandbox.name, sandbox);
    return { id: sandbox.name };
  }

  async exec(
    handle: SandboxHandle,
    cmd: string,
    args: string[] = [],
    opts: ExecOptions = {},
  ): Promise<ExecResult> {
    const sandbox = this.get(handle);
    const result = await sandbox.runCommand({
      cmd,
      args,
      cwd: opts.cwd,
      env: opts.env,
    });

    return {
      stdout: await result.stdout(),
      stderr: await result.stderr(),
      exitCode: result.exitCode,
    };
  }

  async writeFile(handle: SandboxHandle, path: string, content: string): Promise<void> {
    const sandbox = this.get(handle);
    await sandbox.writeFiles([{ path, content: Buffer.from(content) }]);
  }

  async readFile(handle: SandboxHandle, path: string): Promise<string> {
    const sandbox = this.get(handle);
    return sandbox.fs.readFile(path, "utf-8");
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
