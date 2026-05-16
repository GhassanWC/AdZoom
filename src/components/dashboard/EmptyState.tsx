import { type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/Button";

interface EmptyStateProps {
  Icon: LucideIcon;
  title: string;
  description: string;
  cta?: { label: string; href: string };
}

export function EmptyState({ Icon, title, description, cta }: EmptyStateProps) {
  return (
    <div className="glass relative overflow-hidden rounded-2xl p-12 text-center">
      <div
        aria-hidden
        className="pointer-events-none absolute left-1/2 top-0 -z-10 h-48 w-96 -translate-x-1/2 bg-[radial-gradient(ellipse_at_top,rgba(139,92,246,0.18),transparent_60%)] blur-2xl"
      />
      <div className="mx-auto inline-flex size-14 items-center justify-center rounded-2xl border border-violet-400/30 bg-violet-500/10 text-violet-300">
        <Icon size={22} />
      </div>
      <h3 className="mt-5 font-display text-xl font-semibold tracking-tight text-white">
        {title}
      </h3>
      <p className="mx-auto mt-2 max-w-md text-sm text-fog">{description}</p>
      {cta && (
        <div className="mt-7">
          <Button href={cta.href} variant="primary" size="md">
            {cta.label}
          </Button>
        </div>
      )}
    </div>
  );
}
