import { createFile, DataStream } from "mp4box";

/**
 * Minimal MP4 demuxer over mp4box.js: parse the container once and return the
 * `VideoDecoderConfig` + the encoded video samples (with presentation times) so
 * the WebCodecs engine can decode arbitrary time windows.
 *
 * mp4box's full type surface is large and version-sensitive; we describe only
 * the slice we touch via a local interface and cast the runtime object to it.
 */
export interface DemuxedSample {
  data: Uint8Array;
  /** Presentation timestamp, microseconds. */
  timestampUs: number;
  /** Sample duration, microseconds. */
  durationUs: number;
  /** Keyframe (random-access point). */
  isSync: boolean;
}

export interface DemuxResult {
  config: VideoDecoderConfig;
  samples: DemuxedSample[];
}

// ── Local structural typing for the mp4box bits we use ──────────────────────
interface Mp4Sample {
  data: Uint8Array;
  cts: number;
  duration: number;
  timescale: number;
  is_sync: boolean;
}
interface Mp4Track {
  id: number;
  codec: string;
  video?: { width: number; height: number };
  track_width?: number;
  track_height?: number;
}
interface Mp4Info {
  videoTracks?: Mp4Track[];
  tracks: Array<Mp4Track & { video?: unknown }>;
}
interface Mp4DescBox {
  write(stream: unknown): void;
}
interface Mp4StsdEntry {
  avcC?: Mp4DescBox;
  hvcC?: Mp4DescBox;
  vpcC?: Mp4DescBox;
  av1C?: Mp4DescBox;
}
interface Mp4File {
  onReady?: (info: Mp4Info) => void;
  onError?: (e: string) => void;
  onSamples?: (id: number, user: unknown, samples: Mp4Sample[]) => void;
  setExtractionOptions(id: number, user: unknown, opts: { nbSamples: number }): void;
  start(): void;
  flush(): void;
  appendBuffer(buf: ArrayBuffer): void;
  getTrackById(id: number): {
    mdia: { minf: { stbl: { stsd: { entries: Mp4StsdEntry[] } } } };
  };
}

// mp4box's DataStream typings are version-sensitive; treat it structurally.
const DS = DataStream as unknown as {
  new (buf: unknown, byteOffset: number, endianness: unknown): {
    buffer: ArrayBuffer;
  };
  BIG_ENDIAN: unknown;
};

function codecDescription(file: Mp4File, trackId: number): Uint8Array {
  const trak = file.getTrackById(trackId);
  for (const entry of trak.mdia.minf.stbl.stsd.entries) {
    const box = entry.avcC ?? entry.hvcC ?? entry.vpcC ?? entry.av1C;
    if (box) {
      const stream = new DS(undefined, 0, DS.BIG_ENDIAN);
      box.write(stream);
      // Strip the 8-byte ISO box header → the raw codec config record.
      return new Uint8Array(stream.buffer, 8);
    }
  }
  throw new Error("mp4: no codec description box (avcC/hvcC/vpcC/av1C)");
}

/** Demux an in-memory MP4 into a decoder config + encoded video samples. */
export function demuxMp4(bytes: ArrayBuffer): Promise<DemuxResult> {
  return new Promise<DemuxResult>((resolve, reject) => {
    const file = createFile() as unknown as Mp4File;
    const samples: DemuxedSample[] = [];
    let config: VideoDecoderConfig | null = null;

    file.onError = (e) => reject(new Error(`mp4box: ${e}`));
    file.onReady = (info) => {
      const vtrack = info.videoTracks?.[0];
      if (!vtrack) {
        reject(new Error("mp4: no video track"));
        return;
      }
      config = {
        codec: vtrack.codec,
        codedWidth: vtrack.video?.width ?? vtrack.track_width,
        codedHeight: vtrack.video?.height ?? vtrack.track_height,
        description: codecDescription(file, vtrack.id),
      };
      file.setExtractionOptions(vtrack.id, null, { nbSamples: Number.MAX_SAFE_INTEGER });
      file.start();
    };
    file.onSamples = (_id, _user, sampleList) => {
      for (const s of sampleList) {
        samples.push({
          data: s.data,
          timestampUs: (s.cts / s.timescale) * 1e6,
          durationUs: (s.duration / s.timescale) * 1e6,
          isSync: !!s.is_sync,
        });
      }
    };

    const buf = bytes as ArrayBuffer & { fileStart?: number };
    buf.fileStart = 0;
    try {
      file.appendBuffer(buf);
      file.flush();
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    // For an in-memory buffer mp4box parses synchronously during append/start,
    // so samples are ready on the next microtask.
    queueMicrotask(() => {
      if (config && samples.length > 0) resolve({ config, samples });
      else reject(new Error("mp4: demux produced no samples"));
    });
  });
}
