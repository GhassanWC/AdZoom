import { cn } from "@/lib/cn";
import { Container } from "./Container";

interface SectionProps {
  id?: string;
  eyebrow?: string;
  title?: React.ReactNode;
  subtitle?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  innerClassName?: string;
  align?: "left" | "center";
  size?: "default" | "wide" | "narrow";
}

export function Section({
  id,
  eyebrow,
  title,
  subtitle,
  children,
  className,
  innerClassName,
  align = "center",
  size = "default",
}: SectionProps) {
  return (
    <section
      id={id}
      className={cn("relative py-24 lg:py-32", className)}
    >
      <Container size={size} className={innerClassName}>
        {(eyebrow || title || subtitle) && (
          <div
            className={cn(
              "mb-16 lg:mb-20",
              align === "center" && "mx-auto max-w-3xl text-center",
              align === "left" && "max-w-3xl"
            )}
          >
            {eyebrow && (
              <div
                className={cn(
                  "mb-5 inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.02] px-3 py-1 text-[11px] font-medium uppercase tracking-[0.18em] text-fog backdrop-blur-md"
                )}
              >
                <span className="inline-block size-1.5 rounded-full bg-violet-400" />
                {eyebrow}
              </div>
            )}
            {title && (
              <h2 className="font-display text-4xl font-semibold leading-[1.05] tracking-tight text-white sm:text-5xl lg:text-[56px]">
                {title}
              </h2>
            )}
            {subtitle && (
              <p
                className={cn(
                  "mt-5 text-base leading-relaxed text-fog sm:text-lg",
                  align === "center" && "mx-auto max-w-2xl"
                )}
              >
                {subtitle}
              </p>
            )}
          </div>
        )}
        {children}
      </Container>
    </section>
  );
}
