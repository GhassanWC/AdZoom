import * as React from "react";
import Link from "next/link";
import { cn } from "@/lib/cn";

type Variant = "primary" | "ghost" | "glass" | "subtle";
type Size = "sm" | "md" | "lg";

const variantStyles: Record<Variant, string> = {
  primary:
    "bg-violet-500 text-white shadow-[0_8px_24px_-8px_rgba(139,92,246,0.6)] hover:bg-violet-500/90 active:scale-[0.98] focus-visible:ring-2 focus-visible:ring-violet-500/60",
  ghost:
    "border border-white/10 bg-white/[0.02] text-white/90 hover:border-white/20 hover:bg-white/[0.04] focus-visible:ring-2 focus-visible:ring-white/30",
  glass:
    "border border-white/10 bg-white/[0.04] text-white/95 backdrop-blur-md hover:border-white/20 hover:bg-white/[0.06] focus-visible:ring-2 focus-visible:ring-white/30",
  subtle:
    "text-fog hover:text-white focus-visible:ring-2 focus-visible:ring-white/20",
};

const sizeStyles: Record<Size, string> = {
  sm: "h-9 px-4 text-sm",
  md: "h-11 px-5 text-sm",
  lg: "h-12 px-6 text-base",
};

interface BaseProps {
  variant?: Variant;
  size?: Size;
  className?: string;
  children: React.ReactNode;
  leftIcon?: React.ReactNode;
  rightIcon?: React.ReactNode;
}

type ButtonProps = BaseProps &
  React.ButtonHTMLAttributes<HTMLButtonElement> & { href?: undefined };

type LinkProps = BaseProps & {
  href: string;
  target?: string;
  rel?: string;
};

const baseStyles =
  "inline-flex items-center justify-center gap-2 rounded-full font-medium transition-all duration-200 ease-out outline-none focus-visible:ring-offset-2 focus-visible:ring-offset-ink disabled:opacity-50 disabled:pointer-events-none";

export function Button(props: ButtonProps | LinkProps) {
  const {
    variant = "primary",
    size = "md",
    className,
    children,
    leftIcon,
    rightIcon,
    ...rest
  } = props;

  const classes = cn(
    baseStyles,
    variantStyles[variant],
    sizeStyles[size],
    className
  );

  const content = (
    <>
      {leftIcon && <span className="-ml-0.5 flex shrink-0">{leftIcon}</span>}
      <span>{children}</span>
      {rightIcon && <span className="-mr-0.5 flex shrink-0">{rightIcon}</span>}
    </>
  );

  if ("href" in rest && rest.href) {
    const { href, target, rel } = rest;
    return (
      <Link href={href} target={target} rel={rel} className={classes}>
        {content}
      </Link>
    );
  }

  return (
    <button className={classes} {...(rest as React.ButtonHTMLAttributes<HTMLButtonElement>)}>
      {content}
    </button>
  );
}
