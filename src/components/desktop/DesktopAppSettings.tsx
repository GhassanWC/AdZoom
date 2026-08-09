"use client";

import * as React from "react";
import { Check, Cpu, FolderOpen, Info, Monitor, RefreshCw } from "lucide-react";
import { usePlatform } from "@/lib/platform";
import { useDesktopExport } from "@/components/export/DesktopExportProvider";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/cn";

/**
 * The settings that only exist because this is an installed app.
 *
 * Everything above it on the page is the account's workspace settings, stored
 * in Firestore and shared with the website. These four are properties of the
 * MACHINE — which encoder its GPU offers, where its library sits, which build
 * it is running — so they are read from the main process, not from an account.
 *
 * The encoder list is a report, not a choice: exports pick the best available
 * hardware encoder automatically, and offering a dropdown that could select a
 * broken one would be a worse app. Showing which one will be used is the part
 * that actually helps ("why is this render slow?").
 */
export function DesktopAppSettings() {
  const platform = usePlatform();
  const desktopExport = useDesktopExport();
  const app = platform.app;

  if (!app || !platform.storage) return null;

  const encoders = desktopExport?.encoders ?? [];
  const active = desktopExport?.activeEncoder ?? null;

  return (
    <section className="glass space-y-5 rounded-2xl p-6">
      <div>
        <h2 className="flex items-center gap-2 text-sm font-semibold text-white">
          <Monitor size={15} className="text-violet-300" />
          This computer
        </h2>
        <p className="mt-1 text-xs text-fog">
          Settings for the Framevo app installed here. Your workspace settings above are shared with
          framevo.com.
        </p>
      </div>

      <Row label="Version">
        <span className="font-mono text-xs text-white/85">{app.version}</span>
        <span className="ml-2 text-[11px] text-fog">
          {app.updateFeedConfigured ? "Updates on" : "Updates not configured for this build"}
        </span>
      </Row>

      <Row label="Video engine">
        {encoders.length === 0 ? (
          <span className="text-xs text-fog">Detecting…</span>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {encoders.map((encoder) => (
              <span
                key={encoder.id}
                title={encoder.detail ?? (encoder.available ? "Available on this machine" : "Not usable here")}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-lg border px-2 py-1 text-[11px]",
                  encoder.id === active?.id
                    ? "border-emerald-400/35 bg-emerald-500/10 text-emerald-200"
                    : encoder.available
                      ? "border-white/10 bg-white/[0.03] text-white/80"
                      : "border-white/[0.06] bg-white/[0.015] text-fog line-through decoration-white/20"
                )}
              >
                {encoder.id === active?.id && <Check size={10} />}
                {encoder.label}
              </span>
            ))}
          </div>
        )}
        <p className="mt-2 flex items-start gap-1.5 text-[11px] leading-relaxed text-fog">
          <Cpu size={11} className="mt-0.5 shrink-0" />
          Framevo picks the fastest encoder your machine can actually use. Struck-through entries
          aren&apos;t available on this hardware.
        </p>
      </Row>

      <Row label="Library folder">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void platform.storage!.openLibraryFolder()}
            leftIcon={<FolderOpen size={13} />}
          >
            Show in file manager
          </Button>
          <span className="text-[11px] text-fog">
            Holds your projects, edit history and saved recordings.
          </span>
        </div>
      </Row>

      <Row label="Cloud features">
        {app.apiBaseUrl ? (
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-400/30 bg-emerald-500/10 px-2 py-1 text-[11px] text-emerald-200">
              <Check size={10} />
              Connected
            </span>
            <button
              type="button"
              onClick={() => platform.openExternal(app.apiBaseUrl)}
              className="text-[11px] text-fog underline-offset-4 hover:text-white hover:underline"
            >
              {new URL(app.apiBaseUrl).host}
            </button>
          </div>
        ) : (
          <p className="flex items-start gap-1.5 text-[11px] leading-relaxed text-amber-200">
            <Info size={11} className="mt-0.5 shrink-0" />
            This build has no cloud API configured, so AI analysis, captions and billing are
            unavailable. Local editing, preview and export work normally.
          </p>
        )}
      </Row>

      {app.updateFeedConfigured && (
        <Row label="Updates">
          <p className="flex items-start gap-1.5 text-[11px] leading-relaxed text-fog">
            <RefreshCw size={11} className="mt-0.5 shrink-0" />
            Framevo checks for updates in the background and installs them on the next restart.
          </p>
        </Row>
      )}
    </section>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-2 border-t border-white/[0.06] pt-4 sm:grid-cols-[180px_1fr] sm:gap-4">
      <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-fog">{label}</div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}
