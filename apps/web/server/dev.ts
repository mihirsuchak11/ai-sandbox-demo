import "./env.js"; // must run BEFORE ./agent (loads .env + .env.local into process.env)
import express from "express";
import { runChat } from "./agent.js";
import type { ChatMessage, ProgressEvent } from "../shared/types.js";

const app = express();
app.use(express.json());

/**
 * POST /api/chat
 * Body: { messages: [{ role, content }, ...] }  (the full conversation so far)
 * Returns: a Server-Sent Events stream of ProgressEvent objects — one `status`
 * per phase, one `tool` per tool call, then a final `done` (or `error`). The UI
 * renders each event live so the user watches the task progress step by step.
 */
app.post("/api/chat", async (req, res) => {
  const messages = req.body?.messages as ChatMessage[] | undefined;

  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: "messages must be a non-empty array" });
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const send = (event: ProgressEvent) => res.write(`data: ${JSON.stringify(event)}\n\n`);

  try {
    const result = await runChat(messages, send);
    send({ type: "done", reply: result.reply, toolRuns: result.toolRuns });
  } catch (err) {
    console.error("chat failed:", err);
    send({ type: "error", error: (err as Error).message });
  } finally {
    res.end();
  }
});

const PORT = Number(process.env.PORT) || 3001;
app.listen(PORT, () => {
  console.log(`🧪 Sandbox chat API listening on http://localhost:${PORT}`);
});
