import { cn } from "@/lib/cn";

export function GradientText({
  children,
  className,
  tone = "neutral",
}: {
  children: React.ReactNode;
  className?: string;
  tone?: "neutral" | "violet";
}) {
  return (
    <span
      className={cn(
        tone === "neutral" && "text-gradient",
        tone === "violet" && "text-gradient-violet",
        className
      )}
    >
      {children}
    </span>
  );
}
