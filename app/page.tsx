"use client";

import { useState, useRef, useEffect } from "react";
import ReactMarkdown from "react-markdown";

type Block = { type: string; [key: string]: any };
type Msg = { role: "user" | "assistant"; content: string | Block[] };

const SUGGESTIONS = [
  "How's our pipeline looking for the Renewables sector?",
  "What's our total revenue collected so far?",
  "Which sector has the most work orders stuck on billing?",
  "Give me a leadership update",
];

function toolLabel(name: string): string {
  switch (name) {
    case "get_work_orders":
      return "Checking Work Orders…";
    case "get_deals":
      return "Checking Deals pipeline…";
    case "aggregate_work_orders":
      return "Crunching Work Orders totals…";
    case "aggregate_deals":
      return "Crunching pipeline totals…";
    case "generate_leadership_update":
      return "Compiling leadership update…";
    default:
      return "Working…";
  }
}

export default function Page() {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, loading]);

  async function send(text: string) {
    if (!text.trim() || loading) return;
    setError(null);
    const next: Msg[] = [...messages, { role: "user", content: text }];
    setMessages(next);
    setInput("");
    setLoading(true);
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: next }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Something went wrong.");
        return;
      }
      setMessages(data.messages);
    } catch (e: any) {
      setError(e?.message ?? "Network error");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="app">
      <div className="header">
        <h1>Skylark BI Agent</h1>
        <p>Ask founder-level questions about pipeline, revenue, and operations — live from monday.com.</p>
        <div className="byline">Yashas R · 3rd Sem MCA, Jain University · USN 25MCAR0042</div>
      </div>

      <div className="messages" ref={scrollRef}>
        {messages.length === 0 && (
          <div className="msg assistant">
            Hi — I can answer questions about the Deals pipeline and Work Orders execution/billing data,
            pulled live from monday.com. Try one of the suggestions below, or ask your own.
          </div>
        )}

        {messages.map((m, i) => {
          if (m.role === "user") {
            if (typeof m.content !== "string") return null;
            return (
              <div className="msg user" key={i}>
                {m.content}
              </div>
            );
          }
          const blocks = m.content as Block[];
          const textBlocks = blocks.filter((b) => b.type === "text");
          const toolBlocks = blocks.filter((b) => b.type === "tool_use");
          return (
            <div key={i}>
              {toolBlocks.map((tb, j) => (
                <div className="msg tool-note" key={`t-${j}`}>
                  {toolLabel(tb.name)}
                </div>
              ))}
              {textBlocks.map((tb, j) => (
                <div className="msg assistant" key={`x-${j}`}>
                  <ReactMarkdown>{tb.text}</ReactMarkdown>
                </div>
              ))}
            </div>
          );
        })}

        {loading && <div className="msg tool-note">Thinking…</div>}
      </div>

      {error && <div className="error-banner">{error}</div>}

      {messages.length === 0 && (
        <div className="suggestions">
          {SUGGESTIONS.map((s) => (
            <div className="suggestion" key={s} onClick={() => send(s)}>
              {s}
            </div>
          ))}
        </div>
      )}

      <form
        className="input-bar"
        onSubmit={(e) => {
          e.preventDefault();
          send(input);
        }}
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask about pipeline, revenue, or operations…"
          disabled={loading}
        />
        <button type="submit" disabled={loading || !input.trim()}>
          Send
        </button>
      </form>
    </div>
  );
}
