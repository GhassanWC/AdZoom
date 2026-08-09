import type {
  Creator,
  ExportRow,
  Feature,
  PricingTier,
  Preset,
  Project,
  Testimonial,
} from "./types";

export const creators: Creator[] = [
  { id: "c1", name: "Aria", role: "Indie SaaS", gradient: "from-violet-500 to-cyan-400" },
  { id: "c2", name: "Theo", role: "YouTube, 540k", gradient: "from-rose-500 to-amber-400" },
  { id: "c3", name: "Lin", role: "Educator", gradient: "from-emerald-500 to-cyan-400" },
  { id: "c4", name: "Marcus", role: "Dev advocate", gradient: "from-indigo-500 to-violet-400" },
  { id: "c5", name: "Sana", role: "Creator, 1.2M", gradient: "from-fuchsia-500 to-rose-400" },
  { id: "c6", name: "Joe", role: "Solo founder", gradient: "from-amber-500 to-rose-400" },
  { id: "c7", name: "Yuki", role: "Designer", gradient: "from-cyan-400 to-violet-500" },
  { id: "c8", name: "Devon", role: "Agency lead", gradient: "from-emerald-400 to-indigo-500" },
];

export const testimonials: Testimonial[] = [
  {
    id: "t1",
    name: "Maya Lin",
    role: "Creator, 800k subs",
    quote:
      "Cut my edit time by 70%. The auto-zoom feels intentional — like a real editor sat in the room and made calls.",
    gradient: "from-violet-500 to-cyan-400",
  },
  {
    id: "t2",
    name: "Theo Park",
    role: "Indie SaaS founder",
    quote:
      "Every product demo now ships in an hour. Investors said it felt like we hired a film studio.",
    gradient: "from-rose-500 to-amber-400",
  },
  {
    id: "t3",
    name: "Devon Reeves",
    role: "Agency principal",
    quote:
      "We replaced two Premiere passes per video. Output looks more cinematic than what my editors used to deliver.",
    gradient: "from-emerald-500 to-cyan-400",
  },
  {
    id: "t4",
    name: "Aria Chen",
    role: "Dev advocate, Linear",
    quote:
      "Vertical reframes for shorts are pixel-perfect. The motion tracking on cursor demos is uncanny.",
    gradient: "from-indigo-500 to-violet-400",
  },
  {
    id: "t5",
    name: "Marcus Hall",
    role: "Educator, 1.4M views",
    quote:
      "My tutorials feel like Apple keynotes now. Students stay watching twice as long. Insane.",
    gradient: "from-fuchsia-500 to-rose-400",
  },
  {
    id: "t6",
    name: "Sana Khoury",
    role: "Creator, 1.2M followers",
    quote:
      "Shipping daily TikToks would not be possible without this. One click and the recording cuts itself.",
    gradient: "from-cyan-400 to-violet-500",
  },
];

export const presets: Preset[] = [
  { id: "p1", name: "MrBeast", vibe: "mrbeast", description: "High-contrast, oversized text, punchy cuts.", category: "creator", isInDashboard: true },
  { id: "p2", name: "Cinematic", vibe: "cinematic", description: "Letterboxed, warm grade, slow zooms.", category: "creator", isInDashboard: true },
  { id: "p3", name: "Tutorial", vibe: "tutorial", description: "Annotated callouts and steady cursor focus.", category: "tutorial", isInDashboard: true },
  { id: "p4", name: "TikTok", vibe: "tiktok", description: "9:16 vertical with hook-first framing.", category: "creator", isInDashboard: true },
  { id: "p5", name: "Coding", vibe: "coding", description: "Editor-aware zoom on code blocks.", category: "tutorial", isInDashboard: true },
  { id: "p6", name: "Product Demo", vibe: "product", description: "Clean SaaS UI, soft cursor glow.", category: "product", isInDashboard: false },
  { id: "p7", name: "SaaS Pitch", vibe: "saas", description: "Polished for investor decks.", category: "product", isInDashboard: false },
  { id: "p8", name: "YouTube Long", vibe: "youtube", description: "Long-form pacing, 16:9 zoom rhythm.", category: "creator", isInDashboard: false },
  { id: "p9", name: "Vlog Style", vibe: "vlog", description: "Loose pacing, generous cursor smoothing.", category: "creator", isInDashboard: false },
  { id: "p10", name: "Podcast Clip", vibe: "podcast", description: "Minimal motion, calm pacing.", category: "creator", isInDashboard: false },
  { id: "p11", name: "Live Demo", vibe: "demo", description: "Real-time pacing for live calls.", category: "product", isInDashboard: false },
  { id: "p12", name: "Shorts", vibe: "shorts", description: "Hook-first, sub-60s pacing.", category: "creator", isInDashboard: false },
];

export const featureList: Feature[] = [
  {
    iconName: "Sparkles",
    title: "Auto Click Zoom",
    description: "AI detects every click and zooms cinematically — no keyframes needed.",
  },
  {
    iconName: "MousePointer2",
    title: "Cursor Smoothing",
    description: "Replaces jittery cursor motion with smooth, intentional movement.",
  },
  {
    iconName: "Target",
    title: "Click Highlights",
    description: "Subtle, cinematic ring effects on every click — auto-styled.",
  },
  {
    iconName: "Smartphone",
    title: "Vertical Shorts",
    description: "9:16 reframing that tracks the action, not the canvas.",
  },
  {
    iconName: "Brain",
    title: "AI Tutorial Focus",
    description: "Detects when you're explaining, holds focus, smooths transitions.",
  },
  {
    iconName: "Activity",
    title: "Smart Motion Tracking",
    description: "Locks zoom to your cursor across windows, scrolls, and switches.",
  },
  {
    iconName: "Zap",
    title: "Fast Export",
    description: "4K renders in minutes, not hours. Built on a real-time pipeline.",
  },
  {
    iconName: "Layers",
    title: "One Click Presets",
    description: "MrBeast, Cinematic, Tutorial, TikTok — instant transformations.",
  },
];

// SINGLE SOURCE OF TRUTH for public pricing copy — must match the server-enforced
// export policy in src/lib/export/plan-policy.ts + src/lib/usage/cloud-minutes.ts:
//   Free    — 2 cloud exports/month, 720p, watermark.
//   Pro     — 150 cloud export minutes/month, 1080p, no watermark, 1 active.
//   Creator — 250 cloud export minutes/month, 1080p, priority queue, 2 active.
// No 4K, no "unlimited exports", no API/teams/custom formats (not implemented).
export const pricingTiers: PricingTier[] = [
  {
    name: "Free",
    tagline: "Try Framevo with lightweight exports.",
    price: "$0",
    priceUnit: "forever",
    features: [
      "2 cloud exports per month",
      "720p cloud exports",
      "10 auto-caption minutes/month",
      "Browser export available",
      "Watermark included",
      "Basic AI edits",
      "Community presets",
    ],
    cta: "Start Free",
    highlighted: false,
  },
  {
    name: "Pro",
    tagline: "For creators who export regularly.",
    price: "$25",
    priceUnit: "month",
    features: [
      "150 cloud export minutes/month",
      "150 auto-caption minutes/month",
      "1080p MP4 exports",
      "No watermark",
      "All AI effects",
      "Brand/export presets",
      "1 active cloud export at a time",
    ],
    cta: "Go Pro",
    highlighted: true,
  },
  {
    name: "Creator",
    tagline: "For high-volume creators.",
    price: "$49",
    priceUnit: "month",
    features: [
      "250 cloud export minutes/month",
      "300 auto-caption minutes/month",
      "1080p MP4 exports",
      "No watermark",
      "All AI effects + presets",
      "Priority render queue",
      "2 active cloud exports at a time",
    ],
    cta: "Start Creator",
    highlighted: false,
  },
];

export const projects: Project[] = [
  { id: "pr1", title: "Linear walkthrough — v2", durationSec: 184, editedAt: "2h ago", status: "ready", thumbAccent: "violet", thumbStyle: "saas" },
  { id: "pr2", title: "Migration guide — postgres", durationSec: 421, editedAt: "yesterday", status: "ready", thumbAccent: "cyan", thumbStyle: "code" },
  { id: "pr3", title: "Dashboard redesign demo", durationSec: 96, editedAt: "3d ago", status: "processing", thumbAccent: "indigo", thumbStyle: "browser" },
  { id: "pr4", title: "Launch trailer cut", durationSec: 38, editedAt: "5d ago", status: "draft", thumbAccent: "rose", thumbStyle: "tiktok" },
  { id: "pr5", title: "Onboarding tutorial", durationSec: 312, editedAt: "1w ago", status: "ready", thumbAccent: "emerald", thumbStyle: "tutorial" },
  { id: "pr6", title: "API quickstart", durationSec: 220, editedAt: "1w ago", status: "ready", thumbAccent: "amber", thumbStyle: "code" },
  { id: "pr7", title: "Mobile teardown", durationSec: 148, editedAt: "2w ago", status: "draft", thumbAccent: "violet", thumbStyle: "product" },
  { id: "pr8", title: "AI features demo", durationSec: 271, editedAt: "2w ago", status: "ready", thumbAccent: "cyan", thumbStyle: "saas" },
  { id: "pr9", title: "Founder update — Q2", durationSec: 412, editedAt: "3w ago", status: "ready", thumbAccent: "rose", thumbStyle: "browser" },
];

export const exportsHistory: ExportRow[] = [
  { id: "e1", project: "Linear walkthrough — v2", format: "4K", size: "412 MB", date: "2h ago", status: "ready" },
  { id: "e2", project: "Linear walkthrough — v2", format: "TikTok 9:16", size: "84 MB", date: "2h ago", status: "ready" },
  { id: "e3", project: "Migration guide — postgres", format: "1080p", size: "286 MB", date: "yesterday", status: "ready" },
  { id: "e4", project: "Dashboard redesign demo", format: "4K", size: "—", date: "3d ago", status: "processing" },
  { id: "e5", project: "Launch trailer cut", format: "TikTok 9:16", size: "32 MB", date: "5d ago", status: "ready" },
  { id: "e6", project: "Onboarding tutorial", format: "YouTube 16:9", size: "498 MB", date: "1w ago", status: "ready" },
  { id: "e7", project: "API quickstart", format: "1080p", size: "—", date: "1w ago", status: "failed" },
  { id: "e8", project: "AI features demo", format: "4K", size: "612 MB", date: "2w ago", status: "ready" },
];

export const navLinks = [
  { label: "Features", href: "/features" },
  { label: "Use cases", href: "/use-cases" },
  { label: "Pricing", href: "/pricing" },
  // Reachable in the nav for everyone, including phones and Linux, where the
  // OS-aware download BUTTON deliberately doesn't render — the page explains.
  { label: "Download", href: "/download" },
  { label: "Changelog", href: "/changelog" },
];

export const sidebarItems = [
  { label: "Dashboard", href: "/dashboard", icon: "LayoutDashboard" as const },
  { label: "Upload", href: "/dashboard/upload", icon: "Upload" as const },
  { label: "Projects", href: "/dashboard/projects", icon: "Folder" as const },
  { label: "Record", href: "/dashboard/record", icon: "Video" as const },
  { label: "Processing", href: "/dashboard/processing", icon: "Cpu" as const },
  { label: "Exports", href: "/dashboard/exports", icon: "Download" as const },
  { label: "Billing", href: "/dashboard/billing", icon: "CreditCard" as const },
  { label: "Settings", href: "/dashboard/settings", icon: "Settings" as const },
  // Internal/dev-only — filtered out in production by the Sidebar.
  {
    label: "Diagnostics",
    href: "/dashboard/diagnostics",
    icon: "Activity" as const,
  },
];
