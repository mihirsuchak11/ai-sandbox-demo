import { runChat } from "../server/agent.js";
import type { ChatMessage, ProgressEvent } from "../shared/types.js";

// Vercel Function (Web signature). Maps to POST /api/chat.
// On Vercel, @vercel/sandbox authenticates automatically via OIDC — no token
// setup needed. Set ANTHROPIC_API_KEY and SANDBOX_BACKEND=vercel as project
// environment variables in the Vercel dashboard.
//
// The response is a Server-Sent Events stream of ProgressEvent objects so the
// UI shows each step (clone → edit → test → push → PR) live as it happens,
// ending with a `done` (or `error`) event.
export async function POST(request: Request): Promise<Response> {
  let body: { messages?: ChatMessage[] };
  try {
    body = (await request.json()) as { messages?: ChatMessage[] };
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const messages = body.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    return Response.json({ error: "messages must be a non-empty array" }, { status: 400 });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: ProgressEvent) =>
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      try {
        const result = await runChat(messages, send);
        send({ type: "done", reply: result.reply, toolRuns: result.toolRuns });
      } catch (err) {
        console.error("chat failed:", err);
        send({ type: "error", error: (err as Error).message });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
