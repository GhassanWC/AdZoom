/**
 * AdZoom - Entry point. Wires video source, player, and zoom effect.
 * @module main
 */

import { initSourceTabs, initFileInput, initUrlInput, initZoomControls } from './ui/components.js';
import { loadVideoFromFile, loadVideoFromUrl } from './video/videoLoader.js';
import { initVideoPlayer } from './video/videoPlayer.js';
import { clearError } from './utils/errorHandler.js';

const video = /** @type {HTMLVideoElement} */ (document.getElementById('video'));
const videoWrapper = document.getElementById('video-wrapper');
const playerError = document.getElementById('player-error');
const placeholder = document.getElementById('placeholder-message');
const fileError = document.getElementById('file-error');
const urlError = document.getElementById('url-error');
const zoomError = document.getElementById('zoom-error');

// Source tabs
const tabUpload = document.querySelector('[data-tab="upload"]');
const tabUrl = document.querySelector('[data-tab="url"]');
const panelUpload = document.getElementById('panel-upload');
const panelUrl = document.getElementById('panel-url');

const tabs = [tabUpload, tabUrl].filter(Boolean);
const panels = [panelUpload, panelUrl].filter(Boolean);

initSourceTabs({ tabs, panels });

function showVideoReady() {
  if (placeholder) placeholder.classList.add('hidden');
  clearError(playerError);
}

function loadFile(file) {
  loadVideoFromFile(video, file, playerError).then(showVideoReady).catch(() => {});
}

function loadUrl(url) {
  loadVideoFromUrl(video, url, playerError).then(showVideoReady).catch(() => {});
}

initFileInput(
  {
    fileInput: document.getElementById('video-file'),
    fileNameDisplay: document.getElementById('file-name'),
    errorElement: fileError,
  },
  loadFile
);

initUrlInput(
  {
    urlInput: document.getElementById('video-url'),
    loadBtn: document.getElementById('load-url-btn'),
    errorElement: urlError,
  },
  loadUrl
);

initVideoPlayer({
  video,
  playPauseBtn: document.getElementById('play-pause-btn'),
  seekBar: document.getElementById('seek-bar'),
  timeDisplay: document.getElementById('time-display'),
  muteBtn: document.getElementById('mute-btn'),
  volumeSlider: document.getElementById('volume-slider'),
  controls: document.getElementById('video-controls'),
  placeholder,
  playerError,
});

initZoomControls({
  zoomLevel: document.getElementById('zoom-level'),
  zoomSpeed: document.getElementById('zoom-speed'),
  zoomOrigin: document.getElementById('zoom-origin'),
  zoomLevelValue: document.getElementById('zoom-level-value'),
  zoomSpeedValue: document.getElementById('zoom-speed-value'),
  videoWrapper: videoWrapper,
  zoomError,
});
