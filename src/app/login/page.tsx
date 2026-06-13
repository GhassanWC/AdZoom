import { Suspense } from "react";
import { LoginCard } from "./LoginCard";
import { PAGE_TITLE } from "@/lib/branding";

export const metadata = {
  title: PAGE_TITLE.login,
  robots: { index: false, follow: false },
};

export default function LoginPage() {
  return (
    <main className="relative grid min-h-screen place-items-center px-4 py-16">
      <div
        aria-hidden
        className="pointer-events-none absolute left-1/2 top-0 -z-10 h-[480px] w-[900px] -translate-x-1/2 bg-[radial-gradient(ellipse_at_center,rgba(139,92,246,0.18),transparent_60%)] blur-3xl"
      />
      <div
        aria-hidden
        className="bg-grid mask-radial pointer-events-none absolute inset-0 -z-10 opacity-50"
      />
      <Suspense fallback={null}>
        <LoginCard />
      </Suspense>
    </main>
  );
}
