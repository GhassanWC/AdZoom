# FFmpeg licensing

## What ships today

The installer bundles the `ffmpeg-static` / `ffprobe-static` binaries
(FFmpeg **6.1.1**, Gyan.dev "essentials" build for Windows), copied into
`resources/ffmpeg/` at package time along with their `LICENSE` file as
`FFMPEG-LICENSE.txt`.

That build is configured with `--enable-gpl --enable-version3`, which makes it
**GPL v3**. This matters, so be explicit about it:

- Framevo **invokes** `ffmpeg.exe` as a separate process over a command line.
  It does not link FFmpeg into the application, and no FFmpeg header or library
  is compiled into Framevo's own code. Distributing the two together is
  aggregation, not derivation — the standard reading, and the same one every
  Electron app that ships a bundled FFmpeg relies on.
- Distributing the GPL binary still carries GPL obligations **for that binary**:
  ship its licence text (we do), state where the corresponding source is, and
  offer that source on request.
- Framevo's own source is not made GPL by this.

If you are not comfortable with that reading, use an LGPL build instead — see
below. This is a business decision, not a technical one, and it should be
ratified before public distribution.

## Attribution to include in the app/release notes

> This software uses libraries from the FFmpeg project under the GPLv3.
> FFmpeg is a trademark of Fabrice Bellard, originator of the FFmpeg project.
> Source: https://ffmpeg.org/download.html — the exact build shipped is
> recorded in `resources/ffmpeg/FFMPEG-LICENSE.txt`.

## Swapping in an LGPL build

Nothing in the app depends on which build is present — only on the two binaries
existing:

1. Download an LGPL variant (e.g. BtbN's `ffmpeg-master-lgpl` for Windows).
2. Replace `resources/ffmpeg/ffmpeg.exe` and `resources/ffmpeg/ffprobe.exe` in
   the packaged app, or point `stageResources()` at the new files, or set
   `FRAMEVO_FFMPEG_PATH` / `FRAMEVO_FFPROBE_PATH` at runtime.
3. Ship that build's licence text in place of the current one.

Verify afterwards with `npm run desktop:test` — `ffmpeg-encoders.test.mts`
re-probes the binary and reports which encoders the new build actually
supports. An LGPL build normally still includes NVENC, Quick Sync, AMF and
VideoToolbox (they are not GPL-only), but it will **not** include `libx264`,
which is GPL. If you swap to LGPL, the software fallback becomes FFmpeg's
built-in `mpeg4`/`h264` support rather than x264 — decide that consciously, and
update `desktop/src/main/export/encoders.ts`'s candidate list accordingly.

## Why FFmpeg is bundled at all

A user's machine cannot be assumed to have FFmpeg, and silently depending on
one that might be a different version is how renders become irreproducible. The
bundled binary is the same one the cloud worker uses, which is part of what
makes desktop and cloud exports match.
