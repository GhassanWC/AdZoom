/**
 * A REALISTIC project fixture for the AI Director tests.
 *
 * This is a 380-second (6:20) SaaS product-demo screen recording with everything
 * a real Framevo project carries: a transcript with word timings, real click
 * interactions, CV-detected moments, long pauses, filler words, boring sections,
 * narrative beats and an attention curve. The Director's integration test drives
 * a full raw-video → finished-video run against it.
 *
 * The content is a coherent story on purpose — intro, feature tour, a PAYMENT
 * demonstration, a result, and a trailing off-topic ramble — so the tests can
 * assert real editorial behaviour ("keep the payment part", "drop the ramble")
 * rather than just checking that numbers move.
 */
import type {
  Analysis,
  DetectedMoment,
  ProjectDoc,
  Transcript,
  TranscriptSegment,
  VisualAnalysis,
} from "../src/lib/firebase/schema.ts";
import { DEFAULT_EFFECTS_SETTINGS } from "../src/lib/firebase/schema.ts";

export const SOURCE_DURATION = 380;

/**
 * The story, in source time:
 *   0–18    intro / talking head over the dashboard
 *   18–40   context: what the product does
 *   40–62   LONG PAUSE + dead air (nothing happens)
 *   62–120  feature tour (clicks)
 *   120–128 pause
 *   128–210 PAYMENT DEMONSTRATION (the important part — clicks, pricing talk)
 *   210–222 a failed attempt / mistake, redone
 *   222–250 result: success screen
 *   250–300 loading spinner / waiting
 *   300–380 off-topic ramble, low value
 */

const SEGMENTS: Array<[number, number, string]> = [
  [0, 6, "Hey everyone, welcome back to the channel."],
  [6, 12, "Today I want to show you how our new dashboard works."],
  [12, 18, "It's been a huge project for the team."],
  [18, 26, "So the product basically helps you manage your subscriptions."],
  [26, 34, "You can see all your customers in one place."],
  [34, 40, "And that's really the core of what we do."],
  // 40–62: silence
  [62, 70, "Let me click into the customers tab here."],
  [70, 78, "You can see we've got a list of everyone who signed up."],
  [78, 88, "And if I click on one of them, I get the full detail view."],
  [88, 100, "This shows their plan, their billing history, everything."],
  [100, 112, "Um, you can also, uh, filter by status up here."],
  [112, 120, "Which is handy when you've got thousands of customers."],
  // 120–128: pause
  [128, 138, "Okay so now let me show you the payment flow, this is the important part."],
  [138, 150, "I'm going to click on upgrade plan for this customer."],
  [150, 162, "And you can see the pricing options come up right here."],
  [162, 174, "We've got the starter tier, the pro tier, and enterprise."],
  [174, 186, "I'll select pro, and now I enter the payment details."],
  [186, 198, "Card number, expiry, and the security code."],
  [198, 210, "And then I just hit confirm payment."],
  [210, 222, "Oh wait, I made a typo there, let me do that again."],
  [222, 234, "There we go — payment confirmed, you can see the success screen."],
  [234, 250, "The customer is now upgraded to the pro plan immediately."],
  // 250–300: loading / waiting
  [300, 315, "Anyway, that's about it for the demo."],
  [315, 330, "Oh, I should mention we're hiring, by the way."],
  [330, 345, "If you're a React developer, get in touch."],
  [345, 360, "Also the weather has been terrible here lately."],
  [360, 380, "Anyway, thanks for watching, see you next time."],
];

function buildTranscript(): Transcript {
  const segments: TranscriptSegment[] = SEGMENTS.map(([startTime, endTime, text], i) => ({
    id: `s${i}`,
    startTime,
    endTime,
    text,
  }));

  // Word timings, evenly distributed inside each segment — enough for the
  // caption generator to produce real word-level lines.
  const words = segments.flatMap((seg) => {
    const tokens = seg.text.split(/\s+/).filter(Boolean);
    const per = (seg.endTime - seg.startTime) / Math.max(1, tokens.length);
    return tokens.map((word, i) => ({
      word,
      startTime: seg.startTime + i * per,
      endTime: seg.startTime + (i + 1) * per,
    }));
  });

  return {
    status: "complete",
    language: "en-US",
    text: segments.map((s) => s.text).join(" "),
    segments,
    words,
    provider: { provider: "test", createdAt: 0 },
  };
}

/** Real click timestamps — the feature tour and the payment flow. */
const CLICK_TIMES = [
  64, 72, 80, 90, 104, // feature tour
  140, 152, 164, 176, 188, 200, // payment flow
  212, 224, // mistake + redo
];

function buildVisualAnalysis(): VisualAnalysis {
  const sampleRate = 1;
  const n = SOURCE_DURATION;
  const motion = new Array<number>(n).fill(40);
  const delta = new Array<number>(n).fill(30);
  const density = new Array<number>(n).fill(120);
  const centroidX = new Array<number>(n).fill(128);
  const centroidY = new Array<number>(n).fill(128);
  const attentionCurve = new Array<number>(n).fill(80);

  // Dead stretches read as frozen.
  const deaden = (a: number, b: number) => {
    for (let i = a; i < b && i < n; i++) {
      motion[i] = 1;
      delta[i] = 0;
      attentionCurve[i] = 5;
    }
  };
  deaden(40, 62); // silence
  deaden(120, 128); // pause
  deaden(250, 300); // loading

  // The payment demo is the attention peak.
  for (let i = 128; i < 250; i++) attentionCurve[i] = 220;
  for (let i = 300; i < 380; i++) attentionCurve[i] = 45; // ramble

  return {
    version: 3,
    sampleRate,
    sampleCount: n,
    motion,
    delta,
    density,
    centroidX,
    centroidY,
    attentionCurve,
    sceneChanges: [
      { t: 62, strength: 0.8 },
      { t: 128, strength: 0.95 },
      { t: 222, strength: 0.9 },
    ],
    clickEvents: CLICK_TIMES.map((t) => ({ t, strength: 0.8 })),
    inferredClicks: CLICK_TIMES.map((t) => ({
      t,
      strength: 0.85,
      region: { x: 0.4, y: 0.45, w: 0.2, h: 0.12 },
    })),
    computeMs: 1,
  };
}

/** The moments a prior analysis pass already produced. */
function buildMoments(): DetectedMoment[] {
  const zoomAt = (
    id: string,
    startTime: number,
    endTime: number,
    label: string,
    attention: number,
    grounded: boolean
  ): DetectedMoment => ({
    id,
    startTime,
    endTime,
    label,
    reason: `Detected ${label.toLowerCase()}.`,
    focusRegion: { x: 0.4, y: 0.45, width: 0.2, height: 0.12 },
    effectType: "zoom",
    source: "ai",
    provenance: grounded ? "event" : "cv",
    attentionScore: attention,
    confidenceScore: grounded ? 0.9 : 0.55,
    targetRegionSource: grounded ? "click-event" : "motion-centroid",
    recommendedIntensity: 0.7,
    narrativeRole: grounded ? "action" : "explanation",
  });

  return [
    zoomAt("m1", 63.5, 66, "Customers tab", 0.6, true),
    zoomAt("m2", 79.5, 82, "Customer detail", 0.65, true),
    zoomAt("m3", 103.5, 106, "Status filter", 0.5, true),
    zoomAt("m4", 139.5, 142, "Upgrade plan click", 0.9, true),
    zoomAt("m5", 151.5, 154, "Pricing options", 0.95, true),
    zoomAt("m6", 175.5, 178, "Select pro tier", 0.9, true),
    zoomAt("m7", 187.5, 190, "Payment details", 0.88, true),
    zoomAt("m8", 199.5, 202, "Confirm payment", 0.92, true),
    zoomAt("m9", 223.5, 226, "Success screen", 0.97, true),
    // The cut engine already found the dead stretches.
    {
      id: "cut1",
      startTime: 40,
      endTime: 62,
      label: "Cut",
      reason: "Dead section — suggested cut.",
      focusRegion: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 },
      effectType: "cut",
      cut: { active: true },
      source: "ai",
      provenance: "cv",
      confidenceScore: 0.9,
    },
    {
      id: "cut2",
      startTime: 250,
      endTime: 300,
      label: "Cut",
      reason: "Idle / loading screen — suggested cut.",
      focusRegion: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 },
      effectType: "cut",
      cut: { active: true },
      source: "ai",
      provenance: "cv",
      confidenceScore: 0.93,
    },
  ];
}

function buildAnalysis(): Analysis {
  return {
    status: "complete",
    summary:
      "A SaaS dashboard walkthrough covering the customer list and a full payment upgrade flow.",
    detectedMoments: buildMoments(),
    boringSections: [
      { startTime: 250, endTime: 300, reason: "Loading spinner — nothing happens." },
      { startTime: 300, endTime: 380, reason: "Off-topic ramble at the end." },
    ],
    videoType: "saas-demo",
    narrativeStructure: [
      { startTime: 0, endTime: 18, role: "intro", label: "Channel intro" },
      { startTime: 18, endTime: 40, role: "explanation", label: "What the product does" },
      { startTime: 40, endTime: 62, role: "filler", label: "Dead air" },
      { startTime: 62, endTime: 128, role: "action", label: "Feature tour" },
      { startTime: 128, endTime: 222, role: "action", label: "Payment demonstration" },
      { startTime: 222, endTime: 250, role: "result", label: "Payment confirmed" },
      { startTime: 250, endTime: 300, role: "filler", label: "Waiting / loading" },
      { startTime: 300, endTime: 380, role: "filler", label: "Off-topic ramble" },
    ],
    transcript: buildTranscript(),
    audioAnalysis: {
      status: "complete",
      hasUsableSpeech: true,
      speechSegments: SEGMENTS.map(([startTime, endTime]) => ({ startTime, endTime })),
      longPauses: [
        { startTime: 40, endTime: 62, duration: 22 },
        { startTime: 120, endTime: 128, duration: 8 },
        { startTime: 250, endTime: 300, duration: 50 },
      ],
      silenceSegments: [
        { startTime: 40, endTime: 62, duration: 22 },
        { startTime: 120, endTime: 128, duration: 8 },
        { startTime: 250, endTime: 300, duration: 50 },
      ],
      fillerWords: [
        { word: "Um", startTime: 100, endTime: 100.4 },
        { word: "uh", startTime: 103.5, endTime: 103.9 },
      ],
      totalSilenceSeconds: 80,
    },
    attentionCurve: buildVisualAnalysis().attentionCurve,
    attentionSampleRate: 1,
  };
}

/** The full realistic project. */
export function demoProject(overrides: Partial<ProjectDoc> = {}): ProjectDoc {
  return {
    id: "proj-demo",
    userId: "u1",
    title: "Dashboard payment walkthrough",
    originalVideoUrl: "https://example.test/video.mp4",
    storagePath: "users/u1/projects/proj-demo/source.mp4",
    duration: SOURCE_DURATION,
    width: 1920,
    height: 1080,
    status: "analyzed",
    selectedVideoType: "product-demo",
    analysis: buildAnalysis(),
    visualAnalysis: buildVisualAnalysis(),
    effectsSettings: { ...DEFAULT_EFFECTS_SETTINGS },
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

/** A project with NO transcript — the honest "captions impossible" path. */
export function noTranscriptProject(): ProjectDoc {
  const p = demoProject();
  const analysis = { ...p.analysis! };
  delete analysis.transcript;
  delete analysis.audioAnalysis;
  return { ...p, analysis };
}

/** A manual edit the user made — must survive every Director run. */
export function userMoment(): DetectedMoment {
  return {
    id: "u-manual-1",
    startTime: 150,
    endTime: 154,
    label: "My zoom",
    reason: "Manually added.",
    focusRegion: { x: 0.1, y: 0.1, width: 0.3, height: 0.3 },
    effectType: "zoom",
    source: "user",
    edited: true,
    intensity: 0.9,
  };
}
