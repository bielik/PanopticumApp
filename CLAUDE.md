# PANOPTICUM — Developer Guide

Interactive surveillance art installation. Camera → AI vision (Gemini) → TTS narration → browser playback.

## Architecture Overview

Two deployment modes share the same frontend (`static/app.js`, `static/style.css`):

- **Local standalone** (`python main.py`): OpenCV camera → threaded pipeline → local speakers
- **HuggingFace Spaces** (`server.py` via Docker): Browser `getUserMedia` → async pipeline → MP3 streaming to worker browser

### Key Data Flow (HF Spaces)

```
Browser (Controller)          server.py                   Browser (Worker)
  POST /api/frame ──────────→ Room.latest_frame_jpeg ────→ GET /stream (MJPEG)
  (base64 JPEG, 4fps)         │
                               ├─ Gemini vision ──→ Room.latest_description
                               │                    Room.description_timestamp
                               │
                               ├─ edge-tts ────────→ Room.audio_files[ts] = mp3_bytes
                               │
                               └─ SSE /events ─────→ "description" {text, timestamp, tone}
                                                      "audio" {url: /audio/{timestamp}}
                                                      "audio_robotic" {url}
```

Timestamps (Unix floats from `time.time()`) are the correlation key between description events and audio URLs. The audio URL pattern is `/room/{code}/audio/{timestamp}`.

## File Structure

| File | Purpose |
|------|---------|
| `server.py` | FastAPI web server, room-scoped routes, async analysis loop, SSE, MJPEG relay, audio serving |
| `main.py` | Local standalone entry point — camera, analysis, TTS threads + web server |
| `rooms.py` | Room + Client dataclasses, registration, heartbeat, cleanup |
| `vision.py` | `GeminiVision` — Gemini API wrapper with unified describe_and_narrate + history |
| `tts.py` | `generate_speech()` / `generate_robotic_speech()` — edge-tts async MP3 generation |
| `tone.py` | Tone system (0.0 supportive → 0.5 neutral → 1.0 judgmental), builds prompt preambles |
| `effects.py` | OpenCV video effects (CCTV grayscale, Insta sepia) — local mode only |
| `narrator.py` | Ollama narrator pipeline with keyword-based change detection — local fallback only |
| `overlay.py` | OpenCV text overlay (timestamp, REC dot, description) — local mode only |
| `static/app.js` | Single JS file for both controller and worker pages |
| `static/style.css` | All styling — corporate surveillance aesthetic |
| `templates/lobby.html` | Room join/create page with inline JS |
| `templates/control.html` | Controller page (camera + controls + client panel + activity log) |
| `templates/worker.html` | Worker page (fullscreen, audio playback, no controls) |
| `prompts/gemini_surveillance.txt` | Gemini unified prompt (vision + narration + judgment) |
| `config.yaml` | All configuration (camera, vision, TTS, timing, effects, tone) |

## Conventions

### Frontend (`static/app.js`)
- ES5-compatible IIFE — no modules, no build step, no transpilation
- All variables declared with `var` (not `let`/`const`)
- No arrow functions — use `function(x) {}` syntax
- Single file serves both controller and worker modes, branching on `window.PAGE_MODE`
- SSE via `EventSource` for real-time state sync
- Client identity via `crypto.randomUUID()` in `sessionStorage`

### Audio Playback (Worker)
- **"Latest wins" strategy** — no FIFO queue. Only one pending audio item at a time.
- When new audio arrives while something is playing: replaces pending, does not interrupt current playback
- When nothing is playing: plays immediately
- Lyrics audio (`playRoboticAudio`) is best-effort — skipped entirely if narration is playing or pending
- Activity log entries track `played` boolean; skipped entries get `.skipped` CSS class (dimmed + skip icon)

### Backend
- `server.py` uses FastAPI with Jinja2 templates, SSE via raw `StreamingResponse`
- Per-room state lives in `Room` dataclass (`rooms.py`), stored in global `rooms` dict
- Analysis runs as `asyncio.create_task` per room, Gemini call runs in thread pool executor
- Audio files cached in `room.audio_files` dict (timestamp → mp3 bytes), auto-cleaned after 2 minutes
- Client management: register/heartbeat/unregister with 15s stale timeout
- Only the designated source client's frame uploads are accepted (403 for others)

### CSS (`static/style.css`)
- Three font families: Inter (UI), DM Serif Display (motivational text), Share Tech Mono (CCTV overlays)
- Mobile responsive with breakpoints at 1200px, 1000px, 850px
- Worker mode (`body.worker-mode`) hides all controls, fullscreen video, hidden cursor
- Tone tags: `.tone-supportive` (blue), `.tone-neutral` (gray), `.tone-judgmental` (red)
- Skipped log entries: `.message-log-item.skipped` — dimmed text + skip icon after timestamp

## Important Patterns

### SSE Event Types
| Event | Payload | Emitted when |
|-------|---------|-------------|
| `active` | `{active: bool}` | Pipeline started/stopped |
| `description` | `{text, timestamp, tone}` | New AI observation (not NO_CHANGE) |
| `effect` | `{effect: str}` | Effect changed |
| `tone` | `{value: float}` | Tone changed |
| `lyrics` | `{text: str}` | Fitter Happier line (every 4th cycle, judgmental mode) |
| `audio` | `{url: str}` | Narration MP3 ready |
| `audio_robotic` | `{url: str}` | Robotic lyrics MP3 ready |
| `clients` | `{clients: [...], active_source: str}` | Client join/leave/source switch |

### Gemini Unified Mode
`GeminiVision.describe_and_narrate()` handles everything in one API call:
- First call: introduction mode (8-15 word scene description)
- Subsequent calls: change detection (returns `NO_CHANGE` or 3-8 word update)
- Stale timeout: forces description if silent for 10+ seconds
- History: last 10 observations stored for context
- Tone preamble prepended to prompt based on slider value

### Multi-Client System
- Clients register with UUID, role (controller/worker), and label
- First controller auto-becomes video source
- Source can be switched via "Connected Devices" panel
- Heartbeat every 10s, stale cleanup every 5s (15s timeout)
- `_clients_version` counter triggers SSE `clients` events

## Dev Setup

```bash
python -m venv venv
venv\Scripts\activate        # Windows
pip install -r requirements.txt

# For local mode (OpenCV):
pip install opencv-python numpy

# Set API key:
echo GEMINI_API_KEY=your_key > .env

# Run:
python main.py               # Local standalone
uvicorn server:app --port 7860  # HF Spaces mode
```

## Deployment (HuggingFace Spaces)

**After every commit, always push to the `hf` remote so the user can test changes live:**

```bash
git push hf feature/hf-spaces:main
```

Required secrets in HF Space settings:
- `GEMINI_API_KEY`
- `ADMIN_PASSWORD`

Docker container runs `uvicorn server:app --host 0.0.0.0 --port 7860`.
