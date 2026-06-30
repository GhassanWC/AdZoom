import { Plus } from "lucide-react";
import { Section } from "@/components/ui/Section";
import type { FaqItem } from "@/lib/seo";

/**
 * FAQ content — exported so the page can feed the same items to `faqLd()`
 * for FAQPage structured data (answers stay identical between UI + schema).
 */
export const FAQ_ITEMS: FaqItem[] = [
  {
    q: "What is Framevo?",
    a: "Framevo is an AI video editor that helps turn uploaded videos, screen recordings, demos, tutorials, and social clips into polished edits. It adds cuts, zooms, click highlights, focus moments, and speed-ups, then exports for YouTube, TikTok, Reels, and Shorts.",
  },
  {
    q: "Can Framevo edit screen recordings?",
    a: "Yes. Screen recordings are one of Framevo's strongest use cases — it follows the cursor, clicks, and key moments and turns them into camera moves automatically.",
  },
  {
    q: "Can I upload videos instead of recording?",
    a: "Yes. You can upload videos (MP4, MOV, WebM) and let Framevo generate the edits, or record your screen in the browser — either way works.",
  },
  {
    q: "Does Framevo cut boring parts?",
    a: "Yes. Framevo can suggest and apply cuts to remove slow, idle, or low-value sections so the final video feels tighter. Every cut is reviewable — you can restore or delete it.",
  },
  {
    q: "Can Framevo export for TikTok, Reels, Shorts, and YouTube?",
    a: "Yes. Framevo includes canvas and export options for common formats like 16:9, 9:16, 1:1, and 4:5, so one video can become wide, vertical, square, or portrait.",
  },
  {
    q: "Can I control the AI edits?",
    a: "Yes. Framevo generates a timeline you can review, adjust, delete, restore, or export. The AI drafts the edit; you decide what ships.",
  },
  {
    q: "Does Framevo run in the browser?",
    a: "Yes. Analysis and video rendering both run in your browser, so there's nothing to install — and the preview matches the exported file.",
  },
  {
    q: "What are the free plan limits?",
    a: "The free plan includes the full AI editor plus 2 cloud exports per month at 720p with a watermark (browser export is also available). Upgrade to Pro for 150 cloud export minutes a month, 1080p MP4, and no watermark — or Creator for 250 minutes and a priority render queue.",
  },
];

export function FAQ() {
  return (
    <Section
      id="faq"
      eyebrow="FAQ"
      title={
        <>
          Questions about the{" "}
          <span className="text-gradient-violet">AI video editor.</span>
        </>
      }
      size="narrow"
    >
      <div className="mx-auto max-w-3xl divide-y divide-white/[0.07] overflow-hidden rounded-2xl border border-white/10 bg-white/[0.02]">
        {FAQ_ITEMS.map((item) => (
          <details key={item.q} className="group">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-5 py-4 text-left text-[15px] font-medium text-white/90 transition-colors hover:text-white">
              {item.q}
              <Plus
                size={16}
                className="shrink-0 text-fog transition-transform duration-200 group-open:rotate-45"
              />
            </summary>
            <div className="px-5 pb-5 text-[13.5px] leading-relaxed text-fog">
              {item.a}
            </div>
          </details>
        ))}
      </div>
    </Section>
  );
}
