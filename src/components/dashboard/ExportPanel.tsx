"use client";

import { Download, Smartphone, Monitor, Settings2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { useEditor } from "./editor-state";
import { cn } from "@/lib/cn";

const resolutions = ["720p", "1080p"] as const;
const fpsOptions = [30, 60] as const;
const formats = [
  { id: "TikTok 9:16" as const, label: "TikTok", desc: "9:16", Icon: Smartphone },
  { id: "YouTube 16:9" as const, label: "YouTube", desc: "16:9", Icon: Monitor },
  { id: "Custom" as const, label: "Custom", desc: "—", Icon: Settings2 },
];

export function ExportPanel() {
  const { exportSettings, updateExport, startExport } = useEditor();

  return (
    <div className="glass rounded-xl">
      <div className="flex items-center gap-2 border-b border-white/[0.06] px-5 py-4">
        <span className="inline-flex size-7 items-center justify-center rounded-lg bg-violet-500/15 text-violet-300">
          <Download size={13} />
        </span>
        <div>
          <h3 className="text-sm font-semibold text-white">Export</h3>
          <p className="text-[11px] text-fog">Ship in any format.</p>
        </div>
      </div>

      <div className="space-y-5 px-5 py-5">
        <div>
          <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-fog">
            Resolution
          </div>
          <div className="grid grid-cols-2 gap-1 rounded-lg border border-white/10 bg-white/[0.02] p-1">
            {resolutions.map((r) => (
              <button
                key={r}
                onClick={() => updateExport("resolution", r)}
                className={cn(
                  "rounded-md px-3 py-2 text-xs font-medium transition-colors duration-150",
                  exportSettings.resolution === r
                    ? "bg-violet-500/20 text-violet-200 ring-1 ring-violet-400/30"
                    : "text-fog hover:bg-white/[0.04] hover:text-white"
                )}
              >
                {r}
              </button>
            ))}
          </div>
        </div>

        <div>
          <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-fog">
            Frame rate
          </div>
          <div className="grid grid-cols-2 gap-1 rounded-lg border border-white/10 bg-white/[0.02] p-1">
            {fpsOptions.map((n) => (
              <button
                key={n}
                onClick={() => updateExport("fps", n)}
                className={cn(
                  "rounded-md px-3 py-2 text-xs font-medium transition-colors duration-150",
                  exportSettings.fps === n
                    ? "bg-violet-500/20 text-violet-200 ring-1 ring-violet-400/30"
                    : "text-fog hover:bg-white/[0.04] hover:text-white"
                )}
              >
                {n}fps
              </button>
            ))}
          </div>
        </div>

        <div>
          <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-fog">
            Format
          </div>
          <div className="grid grid-cols-3 gap-1.5">
            {formats.map((f) => {
              const active = exportSettings.format === f.id;
              return (
                <button
                  key={f.id}
                  onClick={() => updateExport("format", f.id)}
                  className={cn(
                    "flex flex-col items-center gap-1 rounded-lg border p-3 text-center transition-colors duration-150",
                    active
                      ? "border-violet-400/40 bg-violet-500/15 text-violet-200"
                      : "border-white/10 bg-white/[0.02] text-fog hover:border-white/20 hover:text-white"
                  )}
                >
                  <f.Icon size={14} />
                  <span className="text-[11px] font-medium">{f.label}</span>
                  <span className="text-[10px] opacity-70">{f.desc}</span>
                </button>
              );
            })}
          </div>
        </div>

        <Button
          onClick={startExport}
          variant="primary"
          size="md"
          className="w-full"
          leftIcon={<Download size={14} />}
        >
          Export {exportSettings.resolution}
        </Button>

        <p className="text-center text-[11px] text-fog">
          Est. render time:{" "}
          <span className="font-mono text-white/80">
            {exportSettings.resolution === "720p" ? "24s" : "32s"}
          </span>
        </p>
      </div>
    </div>
  );
}
