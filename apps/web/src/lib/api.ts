import type { ChatMessage, ChatResult, ToolRun, UiMessage, ProgressEvent } from "../../shared/types";

// Re-export the shared types so components can import them from here.
export type { ChatMessage, ChatResult, ToolRun, UiMessage, ProgressEvent };

/**
 * POST the conversation to the sandbox API and consume the Server-Sent Events
 * stream, calling `onEvent` for every ProgressEvent as it arrives (status,
 * tool, done, error). This is what makes each step show up in the UI live
 * instead of all at once when the task finishes.
 */
export async function sendChatStream(
  messages: ChatMessage[],
  onEvent: (event: ProgressEvent) => void,
): Promise<void> {
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages }),
  });

  if (!res.ok || !res.body) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Request failed (${res.status})`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  // SSE frames are separated by a blank line; each frame is one `data: <json>`.
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let sep: number;
    while ((sep = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const line = frame.split("\n").find((l) => l.startsWith("data:"));
      if (!line) continue;
      onEvent(JSON.parse(line.slice(5).trim()) as ProgressEvent);
    }
  }
}
