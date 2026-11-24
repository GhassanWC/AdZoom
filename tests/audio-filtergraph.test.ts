import { test } from "node:test";
import assert from "node:assert/strict";
import { atempoChain, buildSequenceAudioGraph, volumeFilter } from "../src/lib/render/audio-filtergraph.ts";
import { planAudio, type TimelineRevision } from "../src/lib/timeline/evaluate.ts";

test("atempo chain stays within ffmpeg's [0.5, 2] per stage", () => {
  assert.deepEqual(atempoChain(2), ["atempo=2.000000"]);
  assert.deepEqual(atempoChain(5), ["atempo=2.0", "atempo=2.0", "atempo=1.250000"]);
  assert.deepEqual(atempoChain(0.2), ["atempo=0.5", "atempo=0.5", "atempo=0.800000"]);
});

test("volume filter: unity omitted, constant collapses, envelope becomes a piecewise expression in local time", () => {
  assert.equal(volumeFilter([{ at: 3, gain: 1 }, { at: 4, gain: 1 }], 3), null);
  assert.equal(volumeFilter([{ at: 3, gain: 0.5 }, { at: 4, gain: 0.5 }], 3), "volume=0.500000");
  const v = volumeFilter([{ at: 3, gain: 0 }, { at: 3.5, gain: 1 }, { at: 5, gain: 1 }], 3)!;
  assert.match(v, /^volume='gte\(t,0\.000000\)\*lt\(t,0\.500000\)\*\(0\.000000\+\(1\.000000-0\.000000\)\*\(t-0\.000000\)\/0\.500000\)\+/);
  assert.match(v, /:eval=frame$/);
});

test("graph: one chain per run, delays, rate handling, mix padded to the output length", () => {
  const rev: TimelineRevision = {
    sequence: {
      version: 1,
      items: [
        { id: "a", kind: "clip", assetId: "source", sourceIn: 2, sourceOut: 4, speed: { keyframes: [{ at: 2, rate: 2 }] }, audio: { pitch: "preserve" } },
        { id: "b", kind: "clip", assetId: "B", sourceIn: 0, sourceOut: 1, audio: { gain: 0.5 } },
      ],
      audioTracks: [{ id: "m", assetId: "music", outputStart: 0.5, sourceIn: 10, sourceOut: 11, fadeIn: 0.5 }],
    },
    moments: [],
    sourceDuration: 10,
    assets: [{ id: "B", kind: "video", url: "", duration: 5 }, { id: "music", kind: "audio", url: "", duration: 60 }],
  };
  const runs = planAudio(rev);
  const g = buildSequenceAudioGraph({ runs, inputIndexOf: (a) => ({ source: 1, B: 2, music: 3 })[a] ?? null, sampleRate: 48000, outputDuration: 2 })!;
  assert.match(g, /\[1:a\]atrim=start=2\.000000:end=4\.000000,asetpts=PTS-STARTPTS,atempo=2\.000000/);
  assert.match(g, /\[2:a\]atrim=start=0\.000000:end=1\.000000,asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,volume=0\.500000,adelay=1000:all=1/);
  assert.match(g, /\[3:a\]atrim=start=10\.000000:end=11\.000000.*volume='gte\(t.*adelay=500:all=1/);
  // A silent base spans the output so amix never starves during a gap (freeze / cut between runs) — see audio-filtergraph.ts.
  assert.match(g, /anullsrc=r=48000:cl=stereo,atrim=0:2\.000000\[base\];\[base\]\[r0\]\[r1\]\[r2\]amix=inputs=4:normalize=0:duration=first:dropout_transition=0,apad,atrim=0:2\.000000,asetpts=PTS-STARTPTS\[aout\]$/);
  assert.equal(buildSequenceAudioGraph({ runs, inputIndexOf: () => null, sampleRate: 48000, outputDuration: 2 }), null, "no audio inputs → caller muxes -an");
});

test("a mono asset is upmixed at full level (pan), not with the -3 dB default", async () => {
  const { buildSequenceAudioGraph: build } = await import("../src/lib/render/audio-filtergraph.ts");
  const runs = [{ stemId: "item:a", assetId: "source", outputStart: 0, outputEnd: 2, sourceStart: 0, rate: 1, pitch: "follow" as const, gain: [{ at: 0, gain: 1 }, { at: 2, gain: 1 }] }];
  const mono = build({ runs, inputIndexOf: () => 1, channelsOf: () => 1, sampleRate: 48000, outputDuration: 2 })!;
  assert.match(mono, /aresample=48000,pan=stereo\|c0=c0\|c1=c0,aformat=sample_fmts=fltp:channel_layouts=stereo/);
  const stereo = build({ runs, inputIndexOf: () => 1, channelsOf: () => 2, sampleRate: 48000, outputDuration: 2 })!;
  assert.doesNotMatch(stereo, /pan=/);
});

test("a long sampled envelope (fade + duck on a 20 ms grid) collapses to its breakpoints and a flat expression", async () => {
  const { volumeFilter: vf } = await import("../src/lib/render/audio-filtergraph.ts");
  // 6 s: fade-in 0→1 over 1 s, duck to 0.2 between 2 and 4 s (0.2 s ramps), fade-out from 5.5 s.
  const env = (t: number) => {
    let g = Math.min(1, t / 1) * (t >= 5.5 ? Math.max(0, (6 - t) / 0.5) : 1);
    if (t >= 2 && t < 2.2) g *= 1 - 0.8 * ((t - 2) / 0.2);
    else if (t >= 2.2 && t < 4) g *= 0.2;
    else if (t >= 4 && t < 4.2) g *= 0.2 + 0.8 * ((t - 4) / 0.2);
    return g;
  };
  const pts = Array.from({ length: 301 }, (_, i) => ({ at: i * 0.02, gain: env(i * 0.02) }));
  const f = vf(pts, 0)!;
  assert.doesNotMatch(f, /if\(/, "no nested if()");
  const segments = f.split("+gte(").length;
  assert.ok(segments < 16, `breakpoints only (${segments} segments)`);
  assert.ok(f.length < 1500, `short expression (${f.length} chars)`);
  assert.match(f, /gte\(t,2\.000000\)\*lt\(t,2\.200000\)/, "duck attack segment kept");
  assert.match(f, /lt\(t,1\.000000\)/, "fade-in end kept");
});
