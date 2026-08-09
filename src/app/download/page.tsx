import type { Metadata } from "next";
import Link from "next/link";
import {
  Cpu,
  Download,
  HardDrive,
  MonitorPlay,
  ShieldCheck,
  Wifi,
  Zap,
} from "lucide-react";
import { TrackView } from "@/components/analytics/TrackView";
import { DownloadPanel } from "@/components/download/DownloadPanel";
import { EVENTS } from "@/lib/analytics/events";
import { buildMetadata } from "@/lib/seo";
import { CURRENT_RELEASE } from "@/lib/desktop/current-release";
import { isPublished } from "@/lib/desktop/release";

export const metadata: Metadata = buildMetadata({
  title: "Download Framevo for Windows and macOS",
  description:
    "Get the Framevo desktop app — faster editing, local GPU-accelerated rendering, offline access and reliable sync. Free download for Windows 10+ and macOS 12+.",
  path: "/download",
});

/** Why the app exists, in the order people care about it. */
const BENEFITS = [
  {
    icon: <Zap size={16} />,
    title: "Faster editing",
    body: "The timeline, preview and analysis run on your machine instead of a browser tab, so scrubbing and playback stay smooth on long recordings.",
  },
  {
    icon: <MonitorPlay size={16} />,
    title: "Local rendering",
    body: "Exports use your own GPU and never queue behind anyone else. The render core is the same one our cloud uses, so the file is identical either way.",
  },
  {
    icon: <Wifi size={16} />,
    title: "Works offline",
    body: "Projects, media and edits live on disk. Lose your connection mid-edit and nothing stops; changes sync when you're back.",
  },
  {
    icon: <ShieldCheck size={16} />,
    title: "Reliable sync",
    body: "Your work is saved locally first and reconciled with the cloud, so a flaky network can't cost you an edit.",
  },
];

const REQUIREMENTS = [
  {
    platform: "Windows",
    icon: <Cpu size={15} />,
    rows: [
      ["Operating system", "Windows 10 (64-bit, version 1809) or later"],
      ["Processor", "64-bit Intel or AMD; ARM64 runs the x64 build via emulation"],
      ["Memory", "8 GB minimum, 16 GB recommended for 4K"],
      ["Disk space", "~600 MB for the app, plus room for your projects"],
      ["Graphics", "Any GPU with hardware H.264 encoding (optional — CPU fallback)"],
    ],
  },
  {
    platform: "macOS",
    icon: <HardDrive size={15} />,
    rows: [
      ["Operating system", "macOS 12 Monterey or later"],
      ["Processor", "Apple Silicon (M1 or newer) or Intel"],
      ["Memory", "8 GB minimum, 16 GB recommended for 4K"],
      ["Disk space", "~600 MB for the app, plus room for your projects"],
      ["Graphics", "VideoToolbox hardware encoding (built in)"],
    ],
  },
];

const INSTALL_STEPS: Record<string, string[]> = {
  Windows: [
    "Run the downloaded Framevo-Setup.exe.",
    "Windows SmartScreen may ask for confirmation on a new release — choose More info → Run anyway.",
    "The installer places Framevo in your user folder and opens it when it finishes. No admin rights needed.",
    "Sign in with the same account you use on the web; your cloud projects appear automatically.",
  ],
  macOS: [
    "Open the downloaded .dmg and drag Framevo into Applications.",
    "Launch it from Applications. The first launch verifies the signature with Apple, which can take a few seconds.",
    "If macOS says the app can't be opened, go to System Settings → Privacy & Security and choose Open anyway.",
    "Sign in with the same account you use on the web; your cloud projects appear automatically.",
  ],
};

const TROUBLESHOOTING = [
  {
    q: "Windows SmartScreen warns me the publisher is unknown",
    a: "That appears for a newly signed installer until it builds reputation with Microsoft. Check the SHA-256 above against your downloaded file, then choose More info → Run anyway.",
  },
  {
    q: "macOS says the app is damaged or can't be opened",
    a: "This is usually a partial download or Gatekeeper quarantine. Delete the file, download it again, and open it from Applications rather than the disk image.",
  },
  {
    q: "\"Open Framevo\" does nothing",
    a: "The browser only hands framevo:// links to an installed copy. Install the app first, then click the link again — and allow the prompt your browser shows about opening an external application.",
  },
  {
    q: "My cloud projects aren't showing up",
    a: "Make sure you signed in inside the app (Settings → Account) with the same account as the website. Sign-in opens your normal browser and hands the session back to the app.",
  },
  {
    q: "Export fails or produces no file",
    a: "Check that you have free disk space on the drive holding your projects, then retry. If it keeps failing, the app's Diagnostics screen has a log you can send us.",
  },
  {
    q: "How do I uninstall it?",
    a: "Windows: Settings → Apps → Framevo → Uninstall. macOS: drag Framevo from Applications to the Trash. Neither removes your exported videos or anything already synced to the cloud.",
  },
];

export default async function DownloadPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const rawReason = params.reason;
  const reason = Array.isArray(rawReason) ? rawReason[0] : rawReason;
  const released = isPublished(CURRENT_RELEASE);

  return (
    <main className="relative min-h-screen px-4 pb-24 pt-20 sm:pt-28">
      <TrackView
        event={EVENTS.DESKTOP_DOWNLOAD_PAGE_VIEWED}
        params={{ version: CURRENT_RELEASE.version, released, reason: reason ?? null }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute left-1/2 top-0 -z-10 h-[520px] w-[1100px] -translate-x-1/2 bg-[radial-gradient(ellipse_at_center,rgba(139,92,246,0.22),transparent_65%)] blur-3xl"
      />

      {/* ── Hero ─────────────────────────────────────────────────────────── */}
      <div className="mx-auto max-w-3xl text-center">
        <span className="inline-flex items-center gap-1.5 rounded-full border border-violet-400/40 bg-violet-500/15 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.2em] text-violet-100">
          <Download size={11} />
          Desktop app
        </span>
        <h1 className="mt-4 font-display text-4xl font-semibold tracking-tight text-white sm:text-5xl">
          Framevo runs{" "}
          <span className="text-violet-300">on your machine.</span>
        </h1>
        <p className="mx-auto mt-4 max-w-xl text-[15px] leading-relaxed text-fog">
          Editing and rendering happen locally — no upload before you can start,
          no render queue, no tab to keep alive. Free with your existing account.
        </p>
      </div>

      <div className="mt-10">
        <DownloadPanel reason={reason} />
      </div>

      {/* ── Why ──────────────────────────────────────────────────────────── */}
      <section className="mx-auto mt-20 max-w-4xl">
        <div className="grid gap-4 sm:grid-cols-2">
          {BENEFITS.map((b) => (
            <div
              key={b.title}
              className="rounded-2xl border border-white/[0.07] bg-white/[0.02] p-5"
            >
              <div className="flex items-center gap-2 text-violet-200">
                {b.icon}
                <h2 className="text-[14px] font-semibold text-white">{b.title}</h2>
              </div>
              <p className="mt-2 text-[13.5px] leading-relaxed text-fog">{b.body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ── What's in this release ───────────────────────────────────────── */}
      <section className="mx-auto mt-16 max-w-3xl">
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.16em] text-fog">
          What&apos;s new in {CURRENT_RELEASE.version}
        </h2>
        <ul className="mt-3 space-y-2">
          {CURRENT_RELEASE.notes.map((note) => (
            <li key={note} className="flex gap-2.5 text-[13.5px] leading-relaxed text-fog">
              <span aria-hidden className="mt-[7px] size-1 shrink-0 rounded-full bg-violet-400" />
              {note}
            </li>
          ))}
        </ul>
        <p className="mt-3 text-[12px] text-fog/70">
          Released {CURRENT_RELEASE.releasedAt} ·{" "}
          <Link href="/changelog" className="text-violet-300 hover:underline">
            full changelog
          </Link>
        </p>
      </section>

      {/* ── System requirements ──────────────────────────────────────────── */}
      <section className="mx-auto mt-16 max-w-4xl">
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.16em] text-fog">
          System requirements
        </h2>
        <div className="mt-4 grid gap-4 md:grid-cols-2">
          {REQUIREMENTS.map((req) => (
            <div
              key={req.platform}
              className="rounded-2xl border border-white/[0.07] bg-white/[0.02] p-5"
            >
              <div className="flex items-center gap-2 text-violet-200">
                {req.icon}
                <h3 className="text-[14px] font-semibold text-white">{req.platform}</h3>
              </div>
              <dl className="mt-3 space-y-2">
                {req.rows.map(([label, value]) => (
                  <div key={label} className="grid grid-cols-[110px_1fr] gap-3">
                    <dt className="text-[12px] text-fog/70">{label}</dt>
                    <dd className="text-[13px] leading-relaxed text-white/85">{value}</dd>
                  </div>
                ))}
              </dl>
            </div>
          ))}
        </div>
      </section>

      {/* ── Installing ───────────────────────────────────────────────────── */}
      <section className="mx-auto mt-16 max-w-4xl">
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.16em] text-fog">
          Installing
        </h2>
        <div className="mt-4 grid gap-4 md:grid-cols-2">
          {Object.entries(INSTALL_STEPS).map(([platform, steps]) => (
            <div
              key={platform}
              className="rounded-2xl border border-white/[0.07] bg-white/[0.02] p-5"
            >
              <h3 className="text-[14px] font-semibold text-white">{platform}</h3>
              <ol className="mt-3 space-y-2.5">
                {steps.map((step, i) => (
                  <li key={step} className="flex gap-3 text-[13.5px] leading-relaxed text-fog">
                    <span className="mt-[1px] inline-flex size-5 shrink-0 items-center justify-center rounded-full border border-white/10 bg-white/[0.03] text-[11px] font-semibold text-white/80">
                      {i + 1}
                    </span>
                    {step}
                  </li>
                ))}
              </ol>
            </div>
          ))}
        </div>
      </section>

      {/* ── Troubleshooting ──────────────────────────────────────────────── */}
      <section id="troubleshooting" className="mx-auto mt-16 max-w-3xl scroll-mt-24">
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.16em] text-fog">
          Troubleshooting
        </h2>
        <div className="mt-4 divide-y divide-white/[0.06] rounded-2xl border border-white/[0.07] bg-white/[0.02]">
          {TROUBLESHOOTING.map((item) => (
            <details key={item.q} className="group px-5 py-4">
              <summary className="cursor-pointer list-none text-[13.5px] font-medium text-white/90 transition-colors duration-150 marker:hidden hover:text-white">
                {item.q}
              </summary>
              <p className="mt-2 text-[13.5px] leading-relaxed text-fog">{item.a}</p>
            </details>
          ))}
        </div>
        <p className="mt-4 text-[12.5px] text-fog">
          Still stuck?{" "}
          <Link href="/docs" className="text-violet-300 hover:underline">
            Read the docs
          </Link>{" "}
          or{" "}
          <a href="mailto:support@framevo.app" className="text-violet-300 hover:underline">
            email support
          </a>
          .
        </p>
      </section>
    </main>
  );
}
