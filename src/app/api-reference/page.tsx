import Link from "next/link";
import { ArrowLeft, Code, ExternalLink, Lock, Terminal } from "lucide-react";
import { Navbar } from "@/components/landing/Navbar";
import { Footer } from "@/components/landing/Footer";
import { Button } from "@/components/ui/Button";

export const metadata = {
  title: "API Reference — AdZoom",
  description: "REST endpoints for integrating AdZoom into your own workflow.",
};

export default function ApiReferencePage() {
  return (
    <>
      <Navbar />
      <main className="relative min-h-screen px-4 pb-24 pt-28 sm:pt-36">
        <div
          aria-hidden
          className="pointer-events-none absolute left-1/2 top-0 -z-10 h-[520px] w-[1100px] -translate-x-1/2 bg-[radial-gradient(ellipse_at_center,rgba(139,92,246,0.18),transparent_65%)] blur-3xl"
        />

        <div className="mx-auto max-w-4xl">
          <Link
            href="/"
            className="inline-flex items-center gap-1.5 text-xs text-fog transition-colors duration-200 hover:text-white"
          >
            <ArrowLeft size={12} />
            Back to home
          </Link>

          <div className="mt-7">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-violet-400/30 bg-violet-500/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.2em] text-violet-100">
              <Code size={11} />
              API
            </span>
            <h1 className="mt-5 font-display text-4xl font-semibold leading-[1.05] tracking-tight text-white sm:text-5xl">
              REST endpoints,{" "}
              <span className="text-gradient-violet">bearer-token auth.</span>
            </h1>
            <p className="mt-6 max-w-2xl text-[16px] leading-relaxed text-fog">
              The AdZoom API is small on purpose. Right now it covers
              authentication and key validation; project + analyze
              endpoints land next.
            </p>
          </div>

          {/* ── Auth section ──────────────────────────────────── */}
          <Section title="Authentication" Icon={Lock}>
            <p>
              All <code>/api/v1/*</code> requests authenticate with a
              bearer token. Generate keys from{" "}
              <Link
                href="/dashboard/settings"
                className="text-violet-300 underline decoration-violet-300/40 underline-offset-4 hover:text-violet-200"
              >
                Settings → API Keys
              </Link>
              .
            </p>
            <ul className="list-disc space-y-2 pl-6 marker:text-violet-400">
              <li>
                Test keys are prefixed{" "}
                <code className="rounded bg-white/[0.05] px-1 font-mono text-[12.5px] text-violet-200">
                  ak_test_
                </code>{" "}
                — safe to ship in CI / staging.
              </li>
              <li>
                Live keys are prefixed{" "}
                <code className="rounded bg-white/[0.05] px-1 font-mono text-[12.5px] text-violet-200">
                  ak_live_
                </code>{" "}
                — production only.
              </li>
              <li>
                Only the SHA-256 hash plus a 12-character prefix is stored
                server-side. The plaintext key is shown to you exactly
                once at creation time. Store it somewhere safe.
              </li>
              <li>
                A revoked key returns <code>401</code> on every call.
                Generating a new key does not invalidate older ones.
              </li>
            </ul>
            <CodeBlock
              label="Header"
              code={`Authorization: Bearer ak_live_a1b2c3d4e5f6g7h8...`}
            />
          </Section>

          {/* ── Endpoints section ─────────────────────────────── */}
          <Section title="Endpoints" Icon={Terminal}>
            <Endpoint
              method="GET"
              path="/api/v1/me"
              status="available"
              summary="Validates the bearer token and returns the account it belongs to. Use for smoke-testing keys and health-checking integrations."
              curl={`curl -H "Authorization: Bearer ak_test_<your-key>" \\
     https://your-app.example.com/api/v1/me`}
              response={`{
  "uid": "8EqHj4PqM...",
  "keyId": "f7a2c1b0...",
  "type": "test"
}`}
              errors={[
                {
                  code: 401,
                  body: `{ "error": "Invalid or revoked API key.", "hint": "Send \\\`Authorization: Bearer ak_test_…\\\` (or \\\`ak_live_…\\\`)." }`,
                },
              ]}
            />

            <Endpoint
              method="POST"
              path="/api/v1/projects"
              status="planned"
              summary="Create a project, upload a video, and trigger analysis. Returns the project id once the upload completes."
            />

            <Endpoint
              method="GET"
              path="/api/v1/projects/{id}"
              status="planned"
              summary="Read a project's current analysis state, timeline moments, and export URLs."
            />

            <Endpoint
              method="POST"
              path="/api/v1/projects/{id}/export"
              status="planned"
              summary="Render the project's current timeline at the requested resolution and aspect ratio."
            />
          </Section>

          {/* ── Errors section ────────────────────────────────── */}
          <Section title="Errors" Icon={Code}>
            <p>
              Every error response is JSON-encoded with at minimum an{" "}
              <code className="rounded bg-white/[0.05] px-1 font-mono text-[12.5px] text-violet-200">
                error
              </code>{" "}
              string. Many also carry a{" "}
              <code className="rounded bg-white/[0.05] px-1 font-mono text-[12.5px] text-violet-200">
                hint
              </code>{" "}
              field with a one-line fix.
            </p>
            <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
              <ErrorRow
                code="401"
                title="Unauthorised"
                body="Missing, malformed, unknown, or revoked API key."
              />
              <ErrorRow
                code="402"
                title="Plan required"
                body="The endpoint or feature you called requires a higher plan."
              />
              <ErrorRow
                code="404"
                title="Not found"
                body="The project (or other resource) doesn't exist on your account."
              />
              <ErrorRow
                code="429"
                title="Rate limited"
                body="Too many calls in a short window. Back off and retry."
              />
              <ErrorRow
                code="5xx"
                title="Server error"
                body="Something went wrong on our side. Retry with backoff."
              />
            </div>
          </Section>

          <div className="mt-20 rounded-3xl border border-white/[0.06] bg-gradient-to-br from-violet-500/[0.06] to-transparent p-8 text-center">
            <h3 className="font-display text-[24px] font-semibold tracking-tight text-white">
              Generate your first key.
            </h3>
            <p className="mx-auto mt-3 max-w-md text-[14px] text-fog">
              Settings → API Keys → Create. Pick test for sandbox use,
              live for production. Plaintext shows once.
            </p>
            <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
              <Button
                href="/dashboard/settings"
                variant="primary"
                size="md"
                rightIcon={<ExternalLink size={13} />}
              >
                Open Settings
              </Button>
              <Button href="/docs" variant="ghost" size="md">
                Read the docs
              </Button>
            </div>
          </div>
        </div>
      </main>
      <Footer />
    </>
  );
}

function Section({
  title,
  Icon,
  children,
}: {
  title: string;
  Icon: React.ComponentType<{ size?: number }>;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-16">
      <div className="mb-4 flex items-center gap-3">
        <span className="inline-flex size-9 items-center justify-center rounded-xl border border-violet-500/30 bg-violet-500/10 text-violet-300">
          <Icon size={15} />
        </span>
        <h2 className="font-display text-[24px] font-semibold tracking-tight text-white">
          {title}
        </h2>
      </div>
      <div className="space-y-4 text-[15px] leading-relaxed text-fog">
        {children}
      </div>
    </section>
  );
}

function CodeBlock({ label, code }: { label?: string; code: string }) {
  return (
    <div className="overflow-hidden rounded-xl border border-white/[0.06] bg-black/40">
      {label && (
        <div className="border-b border-white/[0.06] bg-white/[0.02] px-4 py-2 text-[10.5px] font-semibold uppercase tracking-[0.18em] text-fog">
          {label}
        </div>
      )}
      <pre className="overflow-x-auto p-4 font-mono text-[12.5px] leading-relaxed text-white/85">
        {code}
      </pre>
    </div>
  );
}

function Endpoint({
  method,
  path,
  status,
  summary,
  curl,
  response,
  errors,
}: {
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  status: "available" | "planned";
  summary: string;
  curl?: string;
  response?: string;
  errors?: { code: number; body: string }[];
}) {
  const methodTone =
    method === "GET"
      ? "border-emerald-400/40 bg-emerald-500/10 text-emerald-200"
      : method === "POST"
      ? "border-violet-400/40 bg-violet-500/10 text-violet-200"
      : "border-amber-400/40 bg-amber-500/10 text-amber-200";

  return (
    <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-5">
      <div className="flex flex-wrap items-center gap-2.5">
        <span
          className={`inline-flex items-center rounded border px-2 py-0.5 font-mono text-[10.5px] font-semibold ${methodTone}`}
        >
          {method}
        </span>
        <code className="font-mono text-[13px] text-white/90">{path}</code>
        {status === "planned" ? (
          <span className="ml-auto inline-flex items-center gap-1 rounded-full border border-white/10 bg-white/[0.04] px-2 py-0.5 text-[9.5px] font-semibold uppercase tracking-[0.18em] text-fog">
            Planned
          </span>
        ) : (
          <span className="ml-auto inline-flex items-center gap-1 rounded-full border border-emerald-400/30 bg-emerald-500/10 px-2 py-0.5 text-[9.5px] font-semibold uppercase tracking-[0.18em] text-emerald-200">
            Available
          </span>
        )}
      </div>
      <p className="mt-3 text-[13.5px] leading-relaxed text-fog">{summary}</p>

      {curl && (
        <div className="mt-4">
          <CodeBlock label="cURL" code={curl} />
        </div>
      )}
      {response && (
        <div className="mt-3">
          <CodeBlock label="200 · response" code={response} />
        </div>
      )}
      {errors && errors.length > 0 && (
        <div className="mt-3 space-y-2">
          {errors.map((e, i) => (
            <CodeBlock key={i} label={`${e.code} · error`} code={e.body} />
          ))}
        </div>
      )}
    </div>
  );
}

function ErrorRow({
  code,
  title,
  body,
}: {
  code: string;
  title: string;
  body: string;
}) {
  return (
    <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
      <div className="flex items-baseline gap-3">
        <span className="font-mono text-[12.5px] font-semibold text-violet-200">
          {code}
        </span>
        <span className="font-display text-[13.5px] font-semibold text-white">
          {title}
        </span>
      </div>
      <p className="mt-1.5 text-[12.5px] text-fog">{body}</p>
    </div>
  );
}
