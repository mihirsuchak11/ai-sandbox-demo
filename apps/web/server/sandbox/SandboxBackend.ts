/**
 * A backend that can run untrusted code in an isolated, disposable environment.
 *
 * Both our self-hosted Docker sandbox (DockerManager) and the managed Vercel
 * Sandbox implement this. The rest of the app depends ONLY on this interface,
 * so swapping backends is a one-line change (see agent.ts).
 *
 * The coding agent drives a sandbox through three primitives — run a shell
 * command, write a file, read a file — which is enough to clone a repo, edit
 * it, run tests, commit, and push.
 */

export interface SandboxHandle {
  id: string;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface ExecOptions {
  /** Directory to run in, relative to the sandbox's default workdir (e.g. "work"). */
  cwd?: string;
  /** Extra environment variables for just this command. */
  env?: Record<string, string>;
}

export interface SandboxBackend {
  /** Create and start a fresh, isolated sandbox. */
  createSandbox(): Promise<SandboxHandle>;

  /**
   * Run an arbitrary command inside the sandbox and capture its output.
   * @param cmd  the program to run, e.g. "git"
   * @param args argv, e.g. ["clone", url, "work"]
   */
  exec(
    handle: SandboxHandle,
    cmd: string,
    args?: string[],
    opts?: ExecOptions,
  ): Promise<ExecResult>;

  /** Write (or overwrite) a file in the sandbox. `path` may be absolute or relative. */
  writeFile(handle: SandboxHandle, path: string, content: string): Promise<void>;

  /** Read a file's contents out of the sandbox. */
  readFile(handle: SandboxHandle, path: string): Promise<string>;

  /** Stop and remove the sandbox. Always called, even on error. */
  destroySandbox(handle: SandboxHandle): Promise<void>;
}
