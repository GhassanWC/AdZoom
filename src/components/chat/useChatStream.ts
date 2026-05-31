"use client";

import * as React from "react";

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
}

const STORAGE_KEY = "adzoom.chat.history";
const MAX_PERSIST = 30;

/**
 * Owns the chat state for the floating widget:
 *   - the messages array (rehydrated from localStorage on mount)
 *   - a `streaming` flag (input is disabled while true)
 *   - `send()` — appends the user message, POSTs the full history to
 *     `/api/chat`, reads the SSE stream, appends chunks to the
 *     in-flight assistant message
 *   - `reset()` — clears state and localStorage
 *   - `error` — last-error string the panel can render
 */
export function useChatStream() {
  const [messages, setMessages] = React.useState<ChatMessage[]>([]);
  const [streaming, setStreaming] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const abortRef = React.useRef<AbortController | null>(null);

  // Rehydrate from localStorage once on mount. Wrapped in try/catch so
  // a corrupt entry doesn't crash the widget.
  React.useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as ChatMessage[];
      if (Array.isArray(parsed)) setMessages(parsed.slice(-MAX_PERSIST));
    } catch {
      // ignore — start fresh
    }
  }, []);

  // Persist on every change. The reducer-style functional update in
  // `send()` keeps this in sync without a separate effect chain.
  React.useEffect(() => {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify(messages.slice(-MAX_PERSIST))
      );
    } catch {
      // quota / private-mode failures are non-fatal
    }
  }, [messages]);

  const send = React.useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || streaming) return;
      setError(null);

      const userMsg: ChatMessage = {
        id: `u_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        role: "user",
        content: trimmed,
      };
      const assistantMsg: ChatMessage = {
        id: `a_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        role: "assistant",
        content: "",
      };

      // Capture the conversation to send (includes the new user turn,
      // excludes the empty assistant placeholder which is local-only).
      const toSend = [...messages, userMsg].map((m) => ({
        role: m.role,
        content: m.content,
      }));

      setMessages((prev) => [...prev, userMsg, assistantMsg]);
      setStreaming(true);

      const abort = new AbortController();
      abortRef.current = abort;

      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messages: toSend }),
          signal: abort.signal,
        });

        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as {
            error?: string;
            retryInSeconds?: number;
          };
          const message =
            body.error ?? "Couldn't reach the assistant. Try again.";
          setError(message);
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantMsg.id ? { ...m, content: message } : m
            )
          );
          return;
        }

        if (!res.body) {
          throw new Error("No response body.");
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        let appended = "";

        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });

          // SSE events are separated by a blank line. Each event may
          // span multiple `data:` lines.
          const events = buf.split("\n\n");
          buf = events.pop() ?? ""; // last item may be partial

          for (const ev of events) {
            const lines = ev.split("\n");
            const dataLines = lines
              .filter((l) => l.startsWith("data: "))
              .map((l) => l.slice(6));
            if (dataLines.length === 0) continue;
            const payload = dataLines.join("\n");
            if (payload === "[DONE]") continue;
            appended += payload;
            setMessages((prev) =>
              prev.map((m) =>
                m.id === assistantMsg.id
                  ? { ...m, content: appended }
                  : m
              )
            );
          }
        }
      } catch (err) {
        // Aborted by reset() — silently swallow.
        if (err instanceof DOMException && err.name === "AbortError") return;
        const msg = err instanceof Error ? err.message : "Unknown error.";
        setError(msg);
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantMsg.id
              ? { ...m, content: `Sorry — ${msg}` }
              : m
          )
        );
      } finally {
        setStreaming(false);
        abortRef.current = null;
      }
    },
    [messages, streaming]
  );

  const reset = React.useCallback(() => {
    abortRef.current?.abort();
    setMessages([]);
    setStreaming(false);
    setError(null);
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // ignore
    }
  }, []);

  return { messages, streaming, error, send, reset };
}
