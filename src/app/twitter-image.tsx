import OgImage from "./opengraph-image";
import { SITE } from "@/lib/seo";

// Twitter card reuses the Open Graph card renderer. Route-config fields must be
// statically declared (not re-exported), so we redeclare the literals here.
export const alt = SITE.ogImageAlt;
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default OgImage;
