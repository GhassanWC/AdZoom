"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { Check, AlertCircle, Sparkles } from "lucide-react";

type ToastKind = "success" | "error" | "info";
interface Toast {
  id: number;
  kind: ToastKind;
  title: string;
  body?: string;
}

interface ToastApi {
  show: (t: Omit<Toast, "id">) => void;
  success: (title: string, body?: string) => void;
  error: (title: string, body?: string) => void;
  info: (title: string, body?: string) => void;
}

const ToastCtx = React.createContext<ToastApi | null>(null);

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = React.useState<Toast[]>([]);
  const nextId = React.useRef(1);
  const [mounted, setMounted] = React.useState(false);

  React.useEffect(() => setMounted(true), []);

  const dismiss = React.useCallback((id: number) => {
    setToasts((arr) => arr.filter((t) => t.id !== id));
  }, []);

  const show = React.useCallback(
    (t: Omit<Toast, "id">) => {
      const id = nextId.current++;
      setToasts((arr) => [...arr, { ...t, id }]);
      setTimeout(() => dismiss(id), 2800);
    },
    [dismiss]
  );

  const api = React.useMemo<ToastApi>(
    () => ({
      show,
      success: (title, body) => show({ kind: "success", title, body }),
      error: (title, body) => show({ kind: "error", title, body }),
      info: (title, body) => show({ kind: "info", title, body }),
    }),
    [show]
  );

  return (
    <ToastCtx.Provider value={api}>
      {children}
      {mounted &&
        createPortal(
          <div className="pointer-events-none fixed bottom-6 left-1/2 z-[120] flex w-full max-w-md -translate-x-1/2 flex-col items-center gap-2 px-4">
            <AnimatePresence>
              {toasts.map((t) => (
                <motion.div
                  key={t.id}
                  layout
                  initial={{ opacity: 0, y: 12, scale: 0.96 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: 12, scale: 0.96 }}
                  transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
                  className="pointer-events-auto flex w-full items-start gap-3 rounded-xl border border-white/10 bg-surface/95 px-4 py-3 shadow-cinematic backdrop-blur-xl"
                >
                  <ToastIcon kind={t.kind} />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-white">{t.title}</div>
                    {t.body && (
                      <div className="mt-0.5 truncate text-[11px] text-fog">{t.body}</div>
                    )}
                  </div>
                </motion.div>
              ))}
            </AnimatePresence>
          </div>,
          document.body
        )}
    </ToastCtx.Provider>
  );
}

function ToastIcon({ kind }: { kind: ToastKind }) {
  if (kind === "success") {
    return (
      <span className="mt-0.5 inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-emerald-500 text-white">
        <Check size={11} />
      </span>
    );
  }
  if (kind === "error") {
    return (
      <span className="mt-0.5 inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-rose-500 text-white">
        <AlertCircle size={11} />
      </span>
    );
  }
  return (
    <span className="mt-0.5 inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-violet-500 text-white">
      <Sparkles size={11} />
    </span>
  );
}

export function useToast(): ToastApi {
  const ctx = React.useContext(ToastCtx);
  if (!ctx) {
    // Fallback: no-op API in case a consumer mounts outside the provider.
    return {
      show: () => {},
      success: () => {},
      error: () => {},
      info: () => {},
    };
  }
  return ctx;
}
