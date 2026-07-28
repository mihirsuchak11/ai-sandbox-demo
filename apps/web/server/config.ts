import { existsSync } from "node:fs";

/**
 * Figure out which Docker socket to talk to.
 * Priority: explicit DOCKER_HOST env → Colima's socket → the standard default.
 * This makes our code portable across setups instead of hardcoding Colima.
 */
export function resolveDockerSocketPath(): string {
  const fromEnv = process.env.DOCKER_HOST;
  if (fromEnv?.startsWith("unix://")) {
    return fromEnv.replace("unix://", "");
  }

  const colimaSocket = `${process.env.HOME}/.colima/default/docker.sock`;
  if (existsSync(colimaSocket)) {
    return colimaSocket;
  }

  return "/var/run/docker.sock"; // Docker Desktop / native Linux default
}

/** The image every sandbox is created from (built in Milestone 2). */
export const SANDBOX_IMAGE = "ai-sandbox:0.2";

/**
 * GitHub identity the coding agent commits and opens PRs as.
 * The token is read once, server-side, and never exposed to the model or UI.
 */
export interface GitHubConfig {
  token: string;
  authorName: string;
  authorEmail: string;
}

/** Returns null when no token is configured (agent then works read-only / can't push). */
export function getGitHubConfig(): GitHubConfig | null {
  const token = process.env.GITHUB_TOKEN;
  if (!token) return null;
  return {
    token,
    authorName: process.env.GIT_AUTHOR_NAME || "AI Sandbox Bot",
    authorEmail: process.env.GIT_AUTHOR_EMAIL || "ai-sandbox-bot@users.noreply.github.com",
  };
}
