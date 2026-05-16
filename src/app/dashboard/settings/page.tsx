"use client";

import * as React from "react";
import { Copy, Eye, EyeOff, Plus } from "lucide-react";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { Button } from "@/components/ui/Button";
import { Toggle } from "@/components/ui/Toggle";

const apiKeys = [
  { name: "Production", key: "ak_live_8f6c9e1a3b2d4f5e6a7b8c9d0e1f2a3b" },
  { name: "Staging", key: "ak_test_2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e" },
];

export default function SettingsPage() {
  const [notifs, setNotifs] = React.useState({
    renderDone: true,
    weeklyDigest: false,
    productNews: true,
  });
  const [revealed, setRevealed] = React.useState<Record<string, boolean>>({});

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Settings"
        title="Workspace settings"
        subtitle="Profile, workspace defaults, notifications, and API access."
      />

      <Section title="Profile" description="Used in your workspace and exports.">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Display name" defaultValue="Aria Chen" />
          <Field label="Email" defaultValue="aria@adzoom.app" type="email" />
        </div>
      </Section>

      <Section title="Workspace defaults" description="Applied to every new project.">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Default preset" defaultValue="Cinematic" />
          <Field label="Default export format" defaultValue="YouTube 16:9" />
        </div>
      </Section>

      <Section title="Notifications" description="Pick what you want to hear about.">
        <div className="space-y-4">
          <Toggle
            label="Render complete"
            description="Ping me when an export finishes."
            checked={notifs.renderDone}
            onChange={(v) => setNotifs((s) => ({ ...s, renderDone: v }))}
          />
          <Toggle
            label="Weekly digest"
            description="Stats and shareable highlights."
            checked={notifs.weeklyDigest}
            onChange={(v) => setNotifs((s) => ({ ...s, weeklyDigest: v }))}
          />
          <Toggle
            label="Product news"
            description="New features, presets, and changelogs."
            checked={notifs.productNews}
            onChange={(v) => setNotifs((s) => ({ ...s, productNews: v }))}
          />
        </div>
      </Section>

      <Section
        title="API keys"
        description="Use the AdZoom API to enhance recordings programmatically."
        action={
          <Button variant="ghost" size="sm" leftIcon={<Plus size={13} />}>
            New key
          </Button>
        }
      >
        <div className="space-y-2.5">
          {apiKeys.map((k) => (
            <div
              key={k.name}
              className="flex flex-wrap items-center gap-3 rounded-xl border border-white/10 bg-white/[0.02] px-4 py-3"
            >
              <span className="text-sm font-medium text-white">{k.name}</span>
              <code className="flex-1 truncate font-mono text-xs text-fog">
                {revealed[k.name] ? k.key : `${k.key.slice(0, 10)}${"•".repeat(20)}`}
              </code>
              <button
                aria-label={revealed[k.name] ? "Hide key" : "Show key"}
                onClick={() => setRevealed((r) => ({ ...r, [k.name]: !r[k.name] }))}
                className="inline-flex size-8 items-center justify-center rounded-md border border-white/10 bg-white/[0.02] text-fog transition-colors duration-200 hover:border-white/20 hover:text-white"
              >
                {revealed[k.name] ? <EyeOff size={13} /> : <Eye size={13} />}
              </button>
              <button
                aria-label="Copy"
                className="inline-flex size-8 items-center justify-center rounded-md border border-white/10 bg-white/[0.02] text-fog transition-colors duration-200 hover:border-white/20 hover:text-white"
              >
                <Copy size={13} />
              </button>
            </div>
          ))}
        </div>
      </Section>

      <div className="flex justify-end">
        <Button variant="primary" size="md">
          Save changes
        </Button>
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

function Field({
  label,
  defaultValue,
  type = "text",
}: {
  label: string;
  defaultValue: string;
  type?: string;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-medium text-fog">{label}</span>
      <input
        type={type}
        defaultValue={defaultValue}
        className="h-10 w-full rounded-lg border border-white/10 bg-white/[0.02] px-3 text-sm text-white outline-none transition-colors duration-200 focus:border-white/20 focus:bg-white/[0.04]"
      />
    </label>
  );
}
