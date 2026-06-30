// CSS-rendered fake screen recording inside the video player.
// Shows a SaaS-style UI with a code editor and a button area so the
// auto-zoom region has visible hotspots to land on.
export function FakeRecording() {
  return (
    <div className="absolute inset-0 grid grid-cols-[18%_1fr] bg-gradient-to-br from-[#0B0D11] to-[#11141B]">
      {/* sidebar */}
      <div className="border-r border-white/[0.05] bg-white/[0.015] p-4">
        <div className="mb-3 h-3 w-2/3 rounded bg-white/12" />
        <div className="space-y-2">
          <div className="h-2 rounded bg-violet-500/40" />
          <div className="h-2 rounded bg-white/[0.06]" />
          <div className="h-2 w-4/5 rounded bg-white/[0.06]" />
          <div className="h-2 w-3/5 rounded bg-white/[0.06]" />
          <div className="h-2 w-2/3 rounded bg-white/[0.06]" />
        </div>
      </div>

      {/* main area */}
      <div className="grid grid-rows-[auto_1fr] gap-3 p-5">
        {/* breadcrumb + actions */}
        <div className="flex items-center gap-2">
          <div className="h-3 w-32 rounded bg-white/12" />
          <div className="ml-auto h-7 w-20 rounded-md bg-violet-500/90" />
          <div className="h-7 w-7 rounded-md border border-white/10 bg-white/[0.03]" />
        </div>

        <div className="grid grid-cols-2 gap-3">
          {/* card grid */}
          <div className="grid grid-cols-2 gap-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <div
                key={i}
                className={
                  i === 1
                    ? "aspect-[4/3] rounded-lg border border-violet-400/40 bg-gradient-to-br from-violet-500/15 to-cyan-400/10 p-2 ring-1 ring-violet-400/30"
                    : "aspect-[4/3] rounded-lg border border-white/[0.06] bg-white/[0.03] p-2"
                }
              >
                <div className="space-y-1">
                  <div className="h-1.5 w-2/3 rounded bg-white/15" />
                  <div className="h-1.5 w-4/5 rounded bg-white/[0.08]" />
                  <div className="h-1.5 w-1/2 rounded bg-white/[0.08]" />
                </div>
                <div className="mt-3 h-4 w-12 rounded bg-white/[0.06]" />
              </div>
            ))}
          </div>

          {/* code block */}
          <div className="rounded-lg border border-white/[0.06] bg-black/40 p-3 font-mono text-[10px] leading-relaxed">
            <div className="text-violet-300/80">
              import <span className="text-white/80">{"{"} enhance {"}"}</span> from <span className="text-emerald-300/80">"framevo"</span>;
            </div>
            <div className="mt-1 text-white/40">
              {/* */}
              {"// AI detects every click + cursor focus"}
            </div>
            <div className="mt-1 text-violet-300/80">
              const <span className="text-cyan-400/80">video</span> = await loadFile();
            </div>
            <div className="text-violet-300/80">
              const <span className="text-cyan-400/80">result</span> = await <span className="text-emerald-300/80">enhance</span>(video, {"{"}
            </div>
            <div className="rounded bg-violet-500/15 pl-3 ring-1 ring-inset ring-violet-400/40">
              <span className="text-amber-200">  zoom:</span> <span className="text-emerald-300/80">"cinematic"</span>,
            </div>
            <div className="pl-3 text-amber-200">  cursor: <span className="text-emerald-300/80">"smooth"</span>,</div>
            <div className="pl-3 text-amber-200">  vertical: <span className="text-rose-300/80">true</span></div>
            <div className="text-violet-300/80">{"});"}</div>
            <div className="mt-1 text-violet-300/80">
              await result.<span className="text-emerald-300/80">export</span>(<span className="text-emerald-300/80">"1080p"</span>);
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
