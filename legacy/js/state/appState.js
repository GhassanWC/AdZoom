/**
 * Application state for zoom parameters and video source.
 * @module state/appState
 */

/** @typedef {'center'|'top'|'bottom'|'left'|'right'|'top-left'|'top-right'|'bottom-left'|'bottom-right'} ZoomOrigin */

/**
 * @typedef {Object} ZoomState
 * @property {number} level - Zoom level as percentage (100 = no zoom).
 * @property {number} speed - Transition duration in seconds.
 * @property {ZoomOrigin} origin - Transform origin for zoom.
 */

const DEFAULT_ZOOM = {
  level: 100,
  speed: 0.5,
  origin: 'center',
};

/** @type {ZoomState} */
let zoomState = { ...DEFAULT_ZOOM };

/** @type {(() => void)[]} */
const listeners = [];

/**
 * Get current zoom state (copy).
 * @returns {ZoomState}
 */
export function getZoomState() {
  return { ...zoomState };
}

/**
 * Set zoom level (percentage). Clamped to 100–300.
 * @param {number} level
 */
export function setZoomLevel(level) {
  const value = Math.max(100, Math.min(300, Number(level)));
  if (zoomState.level !== value) {
    zoomState.level = value;
    notify();
  }
}

/**
 * Set zoom transition duration in seconds. Clamped to 0–3.
 * @param {number} speed
 */
export function setZoomSpeed(speed) {
  const value = Math.max(0, Math.min(3, Number(speed)));
  if (zoomState.speed !== value) {
    zoomState.speed = value;
    notify();
  }
}

/**
 * Set zoom origin.
 * @param {ZoomOrigin} origin
 */
export function setZoomOrigin(origin) {
  const allowed = [
    'center', 'top', 'bottom', 'left', 'right',
    'top-left', 'top-right', 'bottom-left', 'bottom-right',
  ];
  const value = allowed.includes(origin) ? origin : 'center';
  if (zoomState.origin !== value) {
    zoomState.origin = value;
    notify();
  }
}

/**
 * Subscribe to zoom state changes.
 * @param {() => void} callback
 * @returns {() => void} Unsubscribe function.
 */
export function subscribeZoom(callback) {
  listeners.push(callback);
  return () => {
    const i = listeners.indexOf(callback);
    if (i !== -1) listeners.splice(i, 1);
  };
}

function notify() {
  listeners.forEach((cb) => cb());
}

/**
 * Reset zoom state to defaults.
 */
export function resetZoomState() {
  zoomState = { ...DEFAULT_ZOOM };
  notify();
}
