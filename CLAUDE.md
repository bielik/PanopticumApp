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
                                                      "action_phase" {setting, phase, action}
```

Timestamps (Unix floats from `time.time()`) are the correlation key between description events and audio URLs. The audio URL pattern is `/room/{code}/audio/{timestamp}`.

## File Structure

| File | Purpose |
|------|---------|
| `server.py` | FastAPI web server, room-scoped routes, async analysis loop, SSE, MJPEG relay, audio serving |
| `main.py` | Local standalone entry point — camera, analysis, TTS threads + web server |
| `rooms.py` | Room + Client dataclasses, registration, heartbeat, cleanup |
| `vision.py` | `GeminiVision` — Gemini API wrapper with unified describe_and_narrate + action mode methods |
| `tts.py` | `generate_speech()` / `generate_robotic_speech()` — edge-tts async MP3 generation |
| `tone.py` | Tone system (0.0 supportive → 0.5 neutral → 1.0 judgmental), builds prompt preambles |
| `effects.py` | OpenCV video effects (CCTV grayscale, Insta sepia) — local mode only |
| `narrator.py` | Ollama narrator pipeline with keyword-based change detection — local fallback only |
| `overlay.py` | OpenCV text overlay (timestamp, REC dot, description) — local mode only |
| `static/app.js` | Single JS file for both controller and worker pages |
| `static/style.css` | All styling — corporate surveillance aesthetic |
| `static/jquery.ripples.js` | WebGL water ripple effect plugin (MIT, requires jQuery) |
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
- **Tone switch**: current audio finishes naturally, pending old-tone audio is dropped. Log entries retain their original tone label via `description_tone` stored at generation time.

### Backend
- `server.py` uses FastAPI with Jinja2 templates, SSE via raw `StreamingResponse`
- Per-room state lives in `Room` dataclass (`rooms.py`), stored in global `rooms` dict
- Analysis runs as `asyncio.create_task` per room, Gemini call runs in thread pool executor
- Audio files cached in `room.audio_files` dict (timestamp → mp3 bytes), auto-cleaned after 2 minutes
- Client management: register/heartbeat/unregister with 15s stale timeout
- Only the designated source client's frame uploads are accepted (403 for others)

### CSS (`static/style.css`)

#### Visual Design — Lumon Industries (Severance)

**Aesthetic**: Retro-corporate CRT terminal. Inspired by the Macrodata Refinement desktop UI from Severance. Think early computer graphics — simple lines, thin outlined boxes, subtle phosphor glow effects. Sterile, clinical, eerily calm. Nothing looks "modern web" — it looks like a 1980s corporate mainframe terminal rendered in a browser.

**Reference images** in `References/` folder: Lumon UI.jpg (MDR number grid), Lumon UI_2.jpg (blue glow variant), Lumon Logo.jpg (CRT idle screen), Lumon Corporate Identity*.jpg, Color scheme 2.jpg.

#### Color Scheme

Define as CSS custom properties on `:root`. Use these tokens everywhere — no hardcoded hex values.

| Token | Hex | Usage |
|-------|-----|-------|
| `--lumon-dark` | `#161E26` | Page backgrounds, dark surfaces, video container bg |
| `--lumon-green-deep` | `#213525` | Secondary accent — borders, hover states, panel backgrounds |
| `--lumon-green` | `#8DB07A` | Primary interactive — active buttons, slider thumbs, progress bars, active indicators |
| `--lumon-light` | `#E4E7E5` | Text on dark backgrounds, panel surfaces in light mode, card fills |
| `--lumon-glow` | `rgba(141, 176, 122, 0.4)` | Glow/box-shadow color for green elements (sage green at 40% opacity) |

#### Typography
- **Single typeface**: Inter (Google Fonts) for everything — UI, labels, overlays, headings
- No serif fonts, no monospace (except raw data displays if needed)
- **Labels**: uppercase, weight 600, letter-spacing 2px, small size (~0.65rem)
- **Body text**: weight 400-500, normal case
- **Headings/titles**: weight 700, uppercase, wide letter-spacing

#### UI Principles
- **Outlined boxes, not filled cards** — 1px solid borders (`--lumon-green` or `--lumon-green-deep`), transparent or very subtle fill
- **Sharp corners** — no border-radius or minimal (2-4px max). Rectangles, not pills.
- **Glow effects** — active/interactive elements get subtle `box-shadow: 0 0 8px var(--lumon-glow)` and `text-shadow: 0 0 6px var(--lumon-glow)`
- **Dark backgrounds** — controller page uses `--lumon-dark` as body background. Panels are outlined containers, not white cards.
- **Text color**: `--lumon-light` for primary text on dark backgrounds. `--lumon-green` for labels, active states, highlights.
- **Buttons**: outlined style (border only, no fill) in default state. Fill with `--lumon-green-deep` or `--lumon-green` on hover/active. Uppercase text.
- **Sliders/inputs**: thin track in `--lumon-green-deep`, thumb in `--lumon-green` with glow
- **Dividers**: 1px lines in `--lumon-green-deep`

#### Worker Mode
- **Idle screen**: sage green (`#7a9a86`) background with vignette overlay. Content centered vertically: large Inter heading ("Your productivity is our priority."), Share Tech Mono clock + input/button + status text (all `0.85rem`), Panopticum SVG logo at bottom with white glow. Typewriter animation on status text. WebGL water ripple effect via `jquery.ripples.js` (jQuery plugin) — interactive on mouse move, auto-rain when idle. Background color passed as 1x1 canvas data URL since plugin requires an image. Cursor visible on idle screen (overrides `body.worker-mode { cursor: none }`).
- **Active**: fullscreen video, hidden cursor, dark borders

#### Lobby Page
- Dark background (`--lumon-dark`)
- Centered card with thin `--lumon-green` border outline
- Input fields: outlined, not filled
- Submit buttons: `--lumon-green-deep` fill with `--lumon-light` text

- Mobile responsive with breakpoints at 1200px, 1000px, 850px
- Worker mode (`body.worker-mode`) hides all controls, fullscreen video, hidden cursor
- Skipped log entries: `.message-log-item.skipped` — dimmed text + skip icon after timestamp

## Important Patterns

### SSE Event Types
| Event | Payload | Emitted when |
|-------|---------|-------------|
| `active` | `{active: bool}` | Pipeline started/stopped |
| `description` | `{text, timestamp, tone, type}` | New AI observation (not NO_CHANGE). `tone` is the value at generation time (not current). `type`: commentary/action_request/action_completed/action_timeout |
| `effect` | `{effect: str}` | Effect changed |
| `tone` | `{value: float}` | Tone changed |
| `lyrics` | `{text: str}` | Fitter Happier line (every 4th cycle, judgmental mode) |
| `audio` | `{url: str}` | Narration MP3 ready |
| `audio_robotic` | `{url: str}` | Robotic lyrics MP3 ready |
| `clients` | `{clients: [...], active_source: str}` | Client join/leave/source switch |
| `action_phase` | `{setting, phase, action}` | Action mode state changed |

### Gemini Unified Mode
`GeminiVision.describe_and_narrate()` handles everything in one API call:
- First call: introduction mode (8-15 word scene description)
- Subsequent calls: change detection (returns `NO_CHANGE` or 3-8 word update)
- Stale timeout: forces description if silent for 10+ seconds
- Long response guard: if response exceeds 20 words, discards it and retries with blank context (no prior comment)
- Tone preamble prepended to prompt based on slider value

### Multi-Client System
- Clients register with UUID, role (controller/worker), and label
- First controller auto-becomes video source
- Source can be switched via "Connected Devices" panel
- Heartbeat every 10s, stale cleanup every 5s (15s timeout)
- `_clients_version` counter triggers SSE `clients` events

### Action Mode
AI issues physical directives and verifies compliance via the camera.

**State machine:**
```
  COMMENTING ──(auto: 60s elapsed, OR manual button)──→ ACTION_REQUESTING
       ↑                                                       │
       │                                     (Gemini generates action, TTS speaks it)
       │                                                       ↓
       └──(COMPLETED or 30s timeout)────────── ACTION_VERIFYING
              each 3s cycle: Gemini checks if action was performed
```

**Room fields:** `action_setting` ("manual"/"automatic"), `action_phase` ("commenting"/"action_requesting"/"action_verifying"), `action_requested`, `action_request_time`, `action_last_comment_time`, `_action_phase_version`, `description_type` (commentary/action_request/action_completed/action_timeout), `description_tone` (tone_value at generation time)

**GeminiVision methods:**
- `generate_action_request(jpeg, tone_preamble)` → 3-10 word command contrasting current posture
- `verify_action(jpeg, action_text)` → bool (substring check for "COMPLETED")
- `generate_action_response(jpeg, action_text, completed, tone_preamble)` → 5-12 word spoken response; non-compliance is always neutral regardless of tone

**API endpoints:**
- `POST /room/{code}/api/action-setting` — body: `{setting: "automatic"|"manual"}`
- `POST /room/{code}/api/trigger-action` — empty body, returns 400 if action in progress or pipeline inactive

**Analysis loop phases:** The loop branches on `room.action_phase`. Commenting phase runs existing `describe_and_narrate`. Requesting phase generates action + TTS then transitions to verifying. Verifying phase polls `verify_action` each cycle; on completion or 30s timeout, generates response + TTS and transitions back to commenting.

**Frontend:** Action panel in controls bar with Manual/Automatic pills, phase badge (gray=commenting, amber=requesting/verifying), action text display, and "Request Action" trigger button (disabled during action).

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

**CRITICAL: After every commit, always deploy to HuggingFace by pushing to `hf main`:**

```bash
git push hf feature/hf-spaces:main
```

`git push` alone only pushes to the tracking branch `hf/feature/hf-spaces`, which does NOT trigger a deploy. HF Spaces only deploys from `main`. Always use the command above.

Required secrets in HF Space settings:
- `GEMINI_API_KEY`
- `ADMIN_PASSWORD`

Docker container runs `uvicorn server:app --host 0.0.0.0 --port 7860`.
