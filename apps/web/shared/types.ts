// Shared contract between the API (server/) and the UI (src/).
// One definition — no more drift between backend and frontend.

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

/**
 * One tool call the agent made inside the sandbox, shown in the UI.
 * `tool` is the tool name (run_command, write_file, read_file,
 * open_pull_request); `summary` is a one-line human label (e.g. the shell
 * command or "wrote src/foo.ts"); `output` is the result text.
 */
export interface ToolRun {
  tool: string;
  summary: string;
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
