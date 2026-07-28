// Shared contract between the API (server/) and the UI (src/).
// One definition — no more drift between backend and frontend.

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ToolRun {
  language: "node";
  code: string;
  output: string;
}

export interface ChatResult {
  reply: string;
  toolRuns: ToolRun[];
}

/** A message held in the UI (may carry the code the assistant ran). */
export interface UiMessage extends ChatMessage {
  toolRuns?: ToolRun[];
}
