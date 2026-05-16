import type { Project } from "@/lib/types";

const accentClasses: Record<Project["thumbAccent"], string> = {
  violet: "from-violet-500/20 to-cyan-400/10",
  cyan: "from-cyan-500/20 to-violet-500/10",
  amber: "from-amber-500/20 to-rose-500/10",
  rose: "from-rose-500/20 to-fuchsia-500/10",
  emerald: "from-emerald-500/20 to-cyan-500/10",
  indigo: "from-indigo-500/20 to-violet-500/10",
};

export function ProjectThumb({ project }: { project: Project }) {
  const accent = accentClasses[project.thumbAccent];

  return (
    <div className={`relative h-full w-full overflow-hidden bg-gradient-to-br ${accent}`}>
      {/* base recording */}
      {project.thumbStyle === "browser" && <BrowserMock />}
      {project.thumbStyle === "code" && <CodeMock />}
      {project.thumbStyle === "saas" && <SaasMock />}
      {project.thumbStyle === "tutorial" && <TutorialMock />}
      {project.thumbStyle === "tiktok" && <TikTokMock />}
      {project.thumbStyle === "product" && <ProductMock />}

      {/* zoom region */}
      <div className="pointer-events-none absolute left-[42%] top-[30%] h-[40%] w-[36%] rounded-md ring-1 ring-violet-400/60 shadow-[0_0_0_3px_rgba(139,92,246,0.12)]">
        <span className="absolute -left-px -top-px size-2 border-l border-t border-violet-300" />
        <span className="absolute -right-px -top-px size-2 border-r border-t border-violet-300" />
        <span className="absolute -bottom-px -left-px size-2 border-b border-l border-violet-300" />
        <span className="absolute -bottom-px -right-px size-2 border-b border-r border-violet-300" />
      </div>

      {/* cursor */}
      <svg viewBox="0 0 20 20" width="11" height="11" className="absolute left-[58%] top-[48%] drop-shadow-[0_0_4px_rgba(139,92,246,0.7)]">
        <path d="M3 2 L17 9 L10 11 L9 18 Z" fill="white" />
      </svg>
    </div>
  );
}

function BrowserMock() {
  return (
    <div className="absolute inset-2 rounded-md border border-white/10 bg-black/35">
      <div className="flex h-3 items-center gap-1 border-b border-white/[0.05] px-2">
        <span className="size-0.5 rounded-full bg-rose-400/80" />
        <span className="size-0.5 rounded-full bg-amber-400/80" />
        <span className="size-0.5 rounded-full bg-emerald-400/80" />
      </div>
      <div className="grid grid-cols-3 gap-1 p-2">
        <div className="h-6 rounded bg-white/[0.04]" />
        <div className="h-6 rounded bg-white/[0.04]" />
        <div className="h-6 rounded bg-violet-500/30" />
      </div>
    </div>
  );
}

function CodeMock() {
  return (
    <div className="absolute inset-2 rounded-md bg-black/55 p-2 font-mono text-[6px] leading-tight">
      <div className="text-violet-300/70">function enhance() {`{`}</div>
      <div className="pl-1.5 text-emerald-300/70">  return ai.zoom();</div>
      <div className="text-violet-300/70">{`}`}</div>
    </div>
  );
}

function SaasMock() {
  return (
    <div className="absolute inset-2 grid grid-cols-[20%_1fr] gap-1 rounded-md border border-white/10 bg-black/30 p-1">
      <div className="space-y-0.5">
        <div className="h-1 rounded bg-white/15" />
        <div className="h-1 rounded bg-violet-500/40" />
        <div className="h-1 rounded bg-white/[0.06]" />
      </div>
      <div className="grid grid-cols-2 gap-0.5">
        <div className="rounded bg-white/[0.04]" />
        <div className="rounded bg-violet-500/25" />
      </div>
    </div>
  );
}

function TutorialMock() {
  return (
    <div className="absolute inset-2 rounded-md border border-white/10 bg-black/30 p-2">
      <div className="mb-1 h-1 w-1/2 rounded bg-white/15" />
      <div className="grid grid-cols-3 gap-1">
        <div className="h-4 rounded bg-white/[0.05]" />
        <div className="h-4 rounded bg-violet-500/30 ring-1 ring-violet-400/40" />
        <div className="h-4 rounded bg-white/[0.05]" />
      </div>
    </div>
  );
}

function TikTokMock() {
  return (
    <div className="absolute inset-y-2 left-1/2 aspect-[9/16] -translate-x-1/2 rounded-md border border-white/10 bg-black">
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_50%_60%,rgba(217,70,239,0.2),transparent_60%)]" />
      <span className="absolute left-1/2 top-1/3 -translate-x-1/2 rounded bg-white px-1 text-[5px] font-bold text-black">
        VIRAL
      </span>
    </div>
  );
}

function ProductMock() {
  return (
    <div className="absolute inset-2 rounded-md border border-white/10 bg-white/[0.02]">
      <div className="m-2 h-3 w-1/2 rounded bg-white/12" />
      <div className="m-2 grid grid-cols-3 gap-0.5">
        <div className="h-3 rounded bg-white/[0.05]" />
        <div className="h-3 rounded bg-white/[0.05]" />
        <div className="h-3 rounded bg-violet-500/30" />
      </div>
    </div>
  );
}
