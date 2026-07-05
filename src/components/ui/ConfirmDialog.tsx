"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { AlertTriangle, HelpCircle } from "lucide-react";
import { Button } from "./Button";

/**
 * App-styled replacement for the native `window.confirm`. Exposed as a
 * promise-based `useConfirm()` so call sites read almost identically to the
 * old `if (!confirm(...)) return;` pattern:
 *
 *   const confirm = useConfirm();
 *   if (!(await confirm({ title, message, tone: "danger" }))) return;
 *
 * Mirrors the ToastProvider pattern — one provider near the app root, an
 * imperative hook anywhere below it. Esc / backdrop click cancel; Enter
 * (confirm button is autofocused) confirms.
 */

type ConfirmTone = "default" | "danger";

interface ConfirmOptions {
  title: string;
  message?: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: ConfirmTone;
}

type ConfirmFn = (opts: ConfirmOptions) => Promise<boolean>;

const ConfirmCtx = React.createContext<ConfirmFn | null>(null);

interface ConfirmState extends ConfirmOptions {
  id: number;
  resolve: (value: boolean) => void;
}

export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = React.useState<ConfirmState | null>(null);
  const nextId = React.useRef(1);
  const [mounted, setMounted] = React.useState(false);

  React.useEffect(() => setMounted(true), []);

  const confirm = React.useCallback<ConfirmFn>(
    (opts) =>
      new Promise<boolean>((resolve) => {
        setState({ ...opts, id: nextId.current++, resolve });
      }),
    []
  );

  // Settle the outstanding promise and dismiss. Guarded so a second call
  // (e.g. Esc firing after a button click) can't resolve twice.
  const close = React.useCallback((result: boolean) => {
    setState((cur) => {
      cur?.resolve(result);
      return null;
    });
  }, []);

  // Esc cancels — capture phase so it wins over any underlying Esc handlers
  // (timelines, sheets) while the dialog owns the foreground. Enter is left
  // to the autofocused confirm button's native activation.
  React.useEffect(() => {
    if (!state) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        close(false);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [state, close]);

  // Lock body scroll while open.
  React.useEffect(() => {
    if (!state) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [state]);

  const danger = state?.tone === "danger";

  return (
    <ConfirmCtx.Provider value={confirm}>
      {children}
      {mounted &&
        createPortal(
          <AnimatePresence>
            {state && (
              <motion.div
                key={state.id}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.18 }}
                onClick={() => close(false)}
                className="fixed inset-0 z-[141] flex items-center justify-center bg-ink/80 px-4 py-6 backdrop-blur-xl"
              >
                <motion.div
                  role="alertdialog"
                  aria-modal="true"
                  aria-labelledby="confirm-title"
                  initial={{ opacity: 0, y: 16, scale: 0.97 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: 16, scale: 0.97 }}
                  transition={{ duration: 0.26, ease: [0.22, 1, 0.36, 1] }}
                  onClick={(e) => e.stopPropagation()}
                  className="relative w-full max-w-md overflow-hidden rounded-2xl border border-white/10 bg-surface/95 p-6 shadow-cinematic backdrop-blur-xl"
                >
                  <div className="flex gap-4">
                    <span
                      className={
                        "mt-0.5 inline-flex size-10 shrink-0 items-center justify-center rounded-full " +
                        (danger
                          ? "bg-rose-500/15 text-rose-300"
                          : "bg-violet-500/15 text-violet-300")
                      }
                    >
                      {danger ? (
                        <AlertTriangle size={18} />
                      ) : (
                        <HelpCircle size={18} />
                      )}
                    </span>
                    <div className="min-w-0 flex-1">
                      <h2
                        id="confirm-title"
                        className="font-display text-lg font-semibold text-white"
                      >
                        {state.title}
                      </h2>
                      {state.message && (
                        <div className="mt-2 text-sm leading-relaxed text-fog">
                          {state.message}
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="mt-6 flex justify-end gap-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => close(false)}
                    >
                      {state.cancelLabel ?? "Cancel"}
                    </Button>
                    <Button
                      autoFocus
                      variant={danger ? "danger" : "primary"}
                      size="sm"
                      onClick={() => close(true)}
                    >
                      {state.confirmLabel ?? "Confirm"}
                    </Button>
                  </div>
                </motion.div>
              </motion.div>
            )}
          </AnimatePresence>,
          document.body
        )}
    </ConfirmCtx.Provider>
  );
}

export function useConfirm(): ConfirmFn {
  const ctx = React.useContext(ConfirmCtx);
  // Fallback: if a consumer mounts outside the provider, resolve to the safe
  // (cancelled) choice rather than fall back to the native browser dialog.
  return ctx ?? (() => Promise.resolve(false));
}
