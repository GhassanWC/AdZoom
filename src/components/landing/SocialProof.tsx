import { Container } from "@/components/ui/Container";
import { creators } from "@/lib/mockData";
import { RevealOnView } from "@/components/ui/RevealOnView";

const stats = [
  { value: "12M+", label: "video views generated" },
  { value: "4,000+", label: "creators on board" },
  { value: "120k", label: "exports rendered" },
];

const logos = [
  { name: "Lumen", svg: "L" },
  { name: "Helio", svg: "H" },
  { name: "Northwind", svg: "N" },
  { name: "Pulse", svg: "P" },
  { name: "Vault", svg: "V" },
  { name: "Tempo", svg: "T" },
];

export function SocialProof() {
  return (
    <section className="relative py-20">
      <Container>
        <RevealOnView className="mx-auto flex max-w-xl flex-col items-center text-center">
          <div className="flex -space-x-2">
            {creators.slice(0, 7).map((c) => (
              <span
                key={c.id}
                aria-label={c.name}
                className={`size-9 rounded-full bg-gradient-to-br ${c.gradient} ring-2 ring-ink shadow-cinematic`}
              />
            ))}
            <span className="ml-2 inline-flex h-9 items-center rounded-full border border-white/10 bg-white/[0.04] px-3 text-xs font-medium text-fog">
              +4,000 creators
            </span>
          </div>
          <p className="mt-5 text-sm text-fog">
            Trusted by indie creators, founders, and educators shipping daily.
          </p>
        </RevealOnView>

        <div className="mt-16 grid grid-cols-1 gap-px overflow-hidden rounded-2xl border border-white/[0.06] bg-white/[0.04] sm:grid-cols-3">
          {stats.map((s) => (
            <div
              key={s.label}
              className="bg-ink px-6 py-10 text-center"
            >
              <div className="font-display text-4xl font-semibold tracking-tight text-white sm:text-5xl">
                {s.value}
              </div>
              <div className="mt-2 text-xs uppercase tracking-[0.18em] text-fog">
                {s.label}
              </div>
            </div>
          ))}
        </div>

        <div className="mt-14">
          <p className="text-center text-[11px] uppercase tracking-[0.18em] text-fog">
            Built by people who shipped at
          </p>
          <div className="mt-6 grid grid-cols-3 items-center gap-8 sm:grid-cols-6">
            {logos.map((l) => (
              <div
                key={l.name}
                className="flex items-center justify-center gap-2 text-fog/70 transition-colors duration-200 hover:text-white"
                aria-label={l.name}
              >
                <span className="inline-flex size-7 items-center justify-center rounded-md border border-white/10 bg-white/[0.02] font-display text-sm font-semibold">
                  {l.svg}
                </span>
                <span className="font-display text-sm tracking-tight">{l.name}</span>
              </div>
            ))}
          </div>
        </div>
      </Container>
    </section>
  );
}
