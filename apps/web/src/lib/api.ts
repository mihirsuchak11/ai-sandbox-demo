import type { ChatMessage, ChatResult, ToolRun, UiMessage } from "../../shared/types";

// Re-export the shared types so components can import them from here.
export type { ChatMessage, ChatResult, ToolRun, UiMessage };

/** POST the conversation to the sandbox API and get Claude's reply. */
export async function sendChat(messages: ChatMessage[]): Promise<ChatResult> {
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages }),
  });

  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Request failed (${res.status})`);
  }

  return res.json() as Promise<ChatResult>;
}
