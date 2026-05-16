import { cn } from "@/lib/cn";

interface PageHeaderProps {
  eyebrow?: string;
  title: string;
  subtitle?: string;
  action?: React.ReactNode;
  className?: string;
}

export function PageHeader({
  eyebrow,
  title,
  subtitle,
  action,
  className,
}: PageHeaderProps) {
  return (
    <div className={cn("flex flex-wrap items-end justify-between gap-3", className)}>
      <div>
        {eyebrow && (
          <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.18em] text-fog">
            <span className="size-1.5 rounded-full bg-violet-400" />
            {eyebrow}
          </div>
        )}
        <h1 className="mt-2 font-display text-2xl font-semibold tracking-tight text-white sm:text-3xl">
          {title}
        </h1>
        {subtitle && <p className="mt-1 text-sm text-fog">{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}
