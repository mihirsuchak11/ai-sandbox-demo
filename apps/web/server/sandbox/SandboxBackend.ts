/**
 * A backend that can run untrusted code in an isolated, disposable environment.
 *
 * Both our self-hosted Docker sandbox (DockerManager) and the managed Vercel
 * Sandbox implement this. The rest of the app depends ONLY on this interface,
 * so swapping backends is a one-line change (see agent.ts).
 */

export interface SandboxHandle {
  id: string;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface SandboxBackend {
  /** Create and start a fresh, isolated sandbox. */
  createSandbox(): Promise<SandboxHandle>;

  /**
   * Write `code` into the sandbox and run it with Node.js, returning
   * stdout/stderr/exit code. Each backend hides its own filesystem details.
   */
  runCode(handle: SandboxHandle, code: string): Promise<ExecResult>;

  /** Stop and remove the sandbox. Always called, even on error. */
  destroySandbox(handle: SandboxHandle): Promise<void>;
}
