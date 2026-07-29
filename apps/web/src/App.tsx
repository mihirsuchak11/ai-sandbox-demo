import { useState } from "react";
import {
  MessageScrollerProvider,
  MessageScroller,
  MessageScrollerViewport,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerButton,
} from "@/components/ui/message-scroller";
import { Message, MessageContent } from "@/components/ui/message";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Marker, MarkerContent } from "@/components/ui/marker";
import { Button } from "@/components/ui/button";
import { sendChatStream, type UiMessage, type ToolRun } from "@/lib/api";

export default function App() {
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Live task state, rebuilt on each new run: the steps seen so far and the
  // current phase label. These render immediately as SSE events arrive.
  const [liveRuns, setLiveRuns] = useState<ToolRun[]>([]);
  const [liveStatus, setLiveStatus] = useState<string | null>(null);

  async function send() {
    const text = input.trim();
    if (!text || loading) return;

    const nextMessages: UiMessage[] = [...messages, { role: "user", content: text }];
    setMessages(nextMessages);
    setInput("");
    setError(null);
    setLoading(true);
    setLiveRuns([]);
    setLiveStatus(null);

    try {
      const wire = nextMessages.map((m) => ({ role: m.role, content: m.content }));
      await sendChatStream(wire, (event) => {
        switch (event.type) {
          case "status":
            setLiveStatus(event.message);
            break;
          case "tool":
            // Append each step as it happens so the user watches progress.
            setLiveRuns((runs) => [...runs, event.run]);
            break;
          case "done":
            setMessages([
              ...nextMessages,
              { role: "assistant", content: event.reply, toolRuns: event.toolRuns },
            ]);
            break;
          case "error":
            setError(event.error);
            break;
        }
      });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
      setLiveRuns([]);
      setLiveStatus(null);
    }
  }

  return (
    <div className="flex h-dvh flex-col">
      <MessageScrollerProvider>
        <MessageScroller className="flex-1">
          <MessageScrollerViewport>
            <MessageScrollerContent>
              {messages.map((m, i) => (
                <MessageScrollerItem key={i} scrollAnchor={i === messages.length - 1}>
                  <Message align={m.role === "user" ? "end" : "start"}>
                    <MessageContent>
                      {m.toolRuns?.map((run, j) => (
                        <div key={j}>
                          <Marker variant="separator">
                            <MarkerContent>{run.summary}</MarkerContent>
                          </Marker>
                          <Bubble variant="muted">
                            <BubbleContent>
                              <pre>{run.output}</pre>
                            </BubbleContent>
                          </Bubble>
                        </div>
                      ))}
                      <Bubble variant={m.role === "user" ? "default" : "secondary"}>
                        <BubbleContent>{m.content}</BubbleContent>
                      </Bubble>
                    </MessageContent>
                  </Message>
                </MessageScrollerItem>
              ))}

              {loading && (
                <MessageScrollerItem scrollAnchor>
                  <Message align="start">
                    <MessageContent>
                      {liveRuns.map((run, j) => (
                        <div key={j}>
                          <Marker variant="separator">
                            <MarkerContent>{run.summary}</MarkerContent>
                          </Marker>
                          <Bubble variant="muted">
                            <BubbleContent>
                              <pre>{run.output}</pre>
                            </BubbleContent>
                          </Bubble>
                        </div>
                      ))}
                      <Marker>
                        <MarkerContent>
                          {liveStatus ?? "Starting…"}
                        </MarkerContent>
                      </Marker>
                    </MessageContent>
                  </Message>
                </MessageScrollerItem>
              )}

              {error && (
                <MessageScrollerItem>
                  <Marker>
                    <MarkerContent>Error: {error}</MarkerContent>
                  </Marker>
                </MessageScrollerItem>
              )}
            </MessageScrollerContent>
          </MessageScrollerViewport>
          <MessageScrollerButton />
        </MessageScroller>
      </MessageScrollerProvider>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
        className="flex gap-2 p-4"
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask Claude to clone a repo, make a change, and open a PR…"
          disabled={loading}
          className="flex-1 rounded-md border px-3 py-2 text-sm"
        />
        <Button type="submit" disabled={loading || !input.trim()}>
          Send
        </Button>
      </form>
    </div>
  );
}
