export interface ToolRun {
  language: "python" | "node";
  code: string;
  output: string;
}

/** A message as sent to the API (role + content only). */
export interface WireMessage {
  role: "user" | "assistant";
  content: string;
}

/** A message as held in the UI (may carry the code the assistant ran). */
export interface UiMessage extends WireMessage {
  toolRuns?: ToolRun[];
}

export interface ChatResponse {
  reply: string;
  toolRuns: ToolRun[];
}

/** POST the conversation to the sandbox API and get Claude's reply. */
export async function sendChat(messages: WireMessage[]): Promise<ChatResponse> {
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages }),
  });

  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Request failed (${res.status})`);
  }

  return res.json() as Promise<ChatResponse>;
}
