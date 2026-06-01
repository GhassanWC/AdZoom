import { LegalLayout, LegalSection } from "@/components/legal/LegalLayout";

export const metadata = {
  title: "Privacy Policy — Framevo",
  description:
    "How Framevo collects, uses, stores, and shares your data.",
};

export default function PrivacyPage() {
  return (
    <LegalLayout
      eyebrow="Privacy"
      title="Privacy Policy"
      intro="Framevo is a recording, editing, and rendering tool. To do that work we process video, audio, interaction events, and account data. This page explains what we collect, why, where it lives, and the choices you have."
      lastUpdated="May 30, 2026"
    >
      <LegalSection n="01" title="Who we are">
        <p>
          Framevo (&quot;Framevo&quot;, &quot;we&quot;, &quot;us&quot;) is
          operated by Framevo Labs, Inc. We can be reached at{" "}
          <a
            href="mailto:support@framevo.app"
            className="text-violet-300 underline decoration-violet-300/40 underline-offset-4 hover:text-violet-200"
          >
            support@framevo.app
          </a>{" "}
          for any privacy-related question, request, or complaint.
        </p>
      </LegalSection>

      <LegalSection n="02" title="What we collect">
        <p>
          We only collect what the product needs to function and what you
          explicitly send us.
        </p>
        <ul className="list-disc space-y-2 pl-6 marker:text-violet-400">
          <li>
            <strong className="text-white">Account data.</strong> Email
            address, display name, sign-in provider, and authentication
            tokens. We use Firebase Authentication for sign-in.
          </li>
          <li>
            <strong className="text-white">Project content.</strong> The
            recordings you upload or capture in-browser, the interaction
            sidecar file (clicks, scrolls, hovers, idle stretches), the
            generated analysis, your edits, and your rendered exports.
          </li>
          <li>
            <strong className="text-white">Usage telemetry.</strong>{" "}
            Counts of exports, AI analyses, and feature gates we evaluate
            against your plan. We do not record cursor positions, page
            URLs, or keystrokes outside of your active recording.
          </li>
          <li>
            <strong className="text-white">Payment metadata.</strong> If
            you upgrade, our billing partner (Lemon Squeezy) gives us your
            subscription state, plan tier, and a customer identifier. We
            never see or store your card details.
          </li>
          <li>
            <strong className="text-white">Diagnostic logs.</strong>{" "}
            Server-side error logs and stage-by-stage analysis traces.
            These are retained for up to 30 days for debugging.
          </li>
        </ul>
      </LegalSection>

      <LegalSection n="03" title="Where your data lives">
        <p>
          Framevo uses Google Firebase as its primary infrastructure. Your
          account record, project documents, and analysis results live in
          Cloud Firestore. Video files, interaction sidecars, and rendered
          exports live in Cloud Storage. Both are scoped per-user and
          access-controlled by security rules — only your account can read
          or write your data.
        </p>
        <p>
          Subscription state is mirrored from Lemon Squeezy webhooks.
          Authentication tokens are managed by Firebase Authentication.
        </p>
      </LegalSection>

      <LegalSection n="04" title="Third-party processors">
        <p>
          To deliver the product we share specific data with the following
          processors:
        </p>
        <ul className="list-disc space-y-2 pl-6 marker:text-violet-400">
          <li>
            <strong className="text-white">Google Gemini API.</strong> The
            video and a duration hint are sent to Gemini for analysis
            (section classification, narrative segmentation, gap-fill
            labelling). Gemini may retain inputs per its own retention
            policy.
          </li>
          <li>
            <strong className="text-white">Google Firebase.</strong>{" "}
            Authentication, Firestore (project metadata), Cloud Storage
            (video + sidecar files).
          </li>
          <li>
            <strong className="text-white">Lemon Squeezy.</strong> Checkout,
            subscription, and payment processing.
          </li>
          <li>
            <strong className="text-white">Email + transactional.</strong>{" "}
            Account-related emails (verification, billing receipts) are
            sent through our email provider.
          </li>
        </ul>
        <p>
          We do not sell your data, share it with advertisers, or use it to
          train models we do not control.
        </p>
      </LegalSection>

      <LegalSection n="05" title="What we use the data for">
        <ul className="list-disc space-y-2 pl-6 marker:text-violet-400">
          <li>Running the analysis pipeline you triggered.</li>
          <li>Rendering and storing your exports.</li>
          <li>Enforcing plan limits and gating premium features.</li>
          <li>Sending you account, billing, and product-state emails.</li>
          <li>Debugging and improving the product.</li>
        </ul>
        <p>
          Your recordings and edits are not used to train Framevo&apos;s own
          models. Where third-party AI processors are involved (Gemini),
          their training behaviour is governed by their own terms.
        </p>
      </LegalSection>

      <LegalSection n="06" title="Retention">
        <p>
          Project content stays until you delete it or close your account.
          Diagnostic logs are kept for up to 30 days. Closing your account
          deletes account data and projects within 30 days, except where
          we are legally required to retain billing records.
        </p>
      </LegalSection>

      <LegalSection n="07" title="Your rights">
        <p>
          Depending on your jurisdiction (GDPR, CCPA, and equivalents) you
          have the right to access, correct, delete, or export the data we
          hold about you. You can do most of this directly from the
          dashboard. For anything else, email{" "}
          <a
            href="mailto:support@framevo.app"
            className="text-violet-300 underline decoration-violet-300/40 underline-offset-4 hover:text-violet-200"
          >
            support@framevo.app
          </a>{" "}
          and we will respond within 30 days.
        </p>
      </LegalSection>

      <LegalSection n="08" title="Cookies and local storage">
        <p>
          Framevo uses browser local storage and first-party cookies to
          keep you signed in, remember UI preferences, and store
          per-account notifications. We do not run third-party analytics
          or advertising cookies.
        </p>
      </LegalSection>

      <LegalSection n="09" title="Children">
        <p>
          Framevo is not directed at children under 13 (or 16 in
          jurisdictions where the higher age applies). We do not knowingly
          collect data from anyone in that age range.
        </p>
      </LegalSection>

      <LegalSection n="10" title="Changes to this policy">
        <p>
          When this policy changes materially, we will update the
          &quot;last updated&quot; date at the top of the page and notify
          signed-in users by email. Continuing to use Framevo after a
          change means you accept the updated policy.
        </p>
      </LegalSection>
    </LegalLayout>
  );
}
