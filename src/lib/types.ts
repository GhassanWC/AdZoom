export type ProjectStatus = "ready" | "processing" | "draft";

export interface Project {
  id: string;
  title: string;
  durationSec: number;
  editedAt: string;
  status: ProjectStatus;
  thumbAccent: "violet" | "cyan" | "amber" | "rose" | "emerald" | "indigo";
  thumbStyle: "browser" | "code" | "saas" | "tutorial" | "tiktok" | "product";
}

export type PresetVibe =
  | "mrbeast"
  | "cinematic"
  | "tutorial"
  | "tiktok"
  | "coding"
  | "product"
  | "saas"
  | "youtube"
  | "vlog"
  | "podcast"
  | "demo"
  | "shorts";

export interface Preset {
  id: string;
  name: string;
  vibe: PresetVibe;
  description: string;
  category: "creator" | "tutorial" | "product";
  isInDashboard: boolean;
}

export interface Creator {
  id: string;
  name: string;
  role: string;
  gradient: string;
}

export interface Testimonial {
  id: string;
  name: string;
  role: string;
  quote: string;
  gradient: string;
}

export interface Feature {
  iconName:
    | "Sparkles"
    | "MousePointer2"
    | "Target"
    | "Smartphone"
    | "Brain"
    | "Activity"
    | "Zap"
    | "Layers";
  title: string;
  description: string;
}

export interface PricingTier {
  name: string;
  tagline: string;
  price: string;
  priceUnit: string;
  features: string[];
  cta: string;
  highlighted: boolean;
}

export type ExportStatus = "ready" | "processing" | "failed";
export type ExportFormat = "1080p" | "4K" | "TikTok 9:16" | "YouTube 16:9";

export interface ExportRow {
  id: string;
  project: string;
  format: ExportFormat;
  size: string;
  date: string;
  status: ExportStatus;
}
