"use client";

import * as React from "react";
import {
  Copy,
  Plus,
  Trash2,
  Pencil,
  Check,
  X as XIcon,
  AlertTriangle,
  KeyRound,
  Loader2,
  ShieldOff,
  CircleAlert,
  Circle,
} from "lucide-react";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { Button } from "@/components/ui/Button";
import { Toggle } from "@/components/ui/Toggle";
import { useToast } from "@/components/ui/Toast";
import { useAuth } from "@/lib/firebase/AuthProvider";
import {
  useWorkspaceSettings,
  type WorkspaceSettingsError,
} from "@/lib/firebase/workspace-settings";
import {
  useApiKeys,
  createApiKeyClient,
  renameApiKeyClient,
  revokeApiKeyClient,
  type CreatedApiKey,
  type ApiKeysError,
} from "@/lib/firebase/api-keys-client";
import { BUILTIN_PRESETS } from "@/lib/presets";
import { cn } from "@/lib/cn";
import type { ApiKeyDoc, ExportFormat } from "@/lib/firebase/schema";

const EXPORT_FORMATS: ExportFormat[] = ["YouTube 16:9", "TikTok 9:16", "1080p", "4K"];

export default function SettingsPage() {
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Settings"
        title="Workspace settings"
        subtitle="Workspace defaults, notifications, and API access."
      />

      <WorkspaceDefaultsSection />
      <NotificationsSection />
      <ApiKeysSection />
    </div>
  );
}

// ── Workspace defaults ────────────────────────────────────────────────────

function WorkspaceDefaultsSection() {
  const { settings, loading, error, save } = useWorkspaceSettings();
  const toast = useToast();
  const [presetId, setPresetId] = React.useState(settings.defaultPresetId);
  const [format, setFormat] = React.useState<ExportFormat>(settings.defaultExportFormat);
  const [saving, setSaving] = React.useState(false);

  // Re-sync local state when the live settings change (other tab,
  // first hydration after `loading`).
  React.useEffect(() => {
    setPresetId(settings.defaultPresetId);
    setFormat(settings.defaultExportFormat);
  }, [settings.defaultPresetId, settings.defaultExportFormat]);

  const dirty =
    presetId !== settings.defaultPresetId ||
    format !== settings.defaultExportFormat;

  const onSave = async () => {
    setSaving(true);
    try {
      await save({ defaultPresetId: presetId, defaultExportFormat: format });
      toast.success(
        "Workspace defaults saved",
        "Applied to every new project from now on."
      );
    } catch (err) {
      toast.error(
        "Couldn't save",
        err instanceof Error ? err.message : "Try again"
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <Section
      title="Workspace defaults"
      description="Applied to every new project. Existing projects are left alone."
      action={
        <Button
          variant="primary"
          size="sm"
          disabled={!dirty || saving || loading || error !== null}
          onClick={onSave}
          leftIcon={
            saving ? <Loader2 size={13} className="animate-spin" /> : undefined
          }
        >
          {saving ? "Saving…" : "Save"}
        </Button>
      }
    >
      {error && <SettingsErrorBanner error={error} fieldLabel="workspace defaults" />}
      {!error && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Select
            label="Default preset"
            value={presetId}
            onChange={setPresetId}
            options={BUILTIN_PRESETS.map((p) => ({ value: p.id, label: p.name }))}
            disabled={loading}
          />
          <Select<ExportFormat>
            label="Default export format"
            value={format}
            onChange={(v) => setFormat(v)}
            options={EXPORT_FORMATS.map((f) => ({ value: f, label: f }))}
            disabled={loading}
          />
        </div>
      )}
    </Section>
  );
}

// ── Notifications ─────────────────────────────────────────────────────────

function NotificationsSection() {
  const { settings, loading, error, save } = useWorkspaceSettings();
  const toast = useToast();
  const [renderComplete, setRenderComplete] = React.useState(
    settings.notifications.renderComplete
  );
  const [weeklyDigest, setWeeklyDigest] = React.useState(
    settings.notifications.weeklyDigest
  );
  const [productNews, setProductNews] = React.useState(
    settings.notifications.productNews
  );
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    setRenderComplete(settings.notifications.renderComplete);
    setWeeklyDigest(settings.notifications.weeklyDigest);
    setProductNews(settings.notifications.productNews);
  }, [
    settings.notifications.renderComplete,
    settings.notifications.weeklyDigest,
    settings.notifications.productNews,
  ]);

  const dirty =
    renderComplete !== settings.notifications.renderComplete ||
    weeklyDigest !== settings.notifications.weeklyDigest ||
    productNews !== settings.notifications.productNews;

  const onSave = async () => {
    setSaving(true);
    try {
      await save({
        notifications: { renderComplete, weeklyDigest, productNews },
      });
      toast.success("Notification preferences saved");
    } catch (err) {
      toast.error(
        "Couldn't save",
        err instanceof Error ? err.message : "Try again"
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <Section
      title="Notifications"
      description="Pick what you want to hear about."
      action={
        <Button
          variant="primary"
          size="sm"
          disabled={!dirty || saving || loading || error !== null}
          onClick={onSave}
          leftIcon={
            saving ? <Loader2 size={13} className="animate-spin" /> : undefined
          }
        >
          {saving ? "Saving…" : "Save"}
        </Button>
      }
    >
      {error && <SettingsErrorBanner error={error} fieldLabel="notification preferences" />}
      {!error && (
        <div className="space-y-4">
          <Toggle
            label="Render complete"
            description="Ping me when an export finishes or fails."
            checked={renderComplete}
            onChange={setRenderComplete}
          />
          <Toggle
            label="Weekly digest"
            description="Stats and shareable highlights. (Coming soon.)"
            checked={weeklyDigest}
            onChange={setWeeklyDigest}
          />
          <Toggle
            label="Product news"
            description="New features, presets, and changelogs."
            checked={productNews}
            onChange={setProductNews}
          />
        </div>
      )}
    </Section>
  );
}

// ── API keys ──────────────────────────────────────────────────────────────

function ApiKeysSection() {
  const { getIdToken } = useAuth();
  const { keys, loading, error } = useApiKeys();
  const toast = useToast();
  const [creating, setCreating] = React.useState(false);
  const [showCreate, setShowCreate] = React.useState(false);
  const [justCreated, setJustCreated] = React.useState<CreatedApiKey | null>(null);

  // Hide revoked keys at the top — the dashboard shows them dimmed
  // at the bottom so the user has an audit trail without clutter.
  const active = keys.filter((k) => !k.revoked);
  const revoked = keys.filter((k) => k.revoked);

  const onCreate = async (name: string, type: "test" | "live") => {
    setCreating(true);
    try {
      const result = await createApiKeyClient(getIdToken, { name, type });
      setJustCreated(result);
      setShowCreate(false);
      toast.success(
        "API key created",
        "Copy the secret now — it won't be shown again."
      );
    } catch (err) {
      toast.error(
        "Couldn't create key",
        err instanceof Error ? err.message : "Try again"
      );
    } finally {
      setCreating(false);
    }
  };

  const onRevoke = async (key: ApiKeyDoc) => {
    if (
      !window.confirm(
        `Revoke "${key.name}"? Any service using it will immediately stop working.`
      )
    ) {
      return;
    }
    try {
      await revokeApiKeyClient(getIdToken, key.id);
      toast.success("Key revoked", `"${key.name}" can no longer authenticate.`);
    } catch (err) {
      toast.error(
        "Couldn't revoke",
        err instanceof Error ? err.message : "Try again"
      );
    }
  };

  const onRename = async (key: ApiKeyDoc, next: string) => {
    if (next === key.name) return;
    try {
      await renameApiKeyClient(getIdToken, key.id, next);
      toast.success("Renamed");
    } catch (err) {
      toast.error(
        "Couldn't rename",
        err instanceof Error ? err.message : "Try again"
      );
    }
  };

  // Distinguish "system can't load at all" from "system loaded, but
  // there are no keys yet". Without this gate, a permission-denied
  // failure would render `EmptyApiKeys`, suggesting everything's fine
  // when it isn't.
  const blocked = error !== null;

  return (
    <Section
      title="API keys"
      description="Use the AdZoom API to enhance recordings programmatically."
      action={
        <Button
          variant="ghost"
          size="sm"
          leftIcon={<Plus size={13} />}
          onClick={() => setShowCreate(true)}
          disabled={blocked}
        >
          New key
        </Button>
      }
    >
      {/* Status row — same shape as the dev-mode `[export] render
          manifest` line. Tells the user at a glance whether the API
          key subsystem is healthy. Sits above the create-form banner
          so it's the FIRST thing read in this section. */}
      <ApiKeyStatusRow loading={loading} error={error} />

      {showCreate && !blocked && (
        <CreateKeyForm
          onCancel={() => setShowCreate(false)}
          onCreate={onCreate}
          creating={creating}
        />
      )}

      {justCreated && !blocked && (
        <JustCreatedKey
          created={justCreated}
          onDone={() => setJustCreated(null)}
        />
      )}

      {blocked && <ApiKeysErrorBanner error={error!} />}

      {!loading && !blocked && active.length === 0 && !justCreated && !showCreate && (
        <EmptyApiKeys onCreate={() => setShowCreate(true)} />
      )}

      {!blocked && active.length > 0 && (
        <div className="space-y-2.5">
          {active.map((k) => (
            <ApiKeyRow
              key={k.id}
              k={k}
              onRevoke={() => onRevoke(k)}
              onRename={(name) => onRename(k, name)}
            />
          ))}
        </div>
      )}

      {revoked.length > 0 && (
        <details className="mt-5">
          <summary className="cursor-pointer text-[11px] uppercase tracking-[0.18em] text-fog/80 hover:text-white">
            Revoked ({revoked.length})
          </summary>
          <div className="mt-2 space-y-2.5">
            {revoked.map((k) => (
              <ApiKeyRow key={k.id} k={k} />
            ))}
          </div>
        </details>
      )}
    </Section>
  );
}

function CreateKeyForm({
  onCancel,
  onCreate,
  creating,
}: {
  onCancel: () => void;
  onCreate: (name: string, type: "test" | "live") => void;
  creating: boolean;
}) {
  const [name, setName] = React.useState("");
  const [type, setType] = React.useState<"test" | "live">("test");
  return (
    <div className="mb-3 space-y-3 rounded-xl border border-violet-400/30 bg-violet-500/[0.06] p-4">
      <div className="flex items-center gap-2 text-[12px] font-semibold text-white">
        <KeyRound size={13} className="text-violet-300" />
        New API key
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_auto]">
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Production · CI pipeline · Personal script"
          className="h-9 w-full rounded-lg border border-white/10 bg-white/[0.02] px-3 text-sm text-white placeholder:text-fog/70 outline-none focus:border-white/25 focus:bg-white/[0.04]"
        />
        <div className="inline-flex items-center gap-0.5 rounded-lg border border-white/10 bg-white/[0.02] p-1">
          <button
            type="button"
            onClick={() => setType("test")}
            className={cn(
              "rounded-md px-3 py-1.5 text-[11.5px] font-medium transition-colors duration-150",
              type === "test"
                ? "bg-white/[0.08] text-white"
                : "text-fog hover:text-white"
            )}
          >
            Test
          </button>
          <button
            type="button"
            onClick={() => setType("live")}
            className={cn(
              "rounded-md px-3 py-1.5 text-[11.5px] font-medium transition-colors duration-150",
              type === "live"
                ? "bg-white/[0.08] text-white"
                : "text-fog hover:text-white"
            )}
          >
            Live
          </button>
        </div>
      </div>
      <div className="flex items-start gap-1.5 text-[11px] leading-relaxed text-fog/85">
        <AlertTriangle size={11} className="mt-0.5 shrink-0 text-amber-300" />
        The plaintext key is shown ONCE. Copy it immediately and store it
        somewhere safe — there's no way to retrieve it later.
      </div>
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={creating}>
          Cancel
        </Button>
        <Button
          variant="primary"
          size="sm"
          disabled={!name.trim() || creating}
          leftIcon={
            creating ? <Loader2 size={13} className="animate-spin" /> : undefined
          }
          onClick={() => onCreate(name, type)}
        >
          {creating ? "Creating…" : "Create key"}
        </Button>
      </div>
    </div>
  );
}

function JustCreatedKey({
  created,
  onDone,
}: {
  created: CreatedApiKey;
  onDone: () => void;
}) {
  const [copied, setCopied] = React.useState(false);
  const onCopy = () => {
    navigator.clipboard.writeText(created.plaintext).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    });
  };
  return (
    <div className="mb-3 space-y-3 rounded-xl border border-emerald-400/30 bg-emerald-400/[0.06] p-4">
      <div className="flex items-center gap-2 text-[12px] font-semibold text-emerald-100">
        <Check size={13} className="text-emerald-300" />
        Key created — copy it now
      </div>
      <div className="flex items-center gap-2 rounded-lg border border-white/10 bg-ink/60 px-3 py-2">
        <code className="flex-1 truncate font-mono text-[12px] text-white">
          {created.plaintext}
        </code>
        <button
          type="button"
          onClick={onCopy}
          className="inline-flex items-center gap-1.5 rounded-md border border-white/10 bg-white/[0.02] px-2 py-1 text-[11px] font-medium text-fog transition-colors duration-150 hover:border-white/25 hover:text-white"
        >
          {copied ? <Check size={11} /> : <Copy size={11} />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <p className="text-[11px] leading-relaxed text-emerald-100/85">
        Once you dismiss this banner the plaintext is gone for good — the
        server only stores a hash. If you lose it, revoke this key and
        create a new one.
      </p>
      <div className="flex justify-end">
        <Button variant="ghost" size="sm" onClick={onDone}>
          I&apos;ve saved it
        </Button>
      </div>
    </div>
  );
}

function EmptyApiKeys({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="rounded-xl border border-dashed border-white/15 bg-white/[0.015] px-5 py-8 text-center">
      <div className="mx-auto inline-flex size-9 items-center justify-center rounded-xl bg-violet-500/15 text-violet-300 ring-1 ring-violet-400/30">
        <KeyRound size={15} />
      </div>
      <p className="mt-3 text-[13px] font-medium text-white">No API keys yet</p>
      <p className="mt-1 text-[12px] text-fog">
        Create a key to connect AdZoom to your own tools.
      </p>
      <div className="mt-4 inline-flex">
        <Button
          variant="primary"
          size="sm"
          leftIcon={<Plus size={13} />}
          onClick={onCreate}
        >
          New key
        </Button>
      </div>
    </div>
  );
}

function ApiKeyRow({
  k,
  onRevoke,
  onRename,
}: {
  k: ApiKeyDoc;
  onRevoke?: () => void;
  onRename?: (next: string) => void;
}) {
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(k.name);
  React.useEffect(() => {
    setDraft(k.name);
  }, [k.name]);

  const isRevoked = !!k.revoked;
  const masked = `${k.keyPrefix}${"•".repeat(20)}`;

  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-3 rounded-xl border border-white/10 bg-white/[0.02] px-4 py-3",
        isRevoked && "opacity-60"
      )}
    >
      <span
        className={cn(
          "inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.14em]",
          k.type === "live"
            ? "border border-emerald-400/30 bg-emerald-400/10 text-emerald-200"
            : "border border-white/10 bg-white/[0.04] text-fog"
        )}
      >
        {k.type}
      </span>

      {editing ? (
        <div className="flex flex-1 items-center gap-1.5">
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                onRename?.(draft.trim());
                setEditing(false);
              } else if (e.key === "Escape") {
                setDraft(k.name);
                setEditing(false);
              }
            }}
            className="h-8 flex-1 rounded-md border border-white/10 bg-white/[0.02] px-2 text-sm text-white outline-none focus:border-white/25"
          />
          <button
            aria-label="Save name"
            onClick={() => {
              onRename?.(draft.trim());
              setEditing(false);
            }}
            className="inline-flex size-7 items-center justify-center rounded-md text-fog hover:bg-white/[0.06] hover:text-white"
          >
            <Check size={12} />
          </button>
          <button
            aria-label="Cancel"
            onClick={() => {
              setDraft(k.name);
              setEditing(false);
            }}
            className="inline-flex size-7 items-center justify-center rounded-md text-fog hover:bg-white/[0.06] hover:text-white"
          >
            <XIcon size={12} />
          </button>
        </div>
      ) : (
        <span className="min-w-0 truncate text-sm font-medium text-white">
          {k.name}
        </span>
      )}

      <code className="ml-auto truncate font-mono text-xs text-fog">
        {masked}
      </code>

      <div className="flex items-center gap-1">
        <span className="hidden text-[10.5px] text-fog/70 md:inline">
          Created {relTime(k.createdAt)}
          {k.lastUsedAt !== undefined && k.lastUsedAt > 0
            ? ` · Last used ${relTime(k.lastUsedAt)}`
            : k.lastUsedAt === undefined && !isRevoked
              ? " · Never used"
              : ""}
        </span>
        {!isRevoked && onRename && !editing && (
          <button
            aria-label="Rename"
            onClick={() => setEditing(true)}
            className="inline-flex size-8 items-center justify-center rounded-md text-fog transition-colors duration-150 hover:bg-white/[0.06] hover:text-white"
          >
            <Pencil size={13} />
          </button>
        )}
        {!isRevoked && onRevoke && (
          <button
            aria-label="Revoke"
            onClick={onRevoke}
            className="inline-flex size-8 items-center justify-center rounded-md text-fog transition-colors duration-150 hover:bg-rose-500/10 hover:text-rose-300"
          >
            <Trash2 size={13} />
          </button>
        )}
        {isRevoked && k.revokedAt && (
          <span className="text-[10.5px] text-rose-300/80">
            Revoked {relTime(k.revokedAt)}
          </span>
        )}
      </div>
    </div>
  );
}

// ── Atoms ─────────────────────────────────────────────────────────────────

// ── API key system status + error banner ────────────────────────────────

/**
 * Single-line subsystem status indicator. Mirrors the dev-mode render
 * manifest's "X is on / X is off" shape so the user can read it at a
 * glance instead of guessing whether an empty list means "no keys" or
 * "we couldn't load anything".
 *
 * Three states:
 *   - "Ready"            — subscription live, no error.
 *   - "Connecting…"      — initial load, subscription not yet returned.
 *   - "Rules missing"    — permission-denied from Firestore. Almost
 *                          always means firestore.rules hasn't been
 *                          deployed since the apiKeys block was added.
 *   - "Error: <code>"    — any other Firestore failure.
 */
function ApiKeyStatusRow({
  loading,
  error,
}: {
  loading: boolean;
  error: ApiKeysError | null;
}) {
  let label: string;
  let detail: string;
  let tone: "ready" | "loading" | "warn" | "error";
  let Icon: React.ComponentType<{ size?: number; className?: string }>;

  if (error?.code === "permission-denied") {
    label = "Rules missing";
    detail = "Firestore rules don't allow this client to read /apiKeys.";
    tone = "warn";
    Icon = ShieldOff;
  } else if (error) {
    label = "Permission error";
    detail = error.message;
    tone = "error";
    Icon = CircleAlert;
  } else if (loading) {
    label = "Connecting…";
    detail = "Subscribing to your API keys.";
    tone = "loading";
    Icon = Loader2;
  } else {
    label = "Ready";
    detail = "API key reads + writes are live.";
    tone = "ready";
    Icon = Circle;
  }

  const toneCls = {
    ready: "border-emerald-400/30 bg-emerald-400/[0.06] text-emerald-100",
    loading: "border-white/10 bg-white/[0.02] text-fog",
    warn: "border-amber-300/35 bg-amber-400/[0.08] text-amber-100",
    error: "border-rose-400/30 bg-rose-500/[0.08] text-rose-100",
  }[tone];

  return (
    <div
      className={cn(
        "mb-3 flex items-center gap-3 rounded-xl border px-3.5 py-2 text-[11.5px]",
        toneCls
      )}
    >
      <Icon
        size={13}
        className={cn(
          "shrink-0",
          tone === "loading" && "animate-spin",
          tone === "ready" && "fill-emerald-300 text-emerald-300"
        )}
      />
      <span className="font-medium">
        API key system:{" "}
        <span className={tone === "ready" ? "text-emerald-50" : ""}>
          {label}
        </span>
      </span>
      <span className="ml-auto truncate text-fog/85">{detail}</span>
    </div>
  );
}

/**
 * Full-section error state shown when the subscription failed
 * outright. Replaces the empty-state and the list. The message is
 * permission-vs-other-aware so the user gets an actionable next step
 * instead of "something went wrong".
 */
function ApiKeysErrorBanner({ error }: { error: ApiKeysError }) {
  const isPerms = error.code === "permission-denied";
  return (
    <div className="rounded-xl border border-rose-400/30 bg-rose-500/[0.06] px-5 py-4">
      <div className="flex items-start gap-2">
        <AlertTriangle size={14} className="mt-0.5 shrink-0 text-rose-300" />
        <div className="min-w-0">
          <div className="text-[13px] font-semibold text-rose-50">
            Could not load API keys
          </div>
          <p className="mt-1 text-[12px] leading-relaxed text-rose-100/90">
            {isPerms ? (
              <>
                Firestore returned <code className="font-mono">permission-denied</code>.
                This almost always means the rules for{" "}
                <code className="font-mono">users/&#123;uid&#125;/apiKeys</code>{" "}
                haven&apos;t been deployed yet. Run:
              </>
            ) : (
              <>The Firestore subscription failed:</>
            )}
          </p>
          {isPerms ? (
            <pre className="mt-2 overflow-x-auto rounded-md bg-ink/60 px-3 py-2 font-mono text-[11px] text-rose-50">
              firebase deploy --only firestore:rules
            </pre>
          ) : (
            <pre className="mt-2 overflow-x-auto rounded-md bg-ink/60 px-3 py-2 font-mono text-[11px] text-rose-50">
              {error.message}
            </pre>
          )}
          <p className="mt-2 text-[11px] text-rose-100/70">
            The exact error was logged to the browser console for
            inspection.
          </p>
        </div>
      </div>
    </div>
  );
}

/**
 * Compact error banner for the workspace-settings sections. Same
 * visual language as `ApiKeysErrorBanner` but smaller — the
 * `defaults` and `notifications` sections are simpler so the error
 * doesn't need a full diagnosis treatment.
 */
function SettingsErrorBanner({
  error,
  fieldLabel,
}: {
  error: WorkspaceSettingsError;
  fieldLabel: string;
}) {
  const isPerms = error.code === "permission-denied";
  return (
    <div className="rounded-xl border border-rose-400/30 bg-rose-500/[0.06] px-4 py-3">
      <div className="flex items-start gap-2">
        <AlertTriangle size={13} className="mt-0.5 shrink-0 text-rose-300" />
        <div className="min-w-0 text-[12px] leading-relaxed text-rose-100/90">
          <span className="font-semibold text-rose-50">
            Could not load {fieldLabel}.
          </span>{" "}
          {isPerms ? (
            <>
              Firestore returned <code className="font-mono">permission-denied</code>{" "}
              on <code className="font-mono">users/&#123;uid&#125;/settings/workspace</code>.
              Deploy the latest rules:{" "}
              <code className="font-mono">firebase deploy --only firestore:rules</code>.
            </>
          ) : (
            <>{error.message}</>
          )}{" "}
          <span className="text-rose-100/70">
            (Full error logged in the browser console.)
          </span>
        </div>
      </div>
    </div>
  );
}

function Section({
  title,
  description,
  action,
  children,
}: {
  title: string;
  description: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="glass rounded-2xl p-6">
      <div className="mb-5 flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-white">{title}</h3>
          <p className="mt-0.5 text-xs text-fog">{description}</p>
        </div>
        {action}
      </div>
      {children}
    </div>
  );
}

function Select<T extends string>({
  label,
  value,
  onChange,
  options,
  disabled,
}: {
  label: string;
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
  disabled?: boolean;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-medium text-fog">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as T)}
        disabled={disabled}
        className="h-10 w-full rounded-lg border border-white/10 bg-white/[0.02] px-3 text-sm text-white outline-none transition-colors duration-200 focus:border-white/20 focus:bg-white/[0.04] disabled:opacity-60"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value} className="bg-ink">
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function relTime(ms: number): string {
  const diff = Date.now() - ms;
  const s = Math.floor(diff / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
