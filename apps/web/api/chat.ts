import { runChat } from "../server/agent";
import type { ChatMessage } from "../shared/types";

// Vercel Function (Web signature). Maps to POST /api/chat.
// On Vercel, @vercel/sandbox authenticates automatically via OIDC — no token
// setup needed. Set ANTHROPIC_API_KEY and SANDBOX_BACKEND=vercel as project
// environment variables in the Vercel dashboard.
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

  try {
    const result = await runChat(messages);
    return Response.json(result);
  } catch (err) {
    console.error("chat failed:", err);
    return Response.json({ error: (err as Error).message }, { status: 500 });
  }
}
