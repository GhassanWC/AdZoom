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
  assert.match(v, /^volume='if\(lt\(t,0\.500000\),\(0\.000000\+\(1\.000000-0\.000000\)\*\(t-0\.000000\)\/0\.500000\),/);
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
  assert.match(g, /\[3:a\]atrim=start=10\.000000:end=11\.000000.*volume='if\(lt\(t.*adelay=500:all=1/);
  // A silent base spans the output so amix never starves during a gap (freeze / cut between runs) — see audio-filtergraph.ts.
  assert.match(g, /anullsrc=r=48000:cl=stereo,atrim=0:2\.000000\[base\];\[base\]\[r0\]\[r1\]\[r2\]amix=inputs=4:normalize=0:duration=first:dropout_transition=0,apad,atrim=0:2\.000000,asetpts=PTS-STARTPTS\[aout\]$/);
  assert.equal(buildSequenceAudioGraph({ runs, inputIndexOf: () => null, sampleRate: 48000, outputDuration: 2 }), null, "no audio inputs → caller muxes -an");
});
