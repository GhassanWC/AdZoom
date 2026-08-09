import UploadPage from "@/app/dashboard/upload/page";

/**
 * `/dashboard/upload` — the website's upload screen.
 *
 * On the desktop it opens the OS file picker instead of a browser file input,
 * keeps the video where it already lives, and creates a local project. That
 * branch is inside the shared page (it asks
 * `platform.media.canPickLocalFiles`), not a second implementation here.
 */
export default function DesktopUploadPage() {
  return <UploadPage />;
}
