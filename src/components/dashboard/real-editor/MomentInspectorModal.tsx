"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import { X as XIcon, Eye, Trash2, Check } from "lucide-react";
import { useEditorReal } from "./context";
import { MomentInspector } from "./MomentInspector";
import { EditorDialogShell, EditorDialogFooter } from "./EditorDialog";
import { useMomentReview } from "./useMomentReview";
import { Button } from "@/components/ui/Button";

function dialogDebugOn(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return new URL(window.location.href).searchParams.get("debug") === "1";
  } catch {
    return false;
  }
}

/**
 * The moment editor — the ONE editing dialog every timeline edit type opens
 * in (captions, zoom, focus, click, crop, speed, cut, and all overlays).
 * Built on the shared editor dialog system in its FLOATING variant
 * (backdrop=false), which is deliberate:
 *
 *   - NO dim backdrop → the video preview + the draggable crop box stay fully
 *     visible and interactive while editing (crop framing needs the video,
 *     which sits "behind" where a modal backdrop would be), and the timeline
 *     stays clickable so selecting another pill swaps the dialog content in
 *     place.
 *   - Outside-press close → pressing dead space dismisses it, but presses in
 *     "hold" regions (video workspace / timeline / toolbar) and drags that
 *     stray outside the card never do (see shouldCloseOnOutsidePress).
 *   - Esc / ✕ close (shared shell). Focus is trapped inside and returns to
 *     the timeline control that opened it.
 *
 * Header: effect icon/type, editable label, AI-provenance badge, and
 * Previous/Next review navigation with a "12 of 42" position — navigation
 * swaps the content in place (selection + playhead + preview follow).
 * Footer: hold-to-compare Before/After, Reject (undoable delete), Keep edit.
 * Every change saves automatically — same persistence path as before.
 */
export function MomentInspectorModal() {
  const {
    inspectorOpen,
    closeInspector,
    selectedMomentId,
    activeMoment,
    project,
    deleteMoment,
    setCompareBypassId,
  } = useEditorReal();
  const review = useMomentReview();

  const moments = project.analysis?.detectedMoments ?? [];
  const moment = moments.find((m) => m.id === selectedMomentId) || activeMoment || null;
  const visible = inspectorOpen && moment !== null;
  const momentId = moment?.id ?? null;

  // Safety: never leave a compare bypass active when the dialog closes or the
  // reviewed moment changes (navigation / timeline click while holding).
  React.useEffect(() => {
    return () => setCompareBypassId(null);
  }, [momentId, visible, setCompareBypassId]);

  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => setMounted(true), []);

  const reject = () => {
    if (!momentId) return;
    // The existing removal model: an undoable delete (⌘Z restores it).
    void deleteMoment(momentId);
    closeInspector();
  };

  return (
    <>
      {mounted &&
        dialogDebugOn() &&
        createPortal(
          <div className="pointer-events-none fixed bottom-2 left-2 z-[200] rounded bg-black/85 px-2 py-1 font-mono text-[10px] leading-tight text-lime-300">
            settings-dialog: open={String(inspectorOpen)} · visible={String(visible)}
          </div>,
          document.body
        )}
      <EditorDialogShell
        open={visible}
        onClose={closeInspector}
        backdrop={false}
        closeOnOutsidePress
        size="editing"
        ariaLabel="Edit moment"
        className="max-h-[80vh]"
      >
        <button
          type="button"
          onClick={closeInspector}
          aria-label="Close moment settings"
          title="Close (Esc)"
          className="absolute right-2.5 top-2.5 z-20 inline-flex size-10 items-center justify-center rounded-full border border-white/[0.12] bg-white/[0.06] text-fog transition-colors duration-150 hover:border-white/25 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400/60"
        >
          <XIcon size={15} />
        </button>
        <div className="relative z-[1] min-h-0 flex-1 overflow-y-auto overscroll-contain">
          <MomentInspector
            nav={{
              position: review.position,
              hasPrev: review.hasPrev,
              hasNext: review.hasNext,
              onPrev: review.goPrev,
              onNext: review.goNext,
            }}
          />
        </div>
        <EditorDialogFooter className="flex flex-wrap items-center gap-2.5">
          {/* Hold-to-compare: temporarily renders the PREVIEW without this
              edit only — nothing is persisted, export is untouched. */}
          <button
            type="button"
            onPointerDown={() => momentId && setCompareBypassId(momentId)}
            onPointerUp={() => setCompareBypassId(null)}
            onPointerLeave={() => setCompareBypassId(null)}
            onPointerCancel={() => setCompareBypassId(null)}
            onKeyDown={(e) => {
              if ((e.key === " " || e.key === "Enter") && !e.repeat && momentId) {
                e.preventDefault();
                setCompareBypassId(momentId);
              }
            }}
            onKeyUp={(e) => {
              if (e.key === " " || e.key === "Enter") setCompareBypassId(null);
            }}
            onBlur={() => setCompareBypassId(null)}
            title="Hold to preview without this edit"
            className="inline-flex h-9 select-none items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.03] px-3.5 text-[12.5px] font-medium text-fog transition-colors duration-150 hover:border-white/25 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400/60"
          >
            <Eye size={13} />
            Hold to compare
          </button>

          <span className="hidden flex-1 text-[11.5px] text-fog/80 sm:block">
            Changes saved automatically
          </span>

          <div className="ml-auto flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={reject}
              leftIcon={<Trash2 size={13} />}
              className="border-rose-400/25 text-rose-200 hover:border-rose-400/50"
            >
              Reject edit
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={closeInspector}
              leftIcon={<Check size={13} />}
            >
              Keep edit
            </Button>
          </div>
        </EditorDialogFooter>
      </EditorDialogShell>
    </>
  );
}
