// `ffprobe-static` ships no type declarations (unlike `ffmpeg-static`). It
// default-exports an object whose `.path` is the bundled ffprobe binary path.
declare module "ffprobe-static" {
  const ffprobeStatic: { path: string; version: string };
  export default ffprobeStatic;
}
