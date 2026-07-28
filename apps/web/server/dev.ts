import "./env"; // must run BEFORE ./agent (loads .env + .env.local into process.env)
import express from "express";
import { runChat } from "./agent";
import type { ChatMessage } from "../shared/types";

const app = express();
app.use(express.json());

/**
 * POST /api/chat
 * Body: { messages: [{ role, content }, ...] }  (the full conversation so far)
 * Returns: { reply, toolRuns }
 */
app.post("/api/chat", async (req, res) => {
  const messages = req.body?.messages as ChatMessage[] | undefined;

  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: "messages must be a non-empty array" });
  }

  try {
    const result = await runChat(messages);
    res.json(result);
  } catch (err) {
    console.error("chat failed:", err);
    res.status(500).json({ error: (err as Error).message });
  }
});

const PORT = Number(process.env.PORT) || 3001;
app.listen(PORT, () => {
  console.log(`🧪 Sandbox chat API listening on http://localhost:${PORT}`);
});
