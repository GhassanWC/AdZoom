/**
 * Client-side validation for file uploads and video URLs.
 * @module utils/validators
 */

/** Accepted video MIME types */
export const ACCEPTED_VIDEO_TYPES = [
  'video/mp4',
  'video/quicktime', // MOV
  'video/webm',
  'video/x-msvideo', // AVI
  'video/x-matroska', // MKV
];

/** Accepted file extensions (for fallback when MIME may be wrong) */
export const ACCEPTED_EXTENSIONS = ['.mp4', '.mov', '.webm', '.avi', '.mkv'];

/** Max file size in bytes (500 MB) */
export const MAX_FILE_SIZE_BYTES = 500 * 1024 * 1024;

/** URL protocols we allow for video */
const ALLOWED_PROTOCOLS = ['http:', 'https:'];

/**
 * Validates a video file (type and size).
 * @param {File} file - The file to validate.
 * @returns {{ valid: boolean, error?: string }}
 */
export function validateVideoFile(file) {
  if (!file || !(file instanceof File)) {
    return { valid: false, error: 'No file selected.' };
  }

  const name = (file.name || '').toLowerCase();
  const ext = ACCEPTED_EXTENSIONS.some((e) => name.endsWith(e));
  const type = ACCEPTED_VIDEO_TYPES.includes(file.type);

  if (!ext && !type) {
    return {
      valid: false,
      error: 'Unsupported file type. Please use MP4, MOV, WebM, AVI, or MKV.',
    };
  }

  if (file.size > MAX_FILE_SIZE_BYTES) {
    const maxMB = MAX_FILE_SIZE_BYTES / (1024 * 1024);
    return {
      valid: false,
      error: `File is too large. Maximum size is ${maxMB} MB.`,
    };
  }

  return { valid: true };
}

/**
 * Validates a video URL (format and protocol).
 * @param {string} urlString - The URL string to validate.
 * @returns {{ valid: boolean, error?: string, url?: string }}
 */
export function validateVideoUrl(urlString) {
  const trimmed = (urlString || '').trim();

  if (!trimmed) {
    return { valid: false, error: 'Please enter a video URL.' };
  }

  let url;
  try {
    url = new URL(trimmed);
  } catch {
    return { valid: false, error: 'Please enter a valid URL.' };
  }

  if (!ALLOWED_PROTOCOLS.includes(url.protocol)) {
    return {
      valid: false,
      error: 'URL must use HTTP or HTTPS.',
    };
  }

  return { valid: true, url: url.href };
}
