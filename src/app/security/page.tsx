import { LegalLayout, LegalSection } from "@/components/legal/LegalLayout";

export const metadata = {
  title: "Security — AdZoom",
  description:
    "How AdZoom protects your account, your recordings, and your data.",
};

export default function SecurityPage() {
  return (
    <LegalLayout
      eyebrow="Security"
      title="Security at AdZoom"
      intro="This page covers the controls in place around your account, your data, and the infrastructure that runs AdZoom. If you spot something we haven't addressed, please report it."
      lastUpdated="May 30, 2026"
    >
      <LegalSection n="01" title="Account security">
        <p>
          Authentication runs through Firebase Authentication. Passwords
          are never stored by AdZoom; the auth provider handles hashing,
          rate-limiting, and session management. We support email +
          password, Google, and any other providers enabled on your
          workspace.
        </p>
        <p>
          API keys generated from the dashboard are hashed (SHA-256)
          before storage. We store only the hash plus a short prefix
          (e.g.{" "}
          <code className="rounded bg-white/[0.05] px-1 font-mono text-[12px] text-violet-200">
            ak_live_a1b2c3d4
          </code>
          ) for display. The plaintext key is shown to you exactly once at
          creation time — store it somewhere safe.
        </p>
      </LegalSection>

      <LegalSection n="02" title="Data at rest">
        <p>
          All project content lives in Google Cloud — Firestore for
          documents, Cloud Storage for video files, sidecar JSON, and
          exports. Both services encrypt data at rest using Google-managed
          keys.
        </p>
        <p>
          Access is enforced by Firestore security rules and Cloud Storage
          rules:
        </p>
        <ul className="list-disc space-y-2 pl-6 marker:text-violet-400">
          <li>
            Every project document lives under{" "}
            <code className="rounded bg-white/[0.05] px-1 font-mono text-[12px] text-violet-200">
              users/&#123;uid&#125;/projects/&#123;id&#125;
            </code>{" "}
            and can only be read or written by the owning account.
          </li>
          <li>
            API keys live under{" "}
            <code className="rounded bg-white/[0.05] px-1 font-mono text-[12px] text-violet-200">
              users/&#123;uid&#125;/apiKeys
            </code>{" "}
            — readable by the owner, never client-writable.
          </li>
          <li>
            The API key index is server-locked. Clients cannot read or
            write it.
          </li>
          <li>
            Storage objects (videos, interactions JSON, exports) are
            scoped to the owning account&apos;s path and gated by the
            same rules.
          </li>
        </ul>
      </LegalSection>

      <LegalSection n="03" title="Data in transit">
        <p>
          All connections between your browser and AdZoom run over TLS.
          Connections from our servers to Firebase, Google Gemini, and
          Lemon Squeezy run over their providers&apos; TLS endpoints.
        </p>
      </LegalSection>

      <LegalSection n="04" title="Recording capture">
        <p>
          Screen capture and microphone access run entirely in your
          browser through standard{" "}
          <code className="rounded bg-white/[0.05] px-1 font-mono text-[12px] text-violet-200">
            getDisplayMedia
          </code>{" "}
          and{" "}
          <code className="rounded bg-white/[0.05] px-1 font-mono text-[12px] text-violet-200">
            getUserMedia
          </code>{" "}
          APIs. Capture only happens after you grant the browser
          permission, and only for the surface you select.
        </p>
        <p>
          When you record a browser tab, AdZoom additionally captures
          coarse interaction events (click positions, scroll, hover,
          idle stretches) and, where available, the bounding rectangle
          of the element you clicked. We do not capture the URL, the DOM,
          page text, role attributes, or keystrokes outside an explicit
          typing event.
        </p>
        <p>
          For external (window or monitor) captures, the bounding-rect
          field is stripped before upload because it would otherwise
          refer to AdZoom&apos;s own UI rather than the captured surface.
        </p>
      </LegalSection>

      <LegalSection n="05" title="Third-party AI processing">
        <p>
          Video analysis is performed by Google Gemini. We send the
          uploaded video and a short prompt; we receive structured JSON
          back (sections, narrative beats, gap-fill labels). Gemini may
          retain inputs per Google&apos;s own retention and usage policy.
        </p>
        <p>
          We do not pass your account email, name, or any user-identifying
          metadata to Gemini.
        </p>
      </LegalSection>

      <LegalSection n="06" title="Payments">
        <p>
          Payment details — card numbers, billing addresses, tax data —
          are handled entirely by Lemon Squeezy. AdZoom only receives
          plan state, subscription identifiers, and webhook events. We
          never see or store card data.
        </p>
      </LegalSection>

      <LegalSection n="07" title="Operational practices">
        <ul className="list-disc space-y-2 pl-6 marker:text-violet-400">
          <li>
            Server-side routes verify the caller&apos;s Firebase ID token
            before reading or writing project data.
          </li>
          <li>
            Plan gates run server-side; client UI mirrors the plan but
            cannot override it.
          </li>
          <li>
            Diagnostic logs are retained for up to 30 days and access is
            limited to engineering staff.
          </li>
          <li>
            Dependencies are tracked and patched as upstream advisories
            arrive.
          </li>
        </ul>
      </LegalSection>

      <LegalSection n="08" title="Responsible disclosure">
        <p>
          If you find a vulnerability, please email{" "}
          <a
            href="mailto:hello@adzoom.app"
            className="text-violet-300 underline decoration-violet-300/40 underline-offset-4 hover:text-violet-200"
          >
            hello@adzoom.app
          </a>{" "}
          with reproduction steps. We will acknowledge within three
          business days and work with you on a remediation timeline.
        </p>
        <p>
          Please give us reasonable time to patch before public
          disclosure, avoid accessing data that isn&apos;t yours, and
          don&apos;t run scanners that could degrade service for other
          users.
        </p>
      </LegalSection>

      <LegalSection n="09" title="What we don't yet have">
        <p>
          We&apos;re honest about the gaps. AdZoom does not yet offer
          SOC 2, ISO 27001, HIPAA, or any other formal compliance
          certification. If you need any of these for your use case, talk
          to us at{" "}
          <a
            href="mailto:hello@adzoom.app"
            className="text-violet-300 underline decoration-violet-300/40 underline-offset-4 hover:text-violet-200"
          >
            hello@adzoom.app
          </a>{" "}
          before bringing AdZoom into a regulated workflow.
        </p>
      </LegalSection>
    </LegalLayout>
  );
}
