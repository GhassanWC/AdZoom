"use client";

import * as React from "react";

/**
 * Small live webcam preview — renders the user's camera feed in a circular
 * frame. Used in setup to confirm the camera is working and (later) as a
 * floating PiP during recording. Stateless: caller owns the stream.
 */
export function WebcamPreview({
  stream,
  size = 160,
  className,
}: {
  stream: MediaStream | null;
  size?: number;
  className?: string;
}) {
  const videoRef = React.useRef<HTMLVideoElement | null>(null);

  React.useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    v.srcObject = stream;
    if (stream) v.play().catch(() => {});
    return () => {
      v.srcObject = null;
    };
  }, [stream]);

  return (
    <div
      className={
        "relative overflow-hidden rounded-full border border-white/15 bg-black shadow-[0_18px_40px_-20px_rgba(0,0,0,0.7)] " +
        (className ?? "")
      }
      style={{ width: size, height: size }}
    >
      {stream ? (
        <video
          ref={videoRef}
          autoPlay
          muted
          playsInline
          className="h-full w-full -scale-x-100 object-cover"
        />
      ) : (
        <div className="grid h-full w-full place-items-center text-[10px] uppercase tracking-[0.18em] text-fog">
          Off
        </div>
      )}
    </div>
  );
}
