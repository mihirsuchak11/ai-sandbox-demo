/**
 * Thin GitHub REST helpers used server-side ONLY.
 *
 * The token lives here, in the trusted server, and is never handed to the model
 * or written into anything the UI sees. The agent asks us to open a PR; we make
 * the authenticated call on its behalf and return just the resulting URL.
 */

const API = "https://api.github.com";

interface OpenPrParams {
  token: string;
  owner: string;
  repo: string;
  title: string;
  head: string; // branch with the changes
  base: string; // branch to merge into (e.g. "main")
  body: string;
}

async function gh(token: string, path: string, init: RequestInit): Promise<any> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      "User-Agent": "ai-sandbox-agent",
      ...(init.headers ?? {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`GitHub ${path} → ${res.status}: ${data.message ?? "request failed"}`);
  }
  return data;
}

/** The default branch, so the agent doesn't have to guess "main" vs "master". */
export async function getDefaultBranch(
  token: string,
  owner: string,
  repo: string,
): Promise<string> {
  const data = await gh(token, `/repos/${owner}/${repo}`, { method: "GET" });
  return data.default_branch as string;
}

/** Open a pull request; returns its html_url. */
export async function openPullRequest(p: OpenPrParams): Promise<string> {
  const data = await gh(p.token, `/repos/${p.owner}/${p.repo}/pulls`, {
    method: "POST",
    body: JSON.stringify({
      title: p.title,
      head: p.head,
      base: p.base,
      body: p.body,
    }),
  });
  return data.html_url as string;
}
