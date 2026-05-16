# AdZoom

A web application that adds dynamic zoom effects to screen recordings. Upload a video file or paste a video URL, then control zoom level, speed, and origin with the on-screen controls.

## Features

- **Video source**: Upload a file (MP4, MOV, WebM, AVI, MKV, max 500 MB) or enter a video URL (HTTP/HTTPS).
- **Validation**: Client-side checks for file type/size and URL format.
- **Video player**: Play/pause, seek bar, time display, volume slider, mute.
- **Zoom effect**: CSS-based zoom with adjustable level (100–300%), transition speed (0–3 s), and origin (center, corners, edges).
- **Responsive**: Layout and touch-friendly controls for mobile and desktop.
- **Error handling**: User-friendly messages for load and zoom failures.

## Quick start

1. Open the project folder and serve it over HTTP (required for video and modules):
   ```bash
   npx serve .
   # or: python -m http.server 8080
   ```
2. Open the URL in a browser (e.g. http://localhost:3000).
3. Choose **Upload file** or **Video URL**, then load a video.
4. Use the zoom sliders and origin dropdown to apply the effect.

## Project structure

```
AdZoom/
├── index.html          # Entry page
├── css/
│   └── styles.css      # Layout and components
├── js/
│   ├── main.js         # App entry, wiring
│   ├── state/
│   │   └── appState.js # Zoom state
│   ├── ui/
│   │   └── components.js # Tabs, file/URL inputs, zoom UI
│   ├── video/
│   │   ├── videoLoader.js  # Load from file/URL
│   │   └── videoPlayer.js  # Playback controls and events
│   ├── zoom/
│   │   └── zoomEffect.js   # CSS zoom application
│   └── utils/
│       ├── errorHandler.js # Generic error handling
│       └── validators.js   # File and URL validation
└── README.md
```

## Browser support

Modern browsers with ES modules and HTML5 video (Chrome, Firefox, Safari, Edge). For cross-origin video URLs, the server must send appropriate CORS headers.
