import { LegalLayout, LegalSection } from "@/components/legal/LegalLayout";

export const metadata = {
  title: "Terms of Service — AdZoom",
  description:
    "The terms that govern your use of AdZoom.",
};

export default function TermsPage() {
  return (
    <LegalLayout
      eyebrow="Terms"
      title="Terms of Service"
      intro="These terms govern your use of AdZoom. By creating an account or using the service you accept them. If you don't, please stop using AdZoom."
      lastUpdated="May 30, 2026"
    >
      <LegalSection n="01" title="The service">
        <p>
          AdZoom is a browser-based video editor. It records your screen
          and interactions, runs analysis through AI providers, and
          renders cinematic edits you can export. The features available
          to you depend on the plan attached to your account.
        </p>
      </LegalSection>

      <LegalSection n="02" title="Your account">
        <p>
          You need an account to use AdZoom. You are responsible for the
          credentials you use to sign in and for everything that happens
          under your account. Notify us immediately at{" "}
          <a
            href="mailto:hello@adzoom.app"
            className="text-violet-300 underline decoration-violet-300/40 underline-offset-4 hover:text-violet-200"
          >
            hello@adzoom.app
          </a>{" "}
          if you suspect unauthorised use.
        </p>
        <p>
          You must be old enough to form a binding contract in your
          jurisdiction (typically 13, or 16 in some regions). Accounts
          owned by organisations are bound by these terms regardless of
          which individual signs in.
        </p>
      </LegalSection>

      <LegalSection n="03" title="Your content">
        <p>
          You retain ownership of every recording, edit, and exported
          video you create with AdZoom. You grant AdZoom a limited
          licence to host, process, and display that content solely to
          operate the service on your behalf — for example, running the
          analysis pipeline, storing your timeline, and rendering your
          exports.
        </p>
        <p>
          You are responsible for the legality of what you record and
          share. Do not use AdZoom to capture, edit, or distribute content
          that infringes third-party rights, violates privacy laws, or is
          otherwise unlawful.
        </p>
      </LegalSection>

      <LegalSection n="04" title="Acceptable use">
        <p>You agree not to:</p>
        <ul className="list-disc space-y-2 pl-6 marker:text-violet-400">
          <li>
            Use AdZoom to record people without the consent required in
            their jurisdiction.
          </li>
          <li>
            Upload malware, attempt to circumvent plan limits, abuse the
            AI analysis endpoints, or otherwise interfere with the
            service.
          </li>
          <li>
            Reverse-engineer the editor, scrape the API outside the
            documented surface, or resell access to AdZoom.
          </li>
          <li>Use the service for unlawful or harassing purposes.</li>
        </ul>
        <p>
          We may suspend or close accounts that violate this section. For
          severe violations we may do so without prior notice.
        </p>
      </LegalSection>

      <LegalSection n="05" title="Plans and billing">
        <p>
          Free accounts have monthly export and analysis limits.
          Subscription plans (Creator, Pro, and any future tier) unlock
          higher limits and premium features. Pricing is shown on the{" "}
          <a
            href="/pricing"
            className="text-violet-300 underline decoration-violet-300/40 underline-offset-4 hover:text-violet-200"
          >
            pricing page
          </a>{" "}
          and may change with notice to active subscribers.
        </p>
        <p>
          Billing runs through Lemon Squeezy. Subscriptions renew at the
          interval you selected. You can cancel at any time from your
          billing settings; cancellation takes effect at the end of the
          current billing period.
        </p>
        <p>
          Except where required by law, fees already paid are
          non-refundable. We will refund clearly erroneous charges on
          request.
        </p>
      </LegalSection>

      <LegalSection n="06" title="AI features">
        <p>
          AdZoom uses third-party AI models (currently Google Gemini) to
          analyse your recordings. AI output is generated automatically
          and may be incomplete, incorrect, or unexpected. You are
          responsible for reviewing every edit before publishing it.
        </p>
        <p>
          The AI pipeline produces a draft. The timeline editor exists so
          you can override, retime, reframe, or delete anything the AI
          proposed.
        </p>
      </LegalSection>

      <LegalSection n="07" title="Service availability">
        <p>
          We aim for high availability but cannot guarantee
          uninterrupted service. Maintenance windows, third-party
          outages, or capacity events may degrade or temporarily stop
          analysis and rendering. Where possible we will give advance
          notice of planned maintenance.
        </p>
      </LegalSection>

      <LegalSection n="08" title="Termination">
        <p>
          You can close your account at any time from settings. We can
          close or suspend an account that breaches these terms, harms
          other users, or exposes us to legal risk. On termination we
          will delete your account data within 30 days, subject to
          retention obligations described in the{" "}
          <a
            href="/privacy"
            className="text-violet-300 underline decoration-violet-300/40 underline-offset-4 hover:text-violet-200"
          >
            privacy policy
          </a>
          .
        </p>
      </LegalSection>

      <LegalSection n="09" title="Disclaimers">
        <p>
          AdZoom is provided &quot;as is&quot;. To the maximum extent
          permitted by law, we disclaim all implied warranties including
          merchantability, fitness for a particular purpose, and
          non-infringement.
        </p>
      </LegalSection>

      <LegalSection n="10" title="Limitation of liability">
        <p>
          To the maximum extent permitted by law, AdZoom&apos;s aggregate
          liability for any claim arising out of or relating to these
          terms or the service is limited to the amount you paid us in
          the twelve months before the claim arose, or USD 100, whichever
          is greater. We are not liable for indirect, incidental,
          consequential, or punitive damages.
        </p>
      </LegalSection>

      <LegalSection n="11" title="Changes">
        <p>
          When these terms change materially we will update the
          &quot;last updated&quot; date and notify signed-in users.
          Continued use of AdZoom after the change means you accept the
          updated terms.
        </p>
      </LegalSection>

      <LegalSection n="12" title="Governing law">
        <p>
          These terms are governed by the laws of the jurisdiction where
          AdZoom Labs, Inc. is incorporated, without regard to conflict
          of laws principles. Disputes should be raised first at{" "}
          <a
            href="mailto:hello@adzoom.app"
            className="text-violet-300 underline decoration-violet-300/40 underline-offset-4 hover:text-violet-200"
          >
            hello@adzoom.app
          </a>{" "}
          before any formal proceeding.
        </p>
      </LegalSection>
    </LegalLayout>
  );
}
