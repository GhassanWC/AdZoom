import type { MetadataRoute } from "next";
import { SITE } from "@/lib/seo";

/**
 * Public-route sitemap. Dashboard / login / API routes are intentionally
 * excluded (they're noindex / private).
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date();
  const entry = (
    path: string,
    priority: number,
    changeFrequency: MetadataRoute.Sitemap[number]["changeFrequency"]
  ): MetadataRoute.Sitemap[number] => ({
    url: path === "/" ? SITE.url : `${SITE.url}${path}`,
    lastModified: now,
    changeFrequency,
    priority,
  });

  return [
    entry("/", 1.0, "weekly"),
    entry("/screen-recording-editor", 0.9, "monthly"),
    entry("/features", 0.9, "monthly"),
    entry("/use-cases", 0.9, "monthly"),
    entry("/pricing", 0.8, "monthly"),
    // The app is how people use Framevo, so /download ranks with the top pages.
    entry("/download", 0.9, "weekly"),
    entry("/changelog", 0.6, "weekly"),
    entry("/about", 0.5, "monthly"),
    entry("/docs", 0.5, "monthly"),
    entry("/tutorials", 0.4, "monthly"),
    entry("/templates", 0.4, "monthly"),
    entry("/api-reference", 0.4, "monthly"),
    entry("/blog", 0.4, "weekly"),
    entry("/careers", 0.3, "monthly"),
    entry("/privacy", 0.2, "yearly"),
    entry("/terms", 0.2, "yearly"),
    entry("/security", 0.2, "yearly"),
  ];
}
