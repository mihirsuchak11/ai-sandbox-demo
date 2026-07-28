import * as tar from "tar-stream";
import path from "node:path";
import Docker from "dockerode";
import type { Container } from "dockerode";
import { PassThrough } from "node:stream";
import type { SandboxBackend, SandboxHandle, ExecResult } from "../sandbox/SandboxBackend.js";

// Single source of truth for these types now lives in SandboxBackend.
// Re-export so existing imports from this module keep working.
export type { SandboxHandle, ExecResult };

/**
 * Manages the lifecycle of sandbox containers.
 * Single responsibility: create and destroy isolated environments.
 * The Docker client is injected (not created here) so this class stays testable.
 */
export class DockerManager implements SandboxBackend {
  constructor(
    private readonly docker: Docker,
    private readonly image: string,
  ) {}

  /** Write `code` to /workspace and run it with Node (satisfies SandboxBackend). */
  async runCode(handle: SandboxHandle, code: string): Promise<ExecResult> {
    const file = "/workspace/main.js";
    await this.writeFile(handle, file, code);
    return this.exec(handle, ["node", file]);
  }
    /**
   * Create a fresh, idling sandbox and start it.
   * Runs `sleep infinity` so the container stays alive, ready for exec.
   */
  async createSandbox(): Promise<SandboxHandle> {
    const container = await this.docker.createContainer({
      Image: this.image,
      Cmd: ["sleep", "infinity"], // keep-alive trick
      Tty: false,
      // A recognizable name prefix helps debugging with `docker ps`.
      name: `sandbox-${Date.now()}`,
    });

    await container.start();
    return { id: container.id };
  }

  /**
   * Stop and remove a sandbox. Force-removes so a still-running
   * container is torn down cleanly (no leaks — remember the pitfall).
   */
  async destroySandbox(handle: SandboxHandle): Promise<void> {
    const container: Container = this.docker.getContainer(handle.id);
    await container.remove({ force: true });
  }

  /** Utility: is this sandbox actually running? (for our test) */
  async isRunning(handle: SandboxHandle): Promise<boolean> {
    const container = this.docker.getContainer(handle.id);
    const info = await container.inspect();
    return info.State.Running;
  }
   /**
   * Write a file into the sandbox by streaming a tar archive in.
   * @param filePath absolute path inside the container, e.g. "/workspace/app.py"
   */
  async writeFile(
    handle: SandboxHandle,
    filePath: string,
    content: string | Buffer,
  ): Promise<void> {
    const container = this.docker.getContainer(handle.id);

    // Build a one-file tar archive in memory.
    const pack = tar.pack();
    pack.entry({ name: path.basename(filePath) }, content);
    pack.finalize();

    // Docker unpacks the archive INTO the directory we name here.
    await container.putArchive(pack, { path: path.dirname(filePath) });
  }
  /**
   * Read a file out of the sandbox. Docker hands us a tar archive
   * containing the file; we unpack it and return its contents.
   */
  async readFile(handle: SandboxHandle, filePath: string): Promise<string> {
    const container = this.docker.getContainer(handle.id);
    const archiveStream = await container.getArchive({ path: filePath });

    return new Promise<string>((resolve, reject) => {
      const extract = tar.extract();
      const chunks: Buffer[] = [];

      extract.on("entry", (_header, stream, next) => {
        stream.on("data", (c: Buffer) => chunks.push(c));
        stream.on("end", next);
        stream.resume();
      });
      extract.on("finish", () => resolve(Buffer.concat(chunks).toString("utf-8")));
      extract.on("error", reject);

      archiveStream.pipe(extract);
    });
  }
/**
   * Run a command inside an existing sandbox and capture its output.
   * @param command argv array, e.g. ["python3", "/workspace/app.py"]
   */
  async exec(handle: SandboxHandle, command: string[]): Promise<ExecResult> {
    const container = this.docker.getContainer(handle.id);

    const exec = await container.exec({
      Cmd: command,
      AttachStdout: true,
      AttachStderr: true,
      Tty: false, // MUST be false so stdout/stderr stay separable
    });

    const stream = await exec.start({ hijack: true, stdin: false });

    const stdoutCollector = new PassThrough();
    const stderrCollector = new PassThrough();
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    stdoutCollector.on("data", (c: Buffer) => stdoutChunks.push(c));
    stderrCollector.on("data", (c: Buffer) => stderrChunks.push(c));

    this.docker.modem.demuxStream(stream, stdoutCollector, stderrCollector);

    await new Promise<void>((resolve, reject) => {
      stream.on("end", resolve);
      stream.on("error", reject);
    });

    const info = await exec.inspect();

    return {
      stdout: Buffer.concat(stdoutChunks).toString("utf-8"),
      stderr: Buffer.concat(stderrChunks).toString("utf-8"),
      exitCode: info.ExitCode ?? -1,
    };
  }
    /** Install Node packages into the sandbox (writes node_modules in /workspace). */
  async installNodePackages(
    handle: SandboxHandle,
    packages: string[],
  ): Promise<ExecResult> {
    return this.exec(handle, ["npm", "install", ...packages]);
  }

  /** Install Python packages into the sandbox's venv. */
  async installPythonPackages(
    handle: SandboxHandle,
    packages: string[],
  ): Promise<ExecResult> {
    return this.exec(handle, ["pip", "install", ...packages]);
  }
}
