"use client";

/**
 * Bringing a video in from this computer — the desktop's import flow, in one
 * place because it now has three entry points: the Import page's drop zone,
 * that page's Choose-a-video button, and the dashboard's Quick start card.
 *
 * All three do exactly the same thing (validate → create a local project → open
 * the editor), so they share this rather than each re-implementing it. The
 * difference between them is only which gesture starts it.
 */

import * as React from "react";
import { useRouter } from "next/navigation";
import { usePlatform } from "@/lib/platform";
import type { ImportedMedia } from "@/lib/platform/types";

/**
 * A file name is the only title we have, and it is usually good enough:
 * `Demo_recording-final.mp4` → `Demo recording final`. An empty result (a file
 * called `.mp4`) falls back rather than creating a project with no name.
 */
export function titleFromFileName(fileName: string): string {
  return (
    fileName
      .replace(/\.[^.]+$/, "")
      .replace(/[_-]+/g, " ")
      .trim() || "Untitled"
  );
}

export interface LocalImport {
  /** True while a file is being probed and its project created. */
  importing: boolean;
  /** User-facing failure from the last attempt, or null. */
  error: string | null;
  clearError: () => void;
  /** Open the OS file picker. No-op if this platform can't. */
  openPicker: () => void;
  /**
   * Import a file the user dropped. Null when the platform has no durable
   * reference to files on disk — the browser — in which case a drop target must
   * not be offered at all.
   */
  importDropped: ((file: File) => void) | null;
}

export function useLocalImport(): LocalImport {
  const router = useRouter();
  const platform = usePlatform();
  const [importing, setImporting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // The editor is the destination for every path through here: an import that
  // ends on the import screen has not finished from the user's point of view.
  const open = React.useCallback(
    async (load: () => Promise<ImportedMedia | null>) => {
      setError(null);
      setImporting(true);
      try {
        const media = await load();
        if (!media) return; // cancelled dialog — not an error
        const doc = await platform.projects.create?.(
          media.mediaId,
          titleFromFileName(media.fileName)
        );
        if (!doc) throw new Error("The project could not be created.");
        router.push(`/dashboard/projects/${doc.id}`);
      } catch (err) {
        setError(err instanceof Error ? err.message : "That video couldn't be imported.");
      } finally {
        setImporting(false);
      }
    },
    [platform, router]
  );

  const media = platform.media;
  const dropImport = media.importDroppedFile;

  const openPicker = React.useCallback(() => {
    if (importing || !media.canPickLocalFiles) return;
    void open(() => media.pickVideo());
  }, [importing, media, open]);

  const importDropped = React.useMemo(() => {
    if (!dropImport) return null;
    return (file: File) => {
      if (importing) return;
      void open(() => dropImport(file));
    };
  }, [dropImport, importing, open]);

  return {
    importing,
    error,
    clearError: React.useCallback(() => setError(null), []),
    openPicker,
    importDropped,
  };
}
