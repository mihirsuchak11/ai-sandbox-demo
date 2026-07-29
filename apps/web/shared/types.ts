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

/**
 * A single progress event streamed to the UI while a task runs, so the user
 * sees each step live instead of waiting for the whole pipeline to finish.
 *
 * - `status`: a phase label with no tool output ("Creating sandbox…").
 * - `tool`:   one tool call the agent just made (clone, write_file, push, …).
 * - `done`:   the task finished; carries the final reply + full tool list.
 * - `error`:  the task failed; `error` is the message to show.
 *
 * `status` and `tool` are emitted by the agent as work happens; `done` and
 * `error` are emitted once by the transport when the task settles.
 */
export type ProgressEvent =
  | { type: "status"; message: string }
  | { type: "tool"; run: ToolRun }
  | { type: "done"; reply: string; toolRuns: ToolRun[] }
  | { type: "error"; error: string };

/** A message held in the UI (may carry the code the assistant ran). */
export interface UiMessage extends ChatMessage {
  toolRuns?: ToolRun[];
}
