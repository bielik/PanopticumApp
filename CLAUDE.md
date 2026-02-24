# PANOPTICUM — Developer Guide

Interactive surveillance art installation. Camera → AI vision (Gemini) → TTS narration → browser playback.

## Architecture Overview

Two deployment modes share the same frontend (`static/app.js`, `static/style.css`):

- **Local standalone** (`python main.py`): OpenCV camera → threaded pipeline → local speakers
- **HuggingFace Spaces** (`server.py` via Docker): Browser `getUserMedia` → async pipeline → MP3 streaming to worker browser

### Key Data Flow (HF Spaces)

```
Browser (Worker)              server.py                   Browser (Controller)
  getUserMedia ──→ canvas                                   GET /stream/snapshot
  POST /api/frame ──────────→ Room.latest_frame_jpeg ────→  (polled every 500ms)
  (base64 JPEG, 640px, 4fps)  │                             ↓
                               │                         Canvas: pixelate + posterize
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

**Video source is always the worker.** The controller never captures video. Only one worker per room (second worker gets 409 `room_occupied`). Worker camera starts when panopticum is activated via SSE `active` event.

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
| `templates/control.html` | Controller page (video preview + controls + client panel + activity log) |
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

### Video Pipeline
- **Worker-only source**: Only the worker browser captures video via `getUserMedia`. Controller never uses the camera.
- **One worker per room**: `register_client()` returns `None` if a worker already exists; server returns 409 `room_occupied`. Rejected workers see "This workstation is occupied" idle screen.
- **Frame downscaling**: Worker downscales frames to max 640px width before JPEG encoding and upload (saves bandwidth; Gemini receives the full 640px image).
- **Snapshot polling**: Controller polls `GET /room/{code}/stream/snapshot` every 500ms (replacing unreliable MJPEG `<img>` streaming). Uses `new Image()` preloading to avoid flicker.
- **Pixelation + posterize**: Controller renders video in a `<canvas>` element. Frames are downscaled to 80x80 (center-cropped to square), grayscale + posterized to 8 levels, then upscaled with `imageSmoothingEnabled = false` for a chunky pixel art look.
- **Hidden video element**: Worker's `<video>` uses `position:fixed; top:-9999px` instead of `display:none` — Chrome suspends frame decoding for `display:none` elements, causing blank canvas captures.

### Backend
- `server.py` uses FastAPI with Jinja2 templates, SSE via raw `StreamingResponse`
- Per-room state lives in `Room` dataclass (`rooms.py`), stored in global `rooms` dict
- Analysis runs as `asyncio.create_task` per room, Gemini call runs in thread pool executor
- Audio files cached in `room.audio_files` dict (timestamp → mp3 bytes), auto-cleaned after 2 minutes
- Client management: register/heartbeat/unregister with 15s stale timeout
- Only the worker (designated source) client's frame uploads are accepted (403 for others)

### CSS (`static/style.css`)

See **[`UI-GUIDE.md`](UI-GUIDE.md)** for the comprehensive visual design system (colors, typography, components, page templates).

Key points:
- All colors defined as CSS custom properties on `:root` — no hardcoded hex
- Two typefaces: Inter (headings, weight 700) + Share Tech Mono (everything else)
- Max 2 font sizes per page: one Display heading + 0.85rem body
- Background: `--lumon-sage` (`#7a9a86`) for public pages, `--lumon-dark` for controller
- Accent: `--lumon-green-deep` (`#213525`) for interactive elements on light backgrounds
- Custom circle cursor (`--lumon-dark`) on idle/lobby screens
- Vignette overlay on sage backgrounds
- WebGL ripple effect on worker idle screen (`jquery.ripples.js` + jQuery)
- Video overlay effects (CCTV neon green, Insta sepia) are artistic exceptions to the color rules

**Reference images** in `References/` folder.

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
| `work` | `{active: bool}` | Work mode started/stopped |
| `work_score` | `{unfrozen, total, cols, rows, tiles}` | Work score updated (tiles: base64 Uint8Array) |
| `freeze_time` | `{value: float}` | Freeze time setting changed |

### Gemini Unified Mode
`GeminiVision.describe_and_narrate()` handles everything in one API call:
- First call: introduction mode (8-15 word scene description)
- Subsequent calls: change detection (returns `NO_CHANGE` or 3-8 word update)
- Stale timeout: forces description if silent for 10+ seconds
- Long response guard: if response exceeds 20 words, discards it and retries with blank context (no prior comment)
- Tone preamble prepended to prompt based on slider value
- **Work session awareness:** During active work mode, the analysis loop passes a `work_context` string describing the frost game state (score %, trajectory). Injected via `{work_state}` placeholder in `prompts/gemini_surveillance.txt`. Gemini naturally incorporates score into commentary — tone system still applies (supportive praises, judgmental criticizes). Trajectory tracked via `room.work_score_prev_pct` with 3% deadband to avoid jitter.

### Multi-Client System
- Clients register with UUID, role (controller/worker), and label
- Worker auto-becomes video source on registration; only one worker per room
- Controller shows connected devices list (no source switching — worker is always source)
- Heartbeat every 10s, stale cleanup every 5s (15s timeout)
- `_clients_version` counter triggers SSE `clients` events
- When worker disconnects, source is cleared (controller circle goes white)
- **Worker registration gate:** Workers connect with a generic label initially ("Worker (Win32)"). Device list shows "Worker (not registered)" until the employee enters their ID. Start Panopticum button is `disabled` until a worker registers with a name. Device list shows "Worker (Name)" after registration. `_workerRegistered` flag tracks this state.

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

### Work Mode (Frost Game)
Pipeline activation and work mode are **two independent concerns** on the worker screen:

- **Pipeline (`active`)** controls the **worker active screen**: circle, ripples, commentary text. Managed by `updateWorkerIdleState()`.
- **Work mode (`work_active`)** controls only the **frost tile game**. Managed by `updateFrostGameState()`.

**Lifecycle:**
1. START PANOPTICUM → worker shows active screen (circle, ripples, commentary). No frost tiles.
2. START WORK → frost tiles appear on the active screen, timer starts.
3. STOP WORK → frost tiles disappear, active screen remains visible.
4. STOP PANOPTICUM → worker returns to idle. Work mode cascade-stops (server sets `work_active=false`).

**Key rules:**
- Work mode **cannot start** unless pipeline is active (server returns 400).
- Pipeline stop **cascade-stops** work mode (server-side), but pipeline start does **not** auto-start work.
- `updateWorkerIdleState(false)` also calls `destroyFrostGame()` as a safety net (cascade cleanup).

**API:** `POST /room/{code}/api/work` — body: `{active: bool}`. Returns 400 if trying to start while pipeline is inactive.

**Room fields:** `work_active` (bool), `_work_version` (change counter for SSE).

**Frost tile grid** is responsive — tiles are always as close to square as possible:
- `FROST_TARGET_TILE_PX = 80` — target tile size in CSS pixels.
- `frostComputeGrid(width, height)` computes cols/rows from canvas dimensions, rounding both to **even numbers** (min 2).
- On window resize, `frostResizeAndRemap()` recomputes the grid and performs a **nearest-neighbor spatial remap** of tile state (timestamps + frozen flags) from old grid to new grid, preserving the frost pattern.
- Grid dimensions are mutable (`_frostCols`, `_frostRows`), not constants.
- On resize, `frostResizeAndRemap()` also recounts frozen tiles, updates circle text, recalculates game-over state, and forces an immediate score upload to the server.

**Work score propagation** — score and full tile state stream from worker → server → controller:
- Worker uploads score + base64-encoded tile snapshot (Uint8Array, 0=warm/255=frozen) throttled every 2s via `POST /room/{code}/api/work-score`.
- Server stores on Room (`work_score_unfrozen`, `work_score_total`, `work_score_cols`, `work_score_rows`, `work_score_tiles`, `_work_score_version`), emits SSE `work_score` event.
- Score resets to zero when work stops or pipeline cascade-stops.
- **Worker circle** shows percentage (`85%`) instead of commentary during work mode. Commentary descriptions are suppressed from the circle (`!isWorkActive` guard) but still logged.
- **Worker bottom-right label** shows `heat:N%  freeze:Ns` instead of score (score is in the circle).
- **Controller App Status** (Q3) has a "Work Score" section below Connected Devices: fixed 450x450 canvas rendering the frost grid with white outlined cells at varying transparency, plus percentage label. Hidden when work is inactive.

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
python main.py               # Local standalone → http://localhost:8000
uvicorn server:app --port 7860  # HF Spaces mode → http://localhost:7860
```

**Local URLs:**
- **Lobby:** `http://localhost:8000/` (local) or `http://localhost:7860/` (HF mode)
- **HuggingFace Spaces:** https://huggingface.co/spaces/MartinBLK/Panopticum

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
