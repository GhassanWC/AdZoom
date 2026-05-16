import { cn } from "@/lib/cn";

export function Container({
  children,
  className,
  size = "default",
}: {
  children: React.ReactNode;
  className?: string;
  size?: "default" | "wide" | "narrow";
}) {
  return (
    <div
      className={cn(
        "mx-auto w-full px-6 lg:px-8",
        size === "default" && "max-w-7xl",
        size === "wide" && "max-w-[1440px]",
        size === "narrow" && "max-w-5xl",
        className
      )}
    >
      {children}
    </div>
  );
}
