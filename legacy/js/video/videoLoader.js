/**
 * Loads video from file or URL into the video element.
 * @module video/videoLoader
 */

import { handleError, clearError } from '../utils/errorHandler.js';

/**
 * Loads a video from a File (e.g. user upload) into the video element.
 * @param {HTMLVideoElement} video - Video element.
 * @param {File} file - Selected file.
 * @param {HTMLElement|null} [errorElement] - Element to show errors.
 * @returns {Promise<void>}
 */
export function loadVideoFromFile(video, file, errorElement = null) {
  if (!video || !(video instanceof HTMLVideoElement)) {
    handleError(new Error('Invalid video element'), { messageElement: errorElement });
    return Promise.reject(new Error('Invalid video element'));
  }
  if (!file || !(file instanceof File)) {
    handleError(new Error('No file provided'), { messageElement: errorElement });
    return Promise.reject(new Error('No file provided'));
  }

  clearError(errorElement);

  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file);

    const cleanup = () => {
      video.removeEventListener('loadeddata', onLoaded);
      video.removeEventListener('error', onError);
      URL.revokeObjectURL(objectUrl);
    };

    const onLoaded = () => {
      cleanup();
      resolve();
    };

    const onError = (e) => {
      cleanup();
      const msg = video.error?.message || 'Failed to load video file.';
      handleError(new Error(msg), {
        messageElement: errorElement,
        userMessage: 'Could not load the video. The file may be corrupted or in an unsupported format.',
      });
      reject(e);
    };

    video.addEventListener('loadeddata', onLoaded, { once: true });
    video.addEventListener('error', onError, { once: true });

    video.src = objectUrl;
    video.load();
  });
}

/**
 * Loads a video from a URL into the video element.
 * @param {HTMLVideoElement} video - Video element.
 * @param {string} url - Video URL.
 * @param {HTMLElement|null} [errorElement] - Element to show errors.
 * @returns {Promise<void>}
 */
export function loadVideoFromUrl(video, url, errorElement = null) {
  if (!video || !(video instanceof HTMLVideoElement)) {
    handleError(new Error('Invalid video element'), { messageElement: errorElement });
    return Promise.reject(new Error('Invalid video element'));
  }
  if (!url || typeof url !== 'string') {
    handleError(new Error('No URL provided'), { messageElement: errorElement });
    return Promise.reject(new Error('No URL provided'));
  }

  clearError(errorElement);

  return new Promise((resolve, reject) => {
    const onLoaded = () => {
      video.removeEventListener('loadeddata', onLoaded);
      video.removeEventListener('error', onError);
      resolve();
    };

    const onError = () => {
      video.removeEventListener('loadeddata', onLoaded);
      video.removeEventListener('error', onError);
      handleError(new Error(video.error?.message || 'Video load failed'), {
        messageElement: errorElement,
        userMessage: 'Could not load the video. Check the URL and that the server allows playback (CORS).',
      });
      reject(new Error('Video load failed'));
    };

    video.addEventListener('loadeddata', onLoaded, { once: true });
    video.addEventListener('error', onError, { once: true });

    video.crossOrigin = 'anonymous';
    video.src = url;
    video.load();
  });
}
