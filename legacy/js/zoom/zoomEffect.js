/**
 * Zoom effect using CSS transform and transform-origin.
 * @module zoom/zoomEffect
 */

import { getZoomState } from '../state/appState.js';
import { handleError } from '../utils/errorHandler.js';

/** Map state origin to CSS transform-origin value */
const ORIGIN_MAP = {
  center: 'center center',
  top: 'center top',
  bottom: 'center bottom',
  left: 'left center',
  right: 'right center',
  'top-left': 'left top',
  'top-right': 'right top',
  'bottom-left': 'left bottom',
  'bottom-right': 'right bottom',
};

const MIN_LEVEL = 100;
const MAX_LEVEL = 300;
const MIN_SPEED = 0;
const MAX_SPEED = 3;

/**
 * Applies current zoom state to the video wrapper element.
 * @param {HTMLElement} wrapper - Element wrapping the video (e.g. .video-wrapper).
 * @param {HTMLElement|null} [errorElement] - Element to show zoom errors.
 */
export function applyZoomEffect(wrapper, errorElement = null) {
  if (!wrapper || !(wrapper instanceof HTMLElement)) {
    handleError(new Error('Invalid wrapper element'), {
      messageElement: errorElement,
      userMessage: 'Zoom could not be applied.',
    });
    return;
  }

  try {
    const state = getZoomState();
    const level = Math.max(MIN_LEVEL, Math.min(MAX_LEVEL, state.level));
    const speed = Math.max(MIN_SPEED, Math.min(MAX_SPEED, state.speed));
    const originCss = ORIGIN_MAP[state.origin] || ORIGIN_MAP.center;

    const scale = level / 100;
    wrapper.style.transformOrigin = originCss;
    wrapper.style.transition = `transform ${speed}s ease`;
    wrapper.style.transform = `scale(${scale})`;
    wrapper.classList.add('video-wrapper--zoomed');
  } catch (err) {
    handleError(err, {
      messageElement: errorElement,
      userMessage: 'Failed to apply zoom effect. Try adjusting the zoom level.',
    });
  }
}

/**
 * Subscribes to zoom state changes and reapplies zoom to the wrapper.
 * @param {HTMLElement} wrapper
 * @param {HTMLElement|null} [errorElement]
 * @param {() => void} [onStateChange] - Called when state changes (e.g. from subscribeZoom).
 */
export function subscribeZoomEffect(wrapper, errorElement, onStateChange) {
  if (!wrapper) return;
  const apply = () => {
    applyZoomEffect(wrapper, errorElement);
    onStateChange?.();
  };
  return apply;
}
