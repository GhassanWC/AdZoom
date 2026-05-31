import { Clock, Globe, GraduationCap } from "lucide-react";
import { Container } from "@/components/ui/Container";

const items = [
  {
    Icon: GraduationCap,
    title: "No editing experience required",
    body: "AI delivers the first cut. You only need to refine — and only if you want to.",
  },
  {
    Icon: Clock,
    title: "Minutes, not hours",
    body: "A 90-second recording analyzes in under a minute. Export rolls right after.",
  },
  {
    Icon: Globe,
    title: "Browser-based",
    body: "No download, no installer. Record, edit, and export from any modern browser.",
  },
];

export function TrustStrip() {
  return (
    <section className="relative py-20 lg:py-24">
      <Container>
        <div className="grid grid-cols-1 gap-5 md:grid-cols-3">
          {items.map(({ Icon, title, body }) => (
            <div
              key={title}
              className="flex items-start gap-4 rounded-2xl border border-white/[0.06] bg-white/[0.02] p-5 backdrop-blur"
            >
              <span className="mt-0.5 inline-flex size-10 shrink-0 items-center justify-center rounded-xl border border-violet-500/30 bg-violet-500/10 text-violet-300">
                <Icon size={17} />
              </span>
              <div>
                <h3 className="font-display text-[15px] font-semibold tracking-tight text-white">
                  {title}
                </h3>
                <p className="mt-1 text-[13px] leading-relaxed text-fog">
                  {body}
                </p>
              </div>
            </div>
          ))}
        </div>
      </Container>
    </section>
  );
}
