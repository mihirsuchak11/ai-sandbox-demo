import Docker from "dockerode";
import { resolveDockerSocketPath, SANDBOX_IMAGE } from "./config.js";
import { DockerManager } from "./docker/DockerManager.js";

async function main(): Promise<void> {
  const docker = new Docker({ socketPath: resolveDockerSocketPath() });
  const manager = new DockerManager(docker, SANDBOX_IMAGE);

  const sandbox = await manager.createSandbox();
  console.log(`✅ Sandbox created: ${sandbox.id.slice(0, 12)}\n`);

  try {
    // --- Python: install a package, then use it ---
    console.log("📦 Installing Python package 'cowsay'...");
    const pipInstall = await manager.installPythonPackages(sandbox, ["cowsay"]);
    console.log(`   pip exitCode: ${pipInstall.exitCode}`);

    const pyRun = await manager.exec(sandbox, "python3", [
      "-c", "import cowsay; cowsay.cow('hello from a pip package')",
    ]);
    console.log("   Python output:\n" + pyRun.stdout);

    // --- Node: install a package, then use it ---
    console.log("📦 Installing Node package 'lodash'...");
    const npmInstall = await manager.installNodePackages(sandbox, ["lodash"]);
    console.log(`   npm exitCode: ${npmInstall.exitCode}`);

    const nodeRun = await manager.exec(sandbox, "node", [
      "-e", "console.log(require('lodash').capitalize('hello from npm'))",
    ]);
    console.log("   Node output: " + nodeRun.stdout.trim());
  } finally {
    await manager.destroySandbox(sandbox);
    console.log("\n🧹 Sandbox destroyed.");
  }
}

main().catch((err) => {
  console.error("❌ Error:", err.message);
  process.exit(1);
});