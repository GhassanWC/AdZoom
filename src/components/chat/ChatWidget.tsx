"use client";

import * as React from "react";
import { usePathname } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import {
  MessageCircle,
  X,
  Send,
  Sparkles,
  RefreshCw,
  Loader2,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { useChatStream, type ChatMessage } from "./useChatStream";
import { BRAND, BRAND_STRINGS } from "@/lib/branding";

/**
 * Floating chat widget. Bubble button bottom-right; panel opens on
 * click. Mounted in the root layout so every route gets it, except
 * the in-editor route where the dashboard chrome already has its own
 * busy surface.
 *
 * Visual contract — panel is ALWAYS dark-themed regardless of the
 * page's light/dark mode, so all text uses arbitrary color values
 * (`text-[#fff]`, `text-[rgba(255,255,255,0.7)]`) that bypass the
 * global `html.light .text-white` override.
 */
export function ChatWidget() {
  const pathname = usePathname();
  const [open, setOpen] = React.useState(false);
  const { messages, streaming, error, send, reset } = useChatStream();

  // Hide on the editor route — it has its own dense chrome and a
  // floating bubble would steal click targets near the timeline.
  const isEditor = /^\/dashboard\/projects\/[^/]+$/.test(pathname ?? "");
  if (isEditor) return null;

  // The workspace pins the theme dock to the bottom edge (components/ui/
  // ThemeDock), so the bubble steps up out of its way there. Everywhere else —
  // landing, pricing, docs — it keeps the corner to itself.
  const aboveThemeDock = (pathname ?? "").startsWith("/dashboard");

  return (
    <>
      {/* Floating bubble — bottom-right on every page */}
      <button
        type="button"
        aria-label={open ? "Close chat" : `Open chat with ${BRAND.name}`}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "fixed right-5 z-50 inline-flex size-14 items-center justify-center rounded-full text-white shadow-[0_18px_38px_-10px_rgba(139,92,246,0.7)] transition-transform duration-200 hover:scale-[1.04] active:scale-95",
          aboveThemeDock ? "bottom-16" : "bottom-5",
          "bg-gradient-to-br from-violet-500 to-violet-600"
        )}
      >
        <AnimatePresence mode="wait" initial={false}>
          {open ? (
            <motion.span
              key="x"
              initial={{ rotate: -90, opacity: 0 }}
              animate={{ rotate: 0, opacity: 1 }}
              exit={{ rotate: 90, opacity: 0 }}
              transition={{ duration: 0.18 }}
            >
              <X size={20} />
            </motion.span>
          ) : (
            <motion.span
              key="msg"
              initial={{ rotate: 90, opacity: 0 }}
              animate={{ rotate: 0, opacity: 1 }}
              exit={{ rotate: -90, opacity: 0 }}
              transition={{ duration: 0.18 }}
            >
              <MessageCircle size={22} className="fill-white/15" />
            </motion.span>
          )}
        </AnimatePresence>
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            key="panel"
            initial={{ opacity: 0, y: 16, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 10, scale: 0.98 }}
            transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
            className={cn(
              "fixed z-50 overflow-hidden rounded-2xl border border-white/10 shadow-[0_30px_60px_-20px_rgba(0,0,0,0.6)] backdrop-blur-xl",
              // mobile: full-width drawer from bottom
              "inset-x-3 bottom-24",
              // desktop: 384px wide, anchored bottom-right above the bubble
              "sm:inset-x-auto sm:bottom-24 sm:right-5 sm:w-[384px]"
            )}
            style={{ backgroundColor: "rgba(10,10,26,0.92)" }}
          >
            <Header onReset={reset} onClose={() => setOpen(false)} />
            <MessageList messages={messages} streaming={streaming} />
            {error && (
              <div className="border-t border-white/10 bg-rose-500/10 px-4 py-2 text-[12px] text-rose-200">
                {error}
              </div>
            )}
            <Composer onSend={send} disabled={streaming} />
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}

function Header({
  onReset,
  onClose,
}: {
  onReset: () => void;
  onClose: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-white/10 px-4 py-3.5">
      <div className="flex items-center gap-2.5">
        <span className="inline-flex size-9 items-center justify-center rounded-full bg-gradient-to-br from-violet-400 to-violet-600 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.18)]">
          <Sparkles size={14} />
        </span>
        <div className="leading-tight">
          <div className="text-[13.5px] font-semibold text-[#fff]">
            {BRAND_STRINGS.askBrand}
          </div>
          <div className="text-[10.5px] text-[rgba(255,255,255,0.55)]">
            Editing, cuts, speed, canvas, and export help
          </div>
        </div>
      </div>
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={onReset}
          aria-label="Reset conversation"
          title="Reset conversation"
          className="inline-flex size-7 items-center justify-center rounded-md text-[rgba(255,255,255,0.7)] transition-colors hover:bg-white/[0.08] hover:text-[#fff]"
        >
          <RefreshCw size={12} />
        </button>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close chat"
          className="inline-flex size-7 items-center justify-center rounded-md text-[rgba(255,255,255,0.7)] transition-colors hover:bg-white/[0.08] hover:text-[#fff]"
        >
          <X size={13} />
        </button>
      </div>
    </div>
  );
}

function MessageList({
  messages,
  streaming,
}: {
  messages: ChatMessage[];
  streaming: boolean;
}) {
  const scrollRef = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, streaming]);

  if (messages.length === 0) {
    return (
      <div
        ref={scrollRef}
        className="h-[440px] overflow-y-auto px-4 py-5 sm:h-[440px]"
      >
        <Welcome />
      </div>
    );
  }

  return (
    <div
      ref={scrollRef}
      className="h-[440px] space-y-3 overflow-y-auto px-4 py-4 sm:h-[440px]"
    >
      {messages.map((m, i) => {
        const isLast = i === messages.length - 1;
        const isLastAssistant =
          isLast && m.role === "assistant" && streaming;
        return <Bubble key={m.id} message={m} typing={isLastAssistant} />;
      })}
    </div>
  );
}

const SUGGESTIONS = [
  `How does ${BRAND.name} edit my video?`,
  "What are Camera edits, Cuts, and Speed?",
  "Can I choose what AI generates?",
  "How does Canvas Fit work?",
  `Can ${BRAND.name} export to TikTok, Reels, Shorts, and YouTube?`,
  "Can I upload videos, or only record?",
  "What is the free plan limit?",
  "Can I edit or delete AI-generated moments?",
  "Does export keep audio?",
  "Can export run in the background?",
];

function Welcome() {
  return (
    <div className="flex h-full flex-col justify-end">
      <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-4">
        <p className="text-[13px] leading-relaxed text-[rgba(255,255,255,0.85)]">
          Hi — I&apos;m {BRAND.name}&apos;s assistant. Ask me about editing,
          cuts, speed, canvas, and export.
        </p>
      </div>
      <div className="mt-4 grid gap-1.5">
        <p className="px-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-[rgba(255,255,255,0.5)]">
          Try asking
        </p>
        {SUGGESTIONS.map((s) => (
          <SuggestionPill key={s} text={s} />
        ))}
      </div>
    </div>
  );
}

function SuggestionPill({ text }: { text: string }) {
  // Each pill triggers `send()` via a custom event so the parent
  // hook doesn't need to be threaded through. Keeps this dumb-render.
  return (
    <button
      type="button"
      onClick={() => {
        window.dispatchEvent(
          new CustomEvent("adzoom:chat-suggest", { detail: text })
        );
      }}
      className="rounded-lg border border-white/10 bg-white/[0.02] px-3 py-2 text-left text-[12.5px] text-[rgba(255,255,255,0.8)] transition-colors hover:border-violet-400/40 hover:bg-violet-500/10 hover:text-[#fff]"
    >
      {text}
    </button>
  );
}

function Bubble({
  message,
  typing,
}: {
  message: ChatMessage;
  typing: boolean;
}) {
  const isUser = message.role === "user";
  return (
    <div className={cn("flex", isUser ? "justify-end" : "justify-start")}>
      <div
        className={cn(
          "max-w-[85%] whitespace-pre-wrap rounded-2xl px-3.5 py-2 text-[13.5px] leading-relaxed",
          isUser
            ? "bg-violet-500 text-white"
            : "border border-white/10 bg-white/[0.04] text-[rgba(255,255,255,0.92)]"
        )}
      >
        {message.content}
        {typing && message.content.length === 0 && (
          <span className="inline-flex items-center gap-1 text-[rgba(255,255,255,0.6)]">
            <Loader2 size={12} className="animate-spin" />
            <span>Thinking…</span>
          </span>
        )}
        {typing && message.content.length > 0 && (
          <span className="ml-0.5 inline-block h-[1em] w-[1px] -translate-y-[1px] animate-pulse bg-white/85 align-middle" />
        )}
      </div>
    </div>
  );
}

function Composer({
  onSend,
  disabled,
}: {
  onSend: (text: string) => void;
  disabled: boolean;
}) {
  const [value, setValue] = React.useState("");
  const taRef = React.useRef<HTMLTextAreaElement | null>(null);

  // Listen for suggestion-pill clicks → send immediately.
  React.useEffect(() => {
    const onSuggest = (e: Event) => {
      const detail = (e as CustomEvent<string>).detail;
      if (typeof detail === "string") onSend(detail);
    };
    window.addEventListener("adzoom:chat-suggest", onSuggest);
    return () => window.removeEventListener("adzoom:chat-suggest", onSuggest);
  }, [onSend]);

  // Auto-grow the textarea between 1 and 4 lines.
  React.useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(96, ta.scrollHeight)}px`;
  }, [value]);

  const submit = () => {
    if (disabled) return;
    const trimmed = value.trim();
    if (!trimmed) return;
    onSend(trimmed);
    setValue("");
    const ta = taRef.current;
    if (ta) ta.style.height = "auto";
  };

  return (
    <div className="border-t border-white/10 p-3">
      <div className="flex items-end gap-2 rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2 focus-within:border-violet-400/50">
        <textarea
          ref={taRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder="Ask about Framevo…"
          rows={1}
          disabled={disabled}
          className="max-h-24 min-h-[20px] flex-1 resize-none bg-transparent text-[13.5px] leading-snug text-[#fff] placeholder:text-[rgba(255,255,255,0.4)] focus:outline-none disabled:opacity-60"
        />
        <button
          type="button"
          onClick={submit}
          disabled={disabled || value.trim().length === 0}
          aria-label="Send"
          className={cn(
            "inline-flex size-8 shrink-0 items-center justify-center rounded-lg transition-colors",
            value.trim().length > 0 && !disabled
              ? "bg-violet-500 text-white hover:bg-violet-500/90"
              : "bg-white/[0.06] text-[rgba(255,255,255,0.4)]"
          )}
        >
          {disabled ? (
            <Loader2 size={13} className="animate-spin" />
          ) : (
            <Send size={13} />
          )}
        </button>
      </div>
      <p className="mt-1.5 px-1 text-[10px] text-[rgba(255,255,255,0.4)]">
        Press <kbd className="font-mono">Enter</kbd> to send ·{" "}
        <kbd className="font-mono">Shift+Enter</kbd> for newline
      </p>
    </div>
  );
}
