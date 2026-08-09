/**
 * The one marker that tells a LOCAL project from a CLOUD one.
 *
 * A local project is a real `ProjectDoc` — same shape, same editor, same render
 * recipe — living in the desktop app's SQLite library instead of Firestore. The
 * only field that distinguishes them is `userId`: Firestore documents carry the
 * signing-in Firebase uid, local ones carry this sentinel.
 *
 * It lives here (not in the Electron main process) because BOTH sides need it:
 * main stamps it when creating a project, and the renderer reads it to decide
 * whether "delete" means `platform.projects.delete` or a Firestore write.
 */
export const LOCAL_OWNER = "local";

/** True when this document belongs to the on-disk library, not to Firestore. */
export function isLocalProject(doc: { userId?: string } | null | undefined): boolean {
  return doc?.userId === LOCAL_OWNER;
}

/** The origin + path prefix the desktop's media protocol serves local files from. */
export const MEDIA_URL_PREFIX = "framevo://app/__media/";

/**
 * Is this project's SOURCE VIDEO only in the cloud?
 *
 * Reading `originalVideoUrl` is enough because of the two-copy rule the desktop
 * library holds (see desktop/src/main/library.ts): a project with a copy on
 * this disk always READS as the local protocol URL, whether or not the cloud
 * also has one. So an `https:` URL here means exactly one thing — this computer
 * does not have the file — which is the "Download" case.
 *
 * On the web this is trivially true for every project and nothing asks: the
 * cloud transfer controls render only where `platform.sync` exists.
 */
export function isCloudOnlyVideo(
  doc: { originalVideoUrl?: string } | null | undefined
): boolean {
  const url = doc?.originalVideoUrl;
  return typeof url === "string" && !url.startsWith(MEDIA_URL_PREFIX) && url.startsWith("https:");
}
