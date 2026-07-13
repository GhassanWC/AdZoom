# Third-Party Licences

Framevo's preset library (`src/lib/presets/registry.ts`) contains **designs ported
from two MIT-licensed open-source projects**. This file records exactly what was
taken, from where, and under what terms.

**No third-party code ships in Framevo.** See [What was actually
taken](#what-was-actually-taken) below — this is the important part, and it is not
a formality.

---

## Upstream projects

### 1. `reactvideoeditor/remotion-templates`

| | |
|---|---|
| **URL** | https://github.com/reactvideoeditor/remotion-templates |
| **Pinned commit** | `6209b724798e48ff395f8df1a6fa2d26082372b5` |
| **Files consulted** | `templates/*.tsx` (81 standalone Remotion components) |
| **Licence status** | ⚠️ **MIT by README statement only — the repository contains NO `LICENSE` file.** |

**This repository has no `LICENSE` file.** Its root contains only `README.md` and
the `templates/` directory, and the GitHub API reports `"license": null` for it.
The MIT grant exists **solely** as a statement in the README. Quoted verbatim from
the `## License` section of `README.md` at the pinned commit:

> All templates in this repository are available under the MIT License. You can use
> them in personal and commercial projects, but attribution is appreciated where
> applicable.

Each template file additionally carries this header comment:

> ```
> Free Remotion Template Component
> ---------------------------------
> This template is free to use in your projects!
> Credit appreciated but not required.
>
> Created by the team at https://www.reactvideoeditor.com
> ```

This is an explicit, unambiguous grant of MIT terms for personal **and commercial**
use, made by the copyright holder in the project's own README. We rely on it, we
attribute generously (below), and we have pinned the commit at which we read it.

**Recommendation:** we should ask the maintainer to add an actual `LICENSE` file to
that repository. A README sentence is a real grant, but a `LICENSE` file is the
artefact that licence scanners, downstream consumers and any future dispute would
look for — and a README can be edited without any of the ceremony that changing a
`LICENSE` file implies. Until that happens, the pinned SHA above is our evidence of
the terms we accepted.

### 2. `reactvideoeditor/clippkit`

| | |
|---|---|
| **URL** | https://github.com/reactvideoeditor/clippkit |
| **Pinned commit** | `5973421d5dbf88954ec22c21ab666b3bfc2dac46` |
| **Files consulted** | `apps/docs/registry/default/components/*.tsx` |
| **Licence status** | ✅ **MIT — a real `LICENSE.md` with the full MIT text, "Copyright (c) Clippkit".** |

This repository **does** have a proper licence: `LICENSE.md` at its root contains
the complete MIT licence text under `Copyright (c) Clippkit`, and the GitHub API
reports `"license": {"spdx_id": "MIT"}`. No ambiguity here.

---

## MIT Licence

Both grants above are MIT. The full text, reproduced once:

```
MIT License

Copyright (c) Clippkit
Copyright (c) reactvideoeditor (remotion-templates)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

*(Clippkit's `LICENSE.md` is reproduced verbatim above except that the two
copyright lines are merged, since this single block covers both grants. Note that
Clippkit's own file contains a typo — "documentatipon" — which is corrected here;
the substantive terms are unchanged.)*

---

## What was actually taken

**No upstream code is present in this repository.** Not a file, not a function, not
a line. This is not a technicality — it is forced by architecture:

The upstream projects are **Remotion React components**. They render by calling
`useCurrentFrame()`, `interpolate()` and `spring()` inside JSX, styled with CSS.

Framevo does not render overlays with React. It paints them onto a **2D canvas** in
`src/lib/render/overlay-draw.ts`, and that single module is what the editor
preview, the browser exporter, the Cloud Run worker **and** the Remotion renderer
all call. A vendored React component would therefore draw in exactly **one** of
those four paths — it would be invisible in the canvas preview and in every real
export.

So each design was **read, understood, and reimplemented as data**:

* each template's animation was characterised — entrance curve, spring constants,
  travel distance, stagger, timing, loop period;
* its typography and plate treatment were characterised — weight, tracking, case,
  outline, shadow;
* those characteristics were re-expressed as a `FramevoPreset`: a `TextStyle` plus a
  declarative `PresetAnimation` (see `src/lib/presets/types.ts` and
  `src/lib/presets/animation.ts`), evaluated by Framevo's own canvas renderer.

Two consequences worth stating plainly:

1. **Nothing is a pixel-exact copy.** Where a design depends on something the canvas
   text path genuinely cannot do — per-glyph colour, RGB channel split, SVG rings,
   CSS `clip-path`, non-uniform squash-and-stretch, image assets — the port drops or
   substitutes that element. Every such case is named in the "What was taken" column
   below, rather than glossed over.
2. **Nothing is random.** Several upstream templates call `Math.random()` on every
   frame. That is reproduced nowhere. Framevo's glitch and shake are driven by a
   seeded hash of a quantised frame index, so the exported file is identical to the
   preview the user approved.

These presets are **derivative works of the upstream designs**, which is exactly
what MIT permits ("to use, copy, modify, merge, publish, distribute, sublicense,
and/or sell copies of the Software"), including for commercial use. We attribute
them below regardless, because both projects asked for attribution and because it is
the right thing to do.

---

## Ported designs

Every row below is generated from the `attribution` field carried by each preset in
`src/lib/presets/registry.ts`, so this table **cannot drift** from the code: a preset
without a correct attribution would show up here as a missing or wrong row.

| Framevo preset | Upstream repo | Upstream file | What was taken (design only — never code) |
|---|---|---|---|
| `caption-bold-pop` | remotion-templates | `templates/popping-text.tsx` | Per-unit spring pop entrance (mass 0.4 / damping 8) + heavy outlined caps; the per-character stagger is re-expressed as a word reveal, and the outline is inverted to black-on-white so it stays legible over video. |
| `caption-word-highlight` | remotion-templates | `templates/text-highlight.tsx` | Sequential word-by-word highlight at ~0.6s per word, on a blue/violet accent plate. Upstream sweeps a plate across each word individually; the canvas draws a line as one block, so the sweep becomes one highlight plate behind the progressively revealed text. |
| `caption-typewriter` | clippkit | `apps/docs/registry/default/components/typing-text.tsx` | Monospace character-by-character typing at ~5 frames per character. The blinking cursor is dropped (not expressible on the canvas text path). |
| `title-cinematic-rise` | remotion-templates | `templates/cinematic-title-intro.tsx` | Spring rise from +50px (damping 14 / mass 0.8) with a fade, at 0.05em tracking. The growing gradient underline rule and the delayed subtitle line are dropped — the canvas overlay draws one text block, not a composed card. |
| `title-split-converge` | remotion-templates | `templates/title-split.tsx` | Two-line converge at 0.15em tracking with a blue glow. The opposing per-line travel and the stroke-only top line are not expressible (one transform, one fill per block) — re-expressed as a tracking collapse into the same locked-caps look. |
| `title-bounce-in` | remotion-templates | `templates/bounce-text.tsx` | Spring slide-in from the left inside a scaling rounded plate (damping 100 / stiffness 200). The upstream gradient plate becomes a solid navy plate — the canvas plate fill is a single colour. |
| `title-slide-in` | clippkit | `apps/docs/registry/default/components/sliding-text.tsx` | Directional spring slide from a 200px offset (damping 12 / mass 0.5 / stiffness 100) with a fade. |
| `title-glitch` | remotion-templates | `templates/glitch-text.tsx` | Monospace bold caps with a sine-driven positional tear. The cyan/magenta RGB channel split is not expressible (the canvas text path has one fill per draw) — it becomes a cyan bloom, and the tear is driven by the seeded glitch loop rather than Math.random(), which clippkit's variant of this design uses. |
| `hook-impact-pop` | remotion-templates | `templates/popping-text.tsx` | The overshooting spring scale-pop entrance (mass 0.4 / damping 8) at display size. The upstream per-character colour cycling is not expressible (one fill per draw) — the design keeps its heavy outlined display caps in a single colour. |
| `hook-bubble-pop` | remotion-templates | `templates/bubble-pop-text.tsx` | Character-by-character spring pop (damping 8 / mass 0.3 / stiffness 100) inside a rounded glowing bubble. Upstream gives EACH character its own circular bubble; the canvas plate is per-line, so the row of bubbles becomes one pill and the stagger is carried by a char reveal. |
| `hook-char-tumble` | remotion-templates | `templates/animated-text.tsx` | Character reveal springing from -50px and -180° of rotation (mass 0.5 / damping 10-12, 5-frame stagger). The rotation is applied to the text block rather than per glyph — the canvas has one transform per draw. |
| `hook-pulse-emphasis` | remotion-templates | `templates/pulsing-text.tsx` | Continuous scale + opacity pulse on a 1-second cycle with a soft glow. The upstream per-character phase offset and blurred glow disc behind each glyph are not expressible — the pulse runs on the block and the glow becomes a text shadow. |
| `hook-shake-alert` | remotion-templates | `templates/camera-shake.tsx` | Impact rattle behind wide-tracked caps (0.15em) on a bordered card. Upstream's multi-frequency sine shake decays over the shot; the shared loop has no decay envelope, so this is a constant seeded shake instead. |
| `cta-subscribe-pill` | remotion-templates | `templates/subscribe-reminder.tsx` | Corner pill rising 100px on a spring (damping 14 / stiffness 100) with a slow pulse. The bell icon and the @handle sub-line are dropped (no asset system, one text block per overlay). |
| `cta-button-glow` | remotion-templates | `templates/end-card.tsx` | The end-card's action button: a gradient plate with a delayed spring fade-in and a sin(f*0.08) glow cycle. The gradient becomes a solid indigo fill with a violet bloom — the canvas plate takes one colour. |
| `callout-lower-third` | remotion-templates | `templates/lower-third.tsx` | Staggered slide-in from -400px on a spring (damping 14 / mass 0.7) behind a dark plate. The blue accent rule and left edge-bar are dropped — the overlay renderer draws text plus its own plate, not composed shapes. |
| `callout-notification` | remotion-templates | `templates/notification-pop.tsx` | Toast slide-in from +300px on a spring (damping 14 / stiffness 180 / mass 0.6). The stack of three, the avatar disc and the unread badge are dropped — one moment is one card, and there is no asset system. |
| `callout-quote-serif` | remotion-templates | `templates/quote-card.tsx` | Serif quotation at 1.6 line-height, fading up in a staged sequence. The oversized opening quote-mark glyph and the separately-animated attribution line are dropped — the overlay is one text block. |
| `callout-float-chip` | remotion-templates | `templates/floating-bubble-text.tsx` | Spring scale-in (damping 12 / mass 0.5) plus a 2-second sine bob on a rounded plate. The rotating gradient border is not expressible on the canvas plate. |
| `transition-fade-through-black` | remotion-templates | `templates/fade-through-black.tsx` | The dip-to-black luminance envelope, peaking at the window centre. Upstream cross-fades two scenes; a single-source timeline has only one, so what ports is the envelope and its timing. |
| `transition-cross-dissolve` | remotion-templates | `templates/cross-dissolve.tsx` | The linear cross-fade envelope and its ~0.6s duration. A true A/B dissolve needs two sources; on one timeline it reduces to a soft symmetrical dip. |
| `transition-film-burn` | remotion-templates | `templates/film-burn.tsx` | The warm light-leak bloom: intensity 0 → 0.85 → 0 peaking at the window centre. The drifting multi-blob gradients are not expressible (the transition draws a uniform full-frame fill) — the bloom and its timing are what port. |
| `transition-whip-cut` | remotion-templates | `templates/whip-pan.tsx` | The whip's TIMING — a ~0.25s hit peaking at centre. The horizontal two-scene pan and its scaleX motion-blur stretch are not expressible on a single source; what remains is the hard, fast punch that reads as the whip's cut point. |
| `intro-chapter-card` | remotion-templates | `templates/chapter-title.tsx` | The spring scale-in (damping 12 / stiffness 80) and 0.2em tracked uppercase treatment. The extending hairline rules, centre dot and separate subtitle line are dropped — the overlay is one text block, not a composed card. |
| `intro-countdown-punch` | remotion-templates | `templates/countdown-timer.tsx` | The per-number beat: a 0.8s slot with a spring scale punch (damping 12 / stiffness 200 / mass 0.5) and a fade-out tail. The progress ring is an SVG stroke-dash and is not expressible on the text overlay path. |
| `intro-wordmark-drop` | remotion-templates | `templates/logo-bounce-drop.tsx` | Drop from -200px with an overshooting landing (damping 8 / stiffness 120 / mass 0.8), applied to a text wordmark since Framevo has no asset system. The squash-and-stretch on impact needs non-uniform scale, which the canvas animation model does not have. |
| `intro-brand-typewriter` | remotion-templates | `templates/logo-typewriter.tsx` | Monospace typed reveal at ~4.5 characters/second. The spring-scaled icon disc and the blinking cursor are dropped (no asset system; no trailing-glyph channel on the canvas text path). |
| `outro-end-card` | remotion-templates | `templates/end-card.tsx` | The card itself: a spring scale from 0.8 (damping 12 / mass 0.6) with a slow glow cycle on a dark plate. The glowing border ring becomes a bloom shadow, and the social-icon row is dropped (no asset system). |
| `text-blur-focus` | remotion-templates | `templates/logo-blur-reveal.tsx` | The focus-pull: blur 20px → 0 alongside opacity 0.3 → 1 over ~1.5s. Applied to text (Framevo has no logo/asset system); the delayed company-name line is dropped. |
| `text-spin-scale` | remotion-templates | `templates/logo-scale-rotate.tsx` | Simultaneous spring scale 0 → 1 and a full 360° rotation (damping 10 / stiffness 100 / mass 0.8). Applied to text; the glow-pulse ring and the delayed name line are dropped. |

**30 presets ported** — 28 from `remotion-templates`, 2 from `clippkit`.

### Framevo originals (no upstream origin)

These 8 carry `attribution: { source: "framevo" }`. They are our own designs and are
listed only so the table accounts for the whole registry.

| Framevo preset | Design |
|---|---|
| `caption-clean-lift` | Clean Lift — A readable pill caption that lifts gently into place. |
| `caption-minimal-fade` | Minimal Fade — No plate, no noise — just clean text that fades in. |
| `cta-swipe-up` | Swipe Up — A bottom prompt that floats to invite the swipe. |
| `cta-link-in-bio` | Quiet Link — An understated bottom bar that names where to go next. |
| `outro-thanks-fade` | Soft Sign-off — A quiet closing line that defocuses as it leaves. |
| `outro-handle-card` | Handle Card — Your handle, tracked wide and understated. |
| `text-expand-tracking` | Tracking Expand — Letters drift apart from tight to airy as they appear. |
| `text-fade-up` | Fade Up — The dependable one: a soft rise and fade. |

**38 presets total.**

---

## Designs we deliberately did NOT port

Recorded so nobody re-litigates these later, and so the list of "things the renderer
cannot do" stays honest:

| Upstream | Why not |
|---|---|
| `credits-roll.tsx` | Needs a continuous linear scroll across the whole moment. `AnimPhase` durations are clamped to half the moment (so entrance and exit cannot overlap), which makes a full-length roll inexpressible. |
| `countdown-intro.tsx` | The number changes every second within one shot, wrapped in an SVG progress ring. One moment draws one static string; `intro-countdown-punch` ports the per-number beat instead. |
| `spotlight-reveal.tsx`, `letterbox-reveal.tsx`, `iris-transition.tsx`, `slide-wipe.tsx`, `blinds-transition.tsx`, `clock-wipe.tsx`, `pixel-transition.tsx`, `push-transition.tsx`, `zoom-through.tsx` | All are geometric two-scene reveals built on CSS `clip-path` / opposing transforms. Framevo's `transition` draws a uniform full-frame luminance dip over a single source — it cannot clip or composite two scenes. |
| `zoom-pulse.tsx`, `ken-burns.tsx`, `parallax-pan.tsx`, `image-*.tsx`, `gallery-*.tsx`, `photo-stack.tsx`, `polaroid-frame.tsx`, `logo-*.tsx` (as logos) | Require image assets. Framevo has no asset system. Where a *motion* was worth keeping, it was ported onto text instead (`text-blur-focus`, `text-spin-scale`, `intro-wordmark-drop`, `intro-brand-typewriter`). |
| All 9 chart templates, `stat-counter.tsx`, `progress-bars.tsx`, `circular-progress.tsx`, `sound-wave.tsx`, `progress-steps.tsx` | Need data-driven SVG/DOM geometry. Nothing to express on a text overlay. |
| All 9 background templates (`matrix-rain`, `starfield`, `particle-explosion`, `bokeh-circles`, `noise-grain`, …) | Particle systems and full-frame generative backgrounds. Not an overlay type, and several are `Math.random()`-driven per frame. |
| `card-flip.tsx`, `rotating-carousel.tsx`, `split-screen.tsx`, `picture-in-picture.tsx` | 3D transforms / multi-panel composition. Not expressible on the 2D text overlay path. |
| `vignette-pulse.tsx` | A radial-gradient edge darkening. The transition draws a uniform fill, not a gradient mask. |
| `slide-text.tsx` (remotion-templates) | Duplicate design — the same spring slide as clippkit's `sliding-text.tsx`, which is the parameterised version and is what `title-slide-in` ports. Shipping both would be two presets of one design. |
| clippkit `glitch-text.tsx` / `popping-text.tsx` | Parameterised re-releases of the remotion-templates designs of the same name; the design is credited to the original. clippkit's `sporadicGlitchChance` mode is additionally `Math.random()`-driven per frame, which we cannot use (it would make exports differ from the approved preview). |
| clippkit loaders, waveforms, `toast-card`, `floating-card` | UI-chrome components for a web app, not video overlays (`toast-card`'s motion is already covered by `callout-notification`). |
