/**
 * UI components: tabs, file input, URL input, zoom controls.
 * @module ui/components
 */

import { validateVideoFile } from '../utils/validators.js';
import { validateVideoUrl } from '../utils/validators.js';
import { clearError, handleError } from '../utils/errorHandler.js';
import {
  setZoomLevel,
  setZoomSpeed,
  setZoomOrigin,
  subscribeZoom,
  getZoomState,
} from '../state/appState.js';
import { applyZoomEffect } from '../zoom/zoomEffect.js';

/**
 * Switches between Upload and URL tabs and shows the correct panel.
 * @param {Object} opts
 * @param {HTMLElement[]} opts.tabs - Tab buttons.
 * @param {HTMLElement[]} opts.panels - Tab panels.
 */
export function initSourceTabs({ tabs, panels }) {
  if (!tabs?.length || !panels?.length) return;

  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => {
      tabs.forEach((t, i) => {
        t.classList.toggle('source-tab--active', i === index);
        t.setAttribute('aria-selected', i === index ? 'true' : 'false');
      });
      panels.forEach((p, i) => {
        const show = i === index;
        p.classList.toggle('hidden', !show);
        p.setAttribute('aria-hidden', show ? 'false' : 'true');
      });
    });
  });
}

/**
 * Initializes file input: validation and displaying selected file name.
 * @param {Object} opts
 * @param {HTMLInputElement} opts.fileInput
 * @param {HTMLElement} opts.fileNameDisplay
 * @param {HTMLElement|null} opts.errorElement
 * @param {function(File): void} onValidFile - Called when a valid file is selected.
 */
export function initFileInput({ fileInput, fileNameDisplay, errorElement }, onValidFile) {
  if (!fileInput) return;

  fileInput.addEventListener('change', () => {
    clearError(errorElement);
    const file = fileInput.files?.[0];
    if (!file) {
      if (fileNameDisplay) fileNameDisplay.textContent = 'No file selected';
      return;
    }

    const result = validateVideoFile(file);
    if (fileNameDisplay) {
      fileNameDisplay.textContent = result.valid ? file.name : 'No file selected';
    }
    if (!result.valid) {
      handleError(new Error(result.error), {
        messageElement: errorElement,
        userMessage: result.error,
      });
      fileInput.value = '';
      return;
    }
    onValidFile(file);
  });
}

/**
 * Initializes URL input and Load URL button with validation.
 * @param {Object} opts
 * @param {HTMLInputElement} opts.urlInput
 * @param {HTMLButtonElement} opts.loadBtn
 * @param {HTMLElement|null} opts.errorElement
 * @param {function(string): void} onValidUrl - Called with valid URL.
 */
export function initUrlInput({ urlInput, loadBtn, errorElement }, onValidUrl) {
  if (!urlInput) return;

  const submit = () => {
    clearError(errorElement);
    const result = validateVideoUrl(urlInput.value);
    if (!result.valid) {
      handleError(new Error(result.error), {
        messageElement: errorElement,
        userMessage: result.error,
      });
      return;
    }
    onValidUrl(result.url);
  };

  loadBtn?.addEventListener('click', submit);
  urlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submit();
    }
  });
}

/**
 * Initializes zoom controls (level, speed, origin) and syncs with state + applies effect.
 * @param {Object} opts
 * @param {HTMLInputElement} opts.zoomLevel
 * @param {HTMLInputElement} opts.zoomSpeed
 * @param {HTMLSelectElement} opts.zoomOrigin
 * @param {HTMLElement} opts.zoomLevelValue
 * @param {HTMLElement} opts.zoomSpeedValue
 * @param {HTMLElement} opts.videoWrapper
 * @param {HTMLElement|null} opts.zoomError
 */
export function initZoomControls({
  zoomLevel,
  zoomSpeed,
  zoomOrigin,
  zoomLevelValue,
  zoomSpeedValue,
  videoWrapper,
  zoomError,
}) {
  const state = getZoomState();

  if (zoomLevel) {
    zoomLevel.value = state.level;
    zoomLevel.setAttribute('aria-valuetext', `${state.level}%`);
    if (zoomLevelValue) zoomLevelValue.textContent = `${state.level}%`;
    zoomLevel.addEventListener('input', () => {
      const v = Number(zoomLevel.value);
      setZoomLevel(v);
      zoomLevel.setAttribute('aria-valuetext', `${v}%`);
      if (zoomLevelValue) zoomLevelValue.textContent = `${v}%`;
    });
  }

  if (zoomSpeed) {
    zoomSpeed.value = state.speed;
    zoomSpeed.setAttribute('aria-valuetext', `${state.speed}s`);
    if (zoomSpeedValue) zoomSpeedValue.textContent = `${state.speed}s`;
    zoomSpeed.addEventListener('input', () => {
      const v = Number(zoomSpeed.value);
      setZoomSpeed(v);
      zoomSpeed.setAttribute('aria-valuetext', `${v}s`);
      if (zoomSpeedValue) zoomSpeedValue.textContent = `${v}s`;
    });
  }

  if (zoomOrigin) {
    zoomOrigin.value = state.origin;
    zoomOrigin.addEventListener('change', () => {
      setZoomOrigin(zoomOrigin.value);
    });
  }

  const apply = () => applyZoomEffect(videoWrapper, zoomError);
  subscribeZoom(() => {
    apply();
    const s = getZoomState();
    if (zoomLevelValue) zoomLevelValue.textContent = `${s.level}%`;
    if (zoomSpeedValue) zoomSpeedValue.textContent = `${s.speed}s`;
  });
  apply();
}
