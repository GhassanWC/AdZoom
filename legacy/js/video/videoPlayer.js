/**
 * Video player using HTML5 Video API: play/pause, seek, volume, events.
 * @module video/videoPlayer
 */

import { handleError } from '../utils/errorHandler.js';

/**
 * Creates and wires the video player controls.
 * @param {Object} elements - DOM elements.
 * @param {HTMLVideoElement} elements.video
 * @param {HTMLButtonElement} [elements.playPauseBtn]
 * @param {HTMLInputElement} [elements.seekBar]
 * @param {HTMLElement} [elements.timeDisplay]
 * @param {HTMLButtonElement} [elements.muteBtn]
 * @param {HTMLInputElement} [elements.volumeSlider]
 * @param {HTMLElement} [elements.controls]
 * @param {HTMLElement} [elements.placeholder]
 * @param {HTMLElement} [elements.playerError]
 */
export function initVideoPlayer(elements) {
  const {
    video,
    playPauseBtn,
    seekBar,
    timeDisplay,
    muteBtn,
    volumeSlider,
    controls,
    placeholder,
    playerError,
  } = elements;

  if (!video || !(video instanceof HTMLVideoElement)) return;

  // Play / Pause
  if (playPauseBtn) {
    playPauseBtn.addEventListener('click', () => togglePlayPause(video, playPauseBtn));
  }

  // Seek
  if (seekBar) {
    seekBar.addEventListener('input', () => {
      if (video.duration && !isNaN(video.duration)) {
        video.currentTime = (seekBar.value / 100) * video.duration;
      }
    });
  }

  video.addEventListener('timeupdate', () => updateSeekBar(video, seekBar, timeDisplay));
  video.addEventListener('durationchange', () => updateSeekBar(video, seekBar, timeDisplay));

  if (seekBar) {
    seekBar.addEventListener('change', () => {
      if (video.duration && !isNaN(video.duration)) {
        video.currentTime = (seekBar.value / 100) * video.duration;
      }
    });
  }

  // Volume
  if (muteBtn) {
    muteBtn.addEventListener('click', () => toggleMute(video, muteBtn, volumeSlider));
  }
  if (volumeSlider) {
    volumeSlider.addEventListener('input', () => {
      video.volume = volumeSlider.value / 100;
      video.muted = false;
      updateMuteButton(video, muteBtn);
    });
  }

  // Events: update UI on play, pause, ended
  video.addEventListener('play', () => updatePlayPauseButton(video, playPauseBtn));
  video.addEventListener('pause', () => updatePlayPauseButton(video, playPauseBtn));
  video.addEventListener('ended', () => {
    updatePlayPauseButton(video, playPauseBtn);
    if (seekBar) seekBar.value = 0;
    if (timeDisplay) timeDisplay.textContent = formatTime(0) + ' / ' + formatTime(video.duration || 0);
  });

  video.addEventListener('loadeddata', () => {
    showControls(controls, placeholder);
    updatePlayPauseButton(video, playPauseBtn);
    updateSeekBar(video, seekBar, timeDisplay);
  });

  video.addEventListener('error', () => {
    if (playerError) {
      playerError.textContent = 'Video failed to load. Check the file or URL.';
      playerError.removeAttribute('hidden');
    }
  });
}

/**
 * Toggle play/pause and update button.
 * @param {HTMLVideoElement} video
 * @param {HTMLButtonElement} [btn]
 */
function togglePlayPause(video, btn) {
  try {
    if (video.paused) {
      video.play().catch((err) => handleError(err, { userMessage: 'Playback failed.' }));
    } else {
      video.pause();
    }
    updatePlayPauseButton(video, btn);
  } catch (err) {
    handleError(err);
  }
}

/**
 * @param {HTMLVideoElement} video
 * @param {HTMLButtonElement} [btn]
 */
function updatePlayPauseButton(video, btn) {
  if (!btn) return;
  const isPaused = video.paused;
  // .paused on button = show pause icon (two bars); no .paused = show play icon (triangle)
  btn.classList.toggle('paused', !isPaused);
  btn.setAttribute('aria-label', isPaused ? 'Play' : 'Pause');
  btn.title = isPaused ? 'Play' : 'Pause';
}

/**
 * @param {HTMLVideoElement} video
 * @param {HTMLInputElement} [seekBar]
 * @param {HTMLElement} [timeDisplay]
 */
function updateSeekBar(video, seekBar, timeDisplay) {
  const duration = video.duration;
  const current = video.currentTime;

  if (seekBar && duration && !isNaN(duration)) {
    seekBar.value = (current / duration) * 100;
  }
  if (timeDisplay) {
    timeDisplay.textContent = formatTime(current) + ' / ' + formatTime(duration || 0);
  }
}

/**
 * @param {number} seconds
 * @returns {string}
 */
function formatTime(seconds) {
  if (!isFinite(seconds) || isNaN(seconds)) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/**
 * @param {HTMLVideoElement} video
 * @param {HTMLButtonElement} [muteBtn]
 * @param {HTMLInputElement} [volumeSlider]
 */
function toggleMute(video, muteBtn, volumeSlider) {
  video.muted = !video.muted;
  updateMuteButton(video, muteBtn);
  if (volumeSlider) {
    if (video.muted) {
      volumeSlider.dataset.preMute = volumeSlider.value;
      volumeSlider.value = 0;
    } else {
      volumeSlider.value = volumeSlider.dataset.preMute || 100;
      video.volume = volumeSlider.value / 100;
    }
  }
}

/**
 * @param {HTMLVideoElement} video
 * @param {HTMLButtonElement} [muteBtn]
 */
function updateMuteButton(video, muteBtn) {
  if (!muteBtn) return;
  muteBtn.classList.toggle('muted', video.muted);
  muteBtn.setAttribute('aria-label', video.muted ? 'Unmute' : 'Mute');
  muteBtn.title = video.muted ? 'Unmute' : 'Mute';
}

/**
 * @param {HTMLElement} [controls]
 * @param {HTMLElement} [placeholder]
 */
function showControls(controls, placeholder) {
  if (controls) {
    controls.hidden = false;
  }
  if (placeholder) {
    placeholder.classList.add('hidden');
  }
}
