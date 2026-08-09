"use client";

/**
 * The workspace home screen — an overview, not a project browser.
 *
 * It deliberately loads NO projects. Everything here is either a count that the
 * store computed itself (`useWorkspaceStats` — one Firestore aggregate, one
 * SQLite aggregate) or a single document already on a cheap listener (the plan
 * tier, this month's usage). Browsing projects is `/dashboard/projects`, which
 * is where the listing — and the per-card `<video>` decode that used to run six
 * times on this page — belongs.
 */
import * as React from "react";
import Link from "next/link";
import {
  AlertCircle,
  CreditCard,
  Folder,
  HardDrive,
  Loader2,
  Settings,
  Sparkles,
  Upload as UploadIcon,
  Video,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { useAuth } from "@/lib/firebase/AuthProvider";
import { useWorkspaceStats } from "@/lib/projects/useWorkspaceStats";
import { usePlatform } from "@/lib/platform";
import { useLocalImport } from "@/lib/import/useLocalImport";
import { usePlanTier } from "@/lib/usage/useStoragePlan";
import { useMonthlyUsage } from "@/lib/usage/useMonthlyUsage";
import { PLAN_DEFS, fmtBytes, storageBand } from "@/lib/usage/plan";
import { CLOUD_EXPORT_MINUTES, cloudMinutesUsed } from "@/lib/usage/cloud-minutes";
import { FREE_MONTHLY_CLOUD_EXPORTS } from "@/lib/export/plan-policy";
import { Button } from "@/components/ui/Button";
import { PageHeader } from "@/components/dashboard/PageHeader";

export function DashboardHome() {
  const { user } = useAuth();
  const platform = usePlatform();
  const stats = useWorkspaceStats();
  const { tier } = usePlanTier();
  const { usage } = useMonthlyUsage();

  const plan = PLAN_DEFS[tier];
  const isDesktop = platform.kind === "desktop";

  const limitBytes = plan.storageBytes;
  const fraction = limitBytes > 0 ? Math.min(1, stats.cloudBytes / limitBytes) : 0;

  // Free is gated on a COUNT of cloud exports, paid plans on minutes — two
  // different meters, both read from the shared limits (never re-declared here).
  const isFree = tier === "free";
  const exportsUsed = isFree
    ? Math.max(0, usage?.exportsUsedThisMonth ?? 0)
    : cloudMinutesUsed(usage);
  const exportsLimit = isFree ? FREE_MONTHLY_CLOUD_EXPORTS : CLOUD_EXPORT_MINUTES[tier];

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Workspace"
        title={greeting(user?.displayName)}
        subtitle="Upload a recording, let the AI plan the cinematic cut, then export it cleanly."
      />

      {/* Quick start owns the three ways in. The header used to repeat all of
          them as buttons, and a first-run empty state repeated Upload a third
          time — one screen, three ranks of the same action. */}
      <QuickStart projectCount={stats.projectCount} loading={stats.loading} />

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Stat
          label="Projects"
          value={stats.loading ? null : stats.projectCount}
          hint={
            isDesktop
              ? `${stats.localCount} on this computer · ${Math.max(0, stats.projectCount - stats.localCount)} in the cloud`
              : "Across your workspace"
          }
          href="/dashboard/projects"
        />
        <Stat
          label="Storage"
          value={stats.loading ? null : fmtBytes(stats.cloudBytes)}
          hint={`of ${fmtBytes(limitBytes)} in the cloud`}
          meter={fraction}
          band={storageBand(stats.cloudBytes, limitBytes)}
          icon={<HardDrive size={11} className="text-cyan-300" />}
          // `/dashboard/storage` is a desktop-only route (it reports this
          // disk); on the web the plan's storage lives on the billing screen.
          href={isDesktop ? "/dashboard/storage" : "/dashboard/billing"}
        />
        <Stat
          label="Exports"
          value={`${exportsUsed} / ${exportsLimit}`}
          hint={
            isFree
              ? `cloud exports this month · ${plan.name}`
              : `export minutes this month · ${plan.name}`
          }
          icon={<Sparkles size={11} className="text-violet-300" />}
          href="/dashboard/exports"
        />
      </div>

      {stats.cloudUnavailable && (
        <p className="rounded-xl border border-amber-400/25 bg-amber-500/[0.06] px-4 py-2.5 text-[12.5px] text-amber-100">
          Framevo couldn&apos;t reach your cloud workspace, so these totals cover only what&apos;s
          on this computer.
        </p>
      )}

      <AccountPanel
        displayName={user?.displayName ?? null}
        email={user?.email ?? null}
        photoURL={user?.photoURL ?? null}
        memberSince={user?.metadata?.creationTime ?? null}
        planName={plan.name}
        ctaLabel={plan.ctaLabel}
        usedBytes={stats.cloudBytes}
        limitBytes={limitBytes}
        local={
          isDesktop
            ? { projectCount: stats.localCount, mediaBytes: stats.localBytes }
            : null
        }
      />

    </div>
  );
}

/**
 * The three ways to start work, as the first thing on the screen.
 *
 * On the desktop, "Import a video" opens the OS picker HERE rather than routing
 * to the import screen to press a second button — the fastest path from opening
 * the app to editing is the whole point of a quick start. On the web a file
 * needs uploading, which has its own screen and progress, so it links there.
 *
 * Deliberately no "recent projects" strip: this page computes counts from
 * aggregates and loads no project documents (see the note at the top of the
 * file), and a quick start is not worth giving that up.
 */
function QuickStart({
  projectCount,
  loading,
}: {
  projectCount: number;
  loading: boolean;
}) {
  // Capability, not platform: the card opens a picker wherever one exists,
  // which is the same rule the import screen itself follows.
  const platform = usePlatform();
  const { importing, error, openPicker } = useLocalImport();
  const canPickHere = platform.media.canPickLocalFiles;
  const hasProjects = projectCount > 0;

  return (
    <section aria-labelledby="quick-start-heading" className="space-y-3">
      <div className="flex items-baseline justify-between gap-3">
        <h2
          id="quick-start-heading"
          className="text-[10px] font-semibold uppercase tracking-[0.18em] text-fog"
        >
          Quick start
        </h2>
        {!loading && !hasProjects && (
          <span className="text-[12px] text-fog">Nothing here yet — pick a way in.</span>
        )}
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <QuickStartCard
          icon={importing ? <Loader2 size={18} className="animate-spin" /> : <UploadIcon size={18} />}
          accent="violet"
          title={importing ? "Opening…" : "Import a video"}
          detail={
            canPickHere
              ? "Open one from this computer. Nothing is uploaded or copied."
              : "Upload a recording you already have."
          }
          {...(canPickHere
            ? { onClick: openPicker, busy: importing }
            : { href: "/dashboard/upload" })}
        />
        <QuickStartCard
          icon={<Video size={18} />}
          accent="cyan"
          title="Record your screen"
          detail="Capture a window, a screen or a browser tab."
          href="/dashboard/record"
        />
        <QuickStartCard
          icon={<Folder size={18} />}
          accent="neutral"
          title="Browse projects"
          detail={
            loading
              ? "Counting your workspace…"
              : hasProjects
                ? `${projectCount} ${projectCount === 1 ? "project" : "projects"} in your workspace`
                : "Your projects will show up here."
          }
          href="/dashboard/projects"
        />
      </div>

      {error && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-xl border border-rose-400/30 bg-rose-500/[0.06] px-4 py-3 text-[12.5px] text-rose-200"
        >
          <AlertCircle size={14} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}
    </section>
  );
}

const QUICK_START_ACCENTS = {
  violet: "border-violet-400/30 bg-violet-500/10 text-violet-300",
  cyan: "border-cyan-400/30 bg-cyan-500/10 text-cyan-300",
  neutral: "border-white/10 bg-white/[0.04] text-white/80",
} as const;

/**
 * One way in. Renders a link or a button depending on whether the action is a
 * navigation or something that happens right here — the two cannot be the same
 * element, because only one of them should be openable in a new tab.
 */
function QuickStartCard({
  icon,
  title,
  detail,
  href,
  onClick,
  busy = false,
  accent,
}: {
  icon: React.ReactNode;
  title: string;
  detail: string;
  href?: string;
  onClick?: () => void;
  busy?: boolean;
  accent: keyof typeof QUICK_START_ACCENTS;
}) {
  const shell =
    "glass group flex h-full flex-col items-start gap-3 rounded-xl p-5 text-left transition-colors duration-200 hover:border-white/15 hover:bg-white/[0.03] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400/60";

  const body = (
    <>
      <span
        className={cn(
          "inline-flex size-10 items-center justify-center rounded-xl border transition-transform duration-200 group-hover:scale-105",
          QUICK_START_ACCENTS[accent]
        )}
      >
        {icon}
      </span>
      <span className="min-w-0">
        <span className="block text-[14px] font-medium text-white">{title}</span>
        <span className="mt-1 block text-[12px] leading-relaxed text-fog">{detail}</span>
      </span>
    </>
  );

  if (href) {
    return (
      <Link href={href} className={shell}>
        {body}
      </Link>
    );
  }
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className={cn(shell, busy && "cursor-wait opacity-70")}
    >
      {body}
    </button>
  );
}

function greeting(name?: string | null): string {
  const first = name?.split(" ")[0];
  return first ? `Welcome back, ${first}` : "Welcome back";
}

/**
 * One number. `value === null` means "not known yet" — a dash rather than a
 * zero, because a zero here reads as a fact ("you have no projects").
 */
function Stat({
  label,
  value,
  hint,
  icon,
  meter,
  band = "ok",
  href,
}: {
  label: string;
  value: number | string | null;
  hint?: string;
  icon?: React.ReactNode;
  /** 0..1 — renders a usage bar under the value. */
  meter?: number;
  band?: "ok" | "warn" | "danger";
  href?: string;
}) {
  const body = (
    <>
      <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.18em] text-fog">
        {icon}
        {label}
      </div>
      <div className="mt-2 font-display text-2xl font-semibold text-white">
        {value === null ? <span className="text-fog">—</span> : value}
      </div>
      {meter !== undefined && (
        <div className="mt-2 h-1 overflow-hidden rounded-full bg-white/[0.06]">
          <div
            className={cn(
              "h-full rounded-full transition-[width] duration-300",
              band === "danger"
                ? "bg-gradient-to-r from-rose-500 to-rose-400"
                : band === "warn"
                  ? "bg-gradient-to-r from-amber-400 to-amber-300"
                  : "bg-gradient-to-r from-violet-500 to-cyan-400"
            )}
            style={{ width: `${Math.max(1, Math.round(meter * 100))}%` }}
          />
        </div>
      )}
      {hint && <div className="mt-1 text-[11px] text-fog">{hint}</div>}
    </>
  );

  if (!href) return <div className="glass rounded-xl p-5">{body}</div>;
  return (
    <Link
      href={href}
      className="glass rounded-xl p-5 transition-colors duration-200 hover:border-white/15"
    >
      {body}
    </Link>
  );
}

/**
 * Who is signed in and what their account is entitled to — the other half of a
 * dashboard that shows no projects. Every field here comes from the Firebase
 * session or a single user/usage document.
 */
function AccountPanel({
  displayName,
  email,
  photoURL,
  memberSince,
  planName,
  ctaLabel,
  usedBytes,
  limitBytes,
  local,
}: {
  displayName: string | null;
  email: string | null;
  photoURL: string | null;
  /** `user.metadata.creationTime` — an RFC 1123 string, or null. */
  memberSince: string | null;
  planName: string;
  ctaLabel: string;
  usedBytes: number;
  limitBytes: number;
  /** Desktop only: what this machine holds. */
  local: { projectCount: number; mediaBytes: number } | null;
}) {
  const initials = displayName
    ? displayName
        .split(" ")
        .map((s) => s[0])
        .slice(0, 2)
        .join("")
        .toUpperCase()
    : email?.[0]?.toUpperCase() ?? "?";

  return (
    <div className="glass rounded-2xl p-5">
      <div className="flex flex-wrap items-center gap-3">
        {photoURL ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={photoURL}
            alt=""
            className="size-11 rounded-full"
            referrerPolicy="no-referrer"
          />
        ) : (
          <span
            className="inline-flex size-11 items-center justify-center rounded-full bg-gradient-to-br from-violet-500 to-cyan-400 text-sm font-semibold text-white"
            aria-hidden
          >
            {initials}
          </span>
        )}
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-white">
            {displayName || "Your account"}
          </div>
          {email && <div className="truncate text-[12px] text-fog">{email}</div>}
        </div>
        <span className="inline-flex items-center gap-1.5 rounded-full border border-violet-400/25 bg-violet-500/10 px-3 py-1 text-[11px] font-medium text-violet-200">
          <Sparkles size={11} />
          {planName}
        </span>
      </div>

      <dl className="mt-4 grid grid-cols-1 gap-x-6 gap-y-2 border-t border-white/[0.06] pt-4 sm:grid-cols-2">
        <Row label="Cloud storage" value={`${fmtBytes(usedBytes)} of ${fmtBytes(limitBytes)}`} />
        <Row label="Member since" value={formatMemberSince(memberSince)} />
        {local && (
          <Row
            label="On this computer"
            value={`${local.projectCount} ${local.projectCount === 1 ? "project" : "projects"} · ${fmtBytes(local.mediaBytes)}`}
          />
        )}
      </dl>

      <div className="mt-4 flex flex-wrap gap-2">
        <Button href="/dashboard/billing" variant="ghost" size="sm" leftIcon={<CreditCard size={13} />}>
          {ctaLabel === "Upgrade" ? "Upgrade plan" : "Manage plan"}
        </Button>
        <Button href="/dashboard/settings" variant="ghost" size="sm" leftIcon={<Settings size={13} />}>
          Settings
        </Button>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-[12px] text-fog">{label}</dt>
      <dd className="truncate text-[12px] font-medium text-white">{value}</dd>
    </div>
  );
}

/** `creationTime` is an RFC 1123 string; an unparseable one simply isn't shown. */
function formatMemberSince(raw: string | null): string {
  if (!raw) return "—";
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

/* The first-run EmptyState that used to live here is gone: Quick start is the
   empty state now. It sits at the TOP of the page rather than under the stats,
   says the same thing ("nothing here yet — pick a way in"), and offers all
   three ways in instead of only Upload. */
