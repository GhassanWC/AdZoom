import {
  MonitorPlay,
  Route,
  GraduationCap,
  PlayCircle,
  Smartphone,
  Rocket,
  Share2,
  LifeBuoy,
  ScreenShare,
  type LucideIcon,
} from "lucide-react";
import { Section } from "@/components/ui/Section";
import { GlassCard } from "@/components/ui/GlassCard";
import { RevealOnView } from "@/components/ui/RevealOnView";

interface UseCase {
  Icon: LucideIcon;
  title: string;
  body: string;
}

const USE_CASES: UseCase[] = [
  {
    Icon: MonitorPlay,
    title: "Product demos",
    body: "Turn a raw walkthrough into a tight demo that zooms in on the feature you're showing off.",
  },
  {
    Icon: Route,
    title: "SaaS walkthroughs",
    body: "Guide viewers through a flow step by step, with the camera framing each screen that matters.",
  },
  {
    Icon: PlayCircle,
    title: "Tutorials",
    body: "Cut the dead air, speed up the setup, and keep viewers on the steps that matter.",
  },
  {
    Icon: GraduationCap,
    title: "Course videos",
    body: "Produce lesson after lesson with consistent pacing and emphasis — no manual editing pass.",
  },
  {
    Icon: Share2,
    title: "Social clips",
    body: "Reframe one video into vertical clips for TikTok, Reels, and Shorts in a couple of clicks.",
  },
  {
    Icon: Smartphone,
    title: "App demos",
    body: "Highlight every tap and screen change so users can actually follow along.",
  },
  {
    Icon: Rocket,
    title: "Startup launch videos",
    body: "Ship a polished launch video fast enough to hit your date — from a single take.",
  },
  {
    Icon: LifeBuoy,
    title: "Support & how-to videos",
    body: "Answer tickets with short, clear videos that get straight to the fix.",
  },
  {
    Icon: ScreenShare,
    title: "Screen recordings",
    body: "One of Framevo's strongest use cases — cursor, clicks, and key moments turned into camera moves.",
  },
];

export function UseCases() {
  return (
    <Section
      id="use-cases"
      eyebrow="Use cases"
      title={
        <>
          Built for the videos{" "}
          <span className="text-gradient-violet">you already make.</span>
        </>
      }
      subtitle="Upload a video or record your screen — Framevo turns demos, tutorials, walkthroughs, and social clips into something worth watching."
    >
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {USE_CASES.map((u, i) => (
          <RevealOnView key={u.title} delay={i * 0.04}>
            <GlassCard className="h-full p-6">
              <div className="mb-5 inline-flex size-10 items-center justify-center rounded-xl border border-violet-500/30 bg-violet-500/10 text-violet-300">
                <u.Icon size={18} />
              </div>
              <h3 className="font-display text-[15.5px] font-semibold tracking-tight text-white">
                {u.title}
              </h3>
              <p className="mt-2 text-[13.5px] leading-relaxed text-fog">{u.body}</p>
            </GlassCard>
          </RevealOnView>
        ))}
      </div>
    </Section>
  );
}
