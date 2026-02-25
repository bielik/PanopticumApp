---
title: Panopticum
emoji: 👁
colorFrom: indigo
colorTo: gray
sdk: docker
pinned: false
---

# PANOPTICUM

An interactive surveillance art installation.

A camera watches a space. An AI describes what it sees. A voice speaks the description out loud. The cosy becomes clinical. The private becomes observed. The machine judges.

## Two Deployment Modes

PANOPTICUM runs in two distinct modes depending on the context:

| | **Local (standalone)** | **HuggingFace Spaces (multi-room)** |
|---|---|---|
| Entry point | `python main.py` | `server.py` via Docker |
| Camera | USB/built-in via OpenCV | Browser `getUserMedia` on worker |
| TTS output | Local speakers (pyttsx3/edge-tts) | MP3 streamed to worker browser |
| Users | Single operator | Multiple rooms, multiple clients per room |
| Video relay | Direct OpenCV | Worker browser → base64 POST → server → snapshot polling |
| URL | `http://localhost:8000` | [huggingface.co/spaces/MartinBLK/Panopticum](https://huggingface.co/spaces/MartinBLK/Panopticum) |

### Access the App

**Local standalone** (`python main.py`):
- Lobby / Controller: http://localhost:8000/
- Worker: http://localhost:8000/worker

**HuggingFace Spaces mode** (`uvicorn server:app --port 7860`):
- Lobby: http://localhost:7860/
- After creating a room, controller and worker links are shown in the lobby

**Live deployment**: https://huggingface.co/spaces/MartinBLK/Panopticum

---

## Architecture

### Core Pipeline (Both Modes)

```
Camera Frame + Observation History
    |
    v
[Gemini 2.0 Flash]  -->  "Subject slouching again" or NO_CHANGE
    |                      (vision + narration + memory in ONE call)
    v
[edge-tts]  -->  robotic voice (only when not NO_CHANGE)
    |
    v
[Web UI]  <--  snapshot polling + SSE events + REST controls
```

**Primary backend:** Google Gemini API — multimodal vision + text in a single call. Handles scene description, change detection, and narration with a tone-adjustable personality.

**Offline fallback (local mode only):** Ollama (moondream + llama3.2:3b) — local two-model pipeline. Activates automatically if Gemini fails.

### Local Mode Architecture

```
main.py
  ├── Camera Thread ──── OpenCV capture → apply effects → JPEG encode
  ├── Analysis Thread ── Gemini/Ollama vision → narration
  ├── TTS Thread ─────── pyttsx3/edge-tts → local speakers
  └── FastAPI Server ─── SSE + REST
```

Three background threads share state through a `SharedState` dataclass with threading locks. The camera captures raw frames, the analysis thread sends them to Gemini, and the TTS thread speaks the narration through local speakers. The web UI is optional — it mirrors the local display.

### HuggingFace Spaces Architecture

```
Browser (Worker)              server.py                Browser (Controller)
  │                              │                         │
  ├─ getUserMedia ───────────────┤                         │
  │   (camera capture)           │                         │
  │                              │                         │
  ├─ POST /api/frame ───────────→│                         │
  │   (base64 JPEG, 640px, 4fps) │                         │
  │                              ├── Room.latest_frame ───→│ GET /stream/snapshot
  │                              │                         │   (polled every 500ms)
  │                              │                         │   ↓
  │                              │                         │ Canvas: pixelate + posterize
  │                              │                         │   (80×80 grayscale, 8 levels)
  │                              │                         │
  │                              ├── Gemini Vision ───────→│ SSE "description"
  │                              │                         │
  │                              ├── edge-tts ────────────→│ SSE "audio" → /audio/{ts}
  │                              │                         │
  ├─ SSE /events ←──────────────┤                         ├─ SSE /events
  │   (state sync + audio cues)  │                         │   (state sync)
  │                              │                         │
  │ POST /api/work-score ───────→│                         │
  │   (tile state, throttled 2s) │── SSE "work_score" ───→│ Work Score canvas
  │                              │                         │
  └─ Audio playback (MP3)        │                         └─ REST /api/* (controls)
```

**Video source is always the worker.** The controller never captures video. Only one worker per room — a second worker gets `409 room_occupied`. The worker's camera starts when the panopticum is activated.

The browser captures the camera via `getUserMedia`, downscales frames to max 640px, encodes JPEG on a `<canvas>`, and POSTs base64 frames to the server. The server stores frames in memory, runs Gemini analysis in an async background task, generates MP3 audio via edge-tts, and serves everything through snapshot polling, SSE events, and REST endpoints.

The controller polls snapshot images every 500ms, renders them in a `<canvas>` with pixelation + posterize (downscaled to 80x80 center-cropped square, grayscale, 8 levels) for a chunky pixel art look.

#### Multi-Room System

Each room is an isolated instance with its own:
- Gemini vision backend + observation history
- Frame relay buffer
- Analysis loop (async background task)
- Audio file cache
- Connected clients list
- Work mode state + frost game score

Rooms are created by an admin (password-protected), identified by codes like `PANOPT-7X3K`, and expire after 30 minutes of inactivity. Up to 5 rooms can run simultaneously.

---

## HuggingFace Spaces Deployment

### How It's Deployed

The Space runs as a Docker container on HuggingFace infrastructure.

**Dockerfile:**
```dockerfile
FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
EXPOSE 7860
CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "7860"]
```

**Required secrets** (set in HuggingFace Space settings → Variables and secrets):
- `GEMINI_API_KEY` — Google Gemini API key
- `ADMIN_PASSWORD` — Password for creating rooms

**Deployment flow:**
1. Push to `hf` remote `main` branch: `git push hf feature/hf-spaces:main`
2. HuggingFace detects the Dockerfile, builds the container
3. The Space starts `server.py` via uvicorn on port 7860
4. Users access the lobby at the Space URL

### Pages

| URL | Page | Description |
|-----|------|-------------|
| `/` | Lobby | Create room (admin) or join room (code) |
| `/room/{code}` | Controller | 4-quadrant control interface + video preview |
| `/room/{code}/worker` | Worker | Fullscreen display, no controls, hidden cursor |

### User Flow

1. **Admin** opens the Space URL → enters admin password → clicks **Create**
2. A room code is generated (e.g. `PANOPT-7X3K`) with links to controller and worker
3. **Worker device** opens the worker link → enters Employee ID → registers
4. **Admin** opens the controller page → sees the worker registered in Connected Devices
5. **Admin** clicks **START PANOPTICUM** → worker's camera activates, Gemini analysis begins
6. **Worker device** transitions (iris wipe animation) to the active screen → shows commentary circle + audio narration
7. **Admin** can optionally click **START WORK** → frost game tiles appear on worker, cursor heat gameplay begins
8. Room expires after 30 minutes of inactivity

---

## Local Setup (Standalone)

### Requirements

- Windows 10/11 (or any OS with Python 3.9+)
- USB webcam or built-in camera
- Internet connection (for Gemini API + edge-tts)
- Speakers or audio output
- Gemini API key (free tier available)

### Quick Setup

#### 1. Install Python

Download Python 3.11+ from [python.org](https://www.python.org/downloads/).
During installation, **check "Add to PATH"**.

#### 2. Get a Gemini API key

Get a free key from [aistudio.google.com/apikey](https://aistudio.google.com/apikey).

#### 3. Install dependencies

```
python -m venv venv
venv\Scripts\activate
pip install -r requirements.txt
```

For local mode, you also need OpenCV:
```
pip install opencv-python numpy
```

#### 4. Configure your API key

Create a `.env` file in the project root:
```
GEMINI_API_KEY=your_api_key_here
```

#### 5. Test your setup

```
python setup_check.py
```

#### 6. Run

```
python main.py
```

This single command starts everything — the web server, camera system, AI analysis, and TTS all run inside one Python process.

Once running, open a browser:
- **Control page:** `http://localhost:8000/` — video feed + interactive controls
- **Worker page:** `http://localhost:8000/worker` — fullscreen display, no controls, hidden cursor

The camera and analysis pipeline start **stopped**. Click **START PANOPTICUM** in the web UI to begin. Click **STOP PANOPTICUM** to pause (releases camera, zero API calls). The web server stays running either way.

To shut down, press **Ctrl+C** in the terminal.

---

## Web UI

### Controls (Controller Page)

The controller uses a **4-quadrant layout** centered around a circle showing the live video feed (pixelated, posterized). Cross dividers separate the quadrants, with the video circle at the intersection.

#### Q1 — Actions (top-left)

- **START / STOP PANOPTICUM** — Starts or stops the camera capture, AI analysis, and TTS pipeline
- **START / STOP WORK** — Starts or stops the frost game work session (requires pipeline to be active)
- **Request Action** — Triggers an action request on demand (disabled while an action is in progress)

#### Q2 — Activity Log (top-right)

Scrollable panel showing AI observations with timestamps and contextual tags:
- **Tone tags:** `[Supportive]`, `[Neutral]`, `[Judgmental]` — color-coded to the tone at generation time
- **Action tags:** `[Action]`, `[Completed]`, `[Timeout]` — amber-colored for action mode events
- **Work tags:** `[Work]`, `[End Work]` — frost-blue for work session start/stop
- Skipped entries (superseded before being read aloud) appear dimmed with a skip icon

#### Q3 — App Status (bottom-left)

- **Phase label** — unified priority-based display:
  - **Standby** (dimmed white) — pipeline inactive
  - **Observing** (white with glow) — pipeline active, normal commentary
  - **Working** (frost blue `#38bdf8`) — work mode active
  - **Requesting** / **Verifying** (amber `#fbbf24`) — action mode in progress
- **Connected Devices** — lists connected browsers with role and label
- **Work Score** — appears during work mode: a 450x450 canvas rendering the frost grid with white outlined cells at varying transparency, plus a percentage label

#### Q4 — Settings (bottom-right)

| Setting | Range | Description |
|---------|-------|-------------|
| Action Mode | Manual / Automatic | Manual: trigger actions on demand. Automatic: AI auto-triggers every 60s |
| Comment Tone | Supportive / Neutral / Judgmental | AI personality (0.0 → 0.5 → 1.0) |
| Comment Frequency | 3–30s | Seconds between AI analysis cycles |
| Comment Length | 3–50 words | Maximum word count for AI observations |
| Heat Strength | 10–100% | How quickly the cursor melts frost tiles |
| Freeze Time | 5–60s | How long a tile stays warm before re-freezing |
| Heat Radius | 50–300px | Cursor heat area radius |

The last three settings (Heat Strength, Freeze Time, Heat Radius) control the frost game on the worker and are synced via SSE.

### Worker Page

The worker is a fullscreen display with no controls, black background, and a WebGL ripple effect that persists across all states.

#### Idle State

Shows a corporate idle message with an **Employee ID input** and **Register** button. The worker must register before the controller can start the pipeline (the Start Panopticum button is disabled until a worker registers). If a second worker tries to join, it shows "This workstation is occupied."

#### Iris Wipe Transition

When the pipeline starts or stops, an animated circular clip-path transition plays between idle and active screens:
1. **Close phase** (3s): current screen shrinks to a point at the center
2. **Pause** (1s): screens swap
3. **Open phase** (3s): new screen expands from center to full viewport

A thin white ring SVG tracks the clip-path boundary during the animation.

#### Active State

- **Commentary circle** — centered circle displaying the latest AI observation text
- **Audio playback** — "latest wins" strategy: only the most recent pending description plays, older ones are skipped
- **Fitter Happier lyrics** — every 4th cycle in judgmental mode, a robotic female voice reads Radiohead lyrics (best-effort, skipped if narration is playing)
- **Periodic ripple drops** — center drops every 2 seconds on the WebGL ripple background

#### Work Mode (Frost Game)

When work mode is activated from the controller:
- A responsive grid of frost tiles appears over the active screen
- Tiles gradually freeze (turn opaque) over time
- The worker melts tiles by moving their cursor near them (cursor heat)
- The **circle shows percentage** (`85%`) instead of commentary text during work mode
- A **bottom-right label** shows `heat:N% freeze:Ns` (current heat and freeze settings)
- Commentary descriptions still play as audio but are suppressed from the circle display

#### Audio Playback — "Latest Wins"

The worker uses a "latest wins" audio strategy to keep narration close to real-time. When a new description arrives while audio is already playing, all previously queued descriptions are discarded — only the latest one plays next. Currently playing audio is never interrupted; it finishes naturally before the latest pending description plays.

Lyrics audio (Fitter Happier) is best-effort: it only plays when no narration is playing or pending, ensuring it never blocks scene descriptions.

#### Logo Credits

Clicking the PANOPTICUM logo (on any page) shows "Created by Martin Bielik / with no bad intentions." for 5 seconds.

---

## Work Mode (Frost Game)

An interactive minigame layered on top of the surveillance pipeline.

### What It Is

A responsive grid of tiles covers the worker screen. Tiles gradually freeze over time (turning opaque). The worker must move their cursor to melt nearby tiles using "cursor heat." The goal is to keep as many tiles defrosted as possible.

### Lifecycle

1. **Pipeline must be active** — work mode cannot start unless `START PANOPTICUM` has been clicked
2. **Start Work** — controller clicks `START WORK`. Frost tiles appear on the worker's active screen
3. **Gameplay** — tiles freeze on a timer; worker melts them by hovering the cursor. Score is shown in the worker's circle as a percentage
4. **Stop Work** — controller clicks `STOP WORK`. Tiles disappear, active screen remains
5. **Pipeline stop cascade** — stopping the pipeline automatically stops work mode

### Grid System

- Target tile size: ~80px CSS pixels
- Grid dimensions computed from viewport, rounded to even numbers (min 2)
- On window resize: nearest-neighbor spatial remap preserves frost state
- Score = percentage of unfrozen tiles

### Score Propagation

- **Worker → Server:** Uploads score + base64-encoded tile snapshot (Uint8Array) every 2 seconds via `POST /api/work-score`
- **Server → Controller:** SSE `work_score` event with full tile data
- **Controller display:** Work Score section in Q3 with a canvas rendering the tile grid

### AI Work Awareness

During active work mode, the analysis loop passes work context to Gemini — current score percentage and trajectory (rising/falling/stagnant with 3% deadband). The AI naturally incorporates score into commentary. Tone system still applies: supportive praises progress, judgmental criticizes.

---

## Action Mode

Interactive mode where the AI issues physical directives and verifies compliance via the camera.

### State Machine

```
  COMMENTING ──(auto: 60s elapsed, OR manual button)──→ ACTION_REQUESTING
       ↑                                                       │
       │                                     (Gemini generates action, TTS speaks it)
       │                                                       ↓
       └──(COMPLETED or 30s timeout)────────── ACTION_VERIFYING
              each 3s cycle: Gemini checks if action was performed
```

- **Manual mode:** Click "Request Action" to trigger on demand
- **Automatic mode:** AI auto-triggers every 60 seconds of commentary
- The AI generates a camera-verifiable physical action (raise hand, wave, look at camera, etc.) based on the current frame
- If the action is completed, the AI confirms with a tone-appropriate response
- If 30 seconds elapse without compliance, the AI gives a neutral acknowledgement and returns to commentary

---

## Fitter Happier (Judgmental Mode)

When tone is set to Judgmental (>= 0.75), every 4th analysis cycle triggers a robotic female voice reading a line from Radiohead's "Fitter Happier." The lyrics appear as green terminal text in CCTV mode. 30 lines cycle endlessly.

---

## REST API Reference

### Room Management

| Endpoint | Method | Body | Response |
|----------|--------|------|----------|
| `/api/create-room` | POST | `{password}` | `{code}` or 403 |
| `/api/join-room` | POST | `{code}` | `{code}` or 404 |
| `/api/rooms` | GET | — | `{rooms: [...]}` |

### Room-Scoped Control

All room-scoped endpoints are prefixed with `/room/{code}/api/`.

| Endpoint | Method | Body | Response |
|----------|--------|------|----------|
| `status` | GET | — | `{active, effect, tone, description, description_timestamp}` |
| `active` | GET/POST | `{active: bool}` | `{active: bool}` |
| `effect` | GET/POST | `{effect: str}` | `{effect: str}` |
| `tone` | GET/POST | `{value: float}` | `{value: float}` |
| `frequency` | POST | `{value: int}` | `{value: int}` |
| `comment-length` | POST | `{value: int}` | `{value: int}` |
| `frame` | POST | `{frame: base64, client_id: str}` | `{ok: true}` or 403 |
| `register` | POST | `{client_id, role, label}` | `{ok, is_source, clients}` or 409 |
| `heartbeat` | POST | `{client_id}` | `{ok: true}` |
| `unregister` | POST | `{client_id}` | `{ok: true}` |
| `action-setting` | POST | `{setting: "automatic"\|"manual"}` | `{setting}` |
| `trigger-action` | POST | — | `{ok: true}` or 400 |
| `work` | POST | `{active: bool}` | `{active: bool}` or 400 |
| `work-score` | POST | `{unfrozen, total, cols, rows, tiles}` | `{ok: true}` |
| `heat-strength` | POST | `{value: int}` | `{value: int}` |
| `freeze-time` | POST | `{value: float}` | `{value: float}` |
| `heat-radius` | POST | `{value: int}` | `{value: int}` |

### Streaming

| Endpoint | Type | Description |
|----------|------|-------------|
| `/room/{code}/stream/snapshot` | HTTP | Latest JPEG frame (polled by controller every 500ms) |
| `/room/{code}/events` | SSE | Real-time events (see SSE Event Types below) |
| `/room/{code}/audio/{timestamp}` | HTTP | MP3 audio file |

### SSE Event Types

| Event | Payload | Description |
|-------|---------|-------------|
| `active` | `{active: bool}` | Pipeline started/stopped |
| `description` | `{text, timestamp, tone, type}` | New AI observation. `type`: commentary / action_request / action_completed / action_timeout |
| `effect` | `{effect: str}` | Effect changed |
| `tone` | `{value: float}` | Tone changed |
| `lyrics` | `{text: str}` | Fitter Happier lyrics line |
| `audio` | `{url: str, timestamp}` | Narration MP3 ready |
| `audio_robotic` | `{url: str}` | Robotic lyrics MP3 ready (best-effort) |
| `clients` | `{clients: [...], active_source: str}` | Client list changed |
| `action_phase` | `{setting, phase, action}` | Action mode state changed |
| `frequency` | `{value: int}` | Analysis interval changed |
| `comment_length` | `{value: int}` | Comment length changed |
| `heat_strength` | `{value: int}` | Heat strength changed |
| `freeze_time` | `{value: float}` | Freeze time changed |
| `heat_radius` | `{value: int}` | Heat radius changed |
| `work` | `{active: bool}` | Work mode started/stopped |
| `work_score` | `{unfrozen, total, cols, rows, tiles}` | Work score updated (`tiles`: base64 Uint8Array) |

---

## How It Works

1. **Start** — Operator clicks START PANOPTICUM. Worker's camera opens via `getUserMedia`. Analysis begins.
2. **Introduction** — Gemini describes the scene in a full sentence with the current tone personality.
3. **Change detection** — Subsequent frames are compared against observation history (max 10). If nothing changed: silence. If something changed: a 3-8 word status update.
4. **Stale refresh** — If silent for 10+ seconds, a scene description is forced (configurable via Comment Frequency slider).
5. **TTS** — New descriptions are spoken via edge-tts. In local mode, through speakers. In HF Spaces, MP3 is streamed to the worker browser. The worker uses a "latest wins" strategy — if descriptions arrive faster than they can be spoken, only the most recent one plays next (skipped entries are marked in the activity log).
6. **Fitter Happier** — Every 4th cycle in judgmental mode: robotic female voice reads lyrics. Lyrics are best-effort and only play when no narration is active or pending.
7. **Action Mode** — Manually or automatically (every 60s), the AI switches from commentary to action: it generates a physical directive ("raise your right hand"), speaks it via TTS, then polls the camera every 3s to verify compliance. On success or 30s timeout, it responds and resumes commentary.
8. **Work Mode** — Operator clicks START WORK. Frost tiles appear on the worker screen. Tiles freeze over time; the worker melts them with cursor heat. Score is shown in the worker's circle and streamed to the controller. The AI incorporates score state into its commentary.
9. **Fallback** (local only) — If Gemini hits rate limits or goes down, the app switches to the local Ollama pipeline.
10. **Stop** — Operator clicks STOP PANOPTICUM. Camera releases, API calls cease, TTS goes silent. Work mode cascade-stops automatically.

---

## File Structure

```
PanopticumApp/
├── main.py              # Local standalone entry point (camera + analysis + TTS threads)
├── server.py            # FastAPI web server (HF Spaces multi-room deployment)
├── rooms.py             # Room + Client management (dataclasses, registration, cleanup)
├── vision.py            # Vision backends (Gemini API, Ollama fallback)
├── tts.py               # Text-to-speech (edge-tts async, pyttsx3 local)
├── tone.py              # Tone/personality system (0.0 supportive → 1.0 judgmental)
├── effects.py           # Video effects (CCTV, Insta, Natural) — local mode only
├── narrator.py          # Ollama narrator pipeline — local fallback only
├── overlay.py           # OpenCV video overlays — local mode only
├── setup_check.py       # Setup validation utility
├── config.yaml          # Configuration (camera, vision, TTS, timing, etc.)
├── requirements.txt     # Python dependencies
├── Dockerfile           # HuggingFace Spaces container build
├── .env                 # API keys (not committed)
├── UI-GUIDE.md          # Comprehensive visual design system
│
├── static/
│   ├── app.js           # Frontend logic (controller + worker, frost game, iris wipe)
│   ├── style.css        # Styling (corporate surveillance aesthetic)
│   └── jquery.ripples.js # WebGL water ripple effect plugin (MIT, requires jQuery)
│
├── templates/
│   ├── lobby.html       # Room join/create page
│   ├── control.html     # Controller page (4-quadrant layout + video circle)
│   └── worker.html      # Worker page (fullscreen, audio playback, frost game)
│
└── prompts/
    ├── gemini_surveillance.txt       # Gemini unified prompt (vision + narration)
    ├── narrator_surveillance.txt     # Ollama fallback narrator prompt
    └── surveillance.txt              # Vision-only prompt
```

---

## Customization

### Change the voice, timing, or camera

Edit `config.yaml`. Key settings:

```yaml
timing:
  analysis_interval: 3    # Seconds between AI analyses

tts:
  backend: "edge-tts"     # "edge-tts" (online) or "pyttsx3" (offline)
  edge_tts:
    voice: "en-US-GuyNeural"
    rate: "-15%"
    pitch: "-15Hz"

camera:
  index: 0                # 0 = default, 1 = second camera (local mode only)
```

### Change what the AI says

Edit the prompt files in `prompts/`:
- `gemini_surveillance.txt` — Gemini unified prompt (vision + narration + judgment)
- `narrator_surveillance.txt` — Ollama fallback narrator prompt
- `surveillance.txt` — Vision-only prompt (used when narrator is disabled)

### Use Ollama instead of Gemini (fully offline, local mode only)

In `config.yaml`:
```yaml
vision:
  backend: "ollama"
tts:
  backend: "pyttsx3"
```

You'll need Ollama installed with models pulled:
```
ollama pull moondream
ollama pull llama3.2:3b
```

### Cost

Gemini 2.0 Flash: ~$0.01/hour at 3-second intervals. Essentially free. Zero cost while stopped.

---

## For the Installation

### Local deployment
- Run `python main.py` on the operator laptop
- Open `http://localhost:8000/worker` on the display device (TV, projector, second monitor)
- Open `http://localhost:8000/` on the operator's laptop or phone to control start/stop, effects, and tone
- Click START when ready

### HuggingFace Spaces deployment
- Create a room via the lobby with the admin password
- Open the **worker** link on the display device (TV, projector, kiosk) → enter Employee ID → register
- Open the **controller** link on the operator's device
- Click **START PANOPTICUM** → worker's camera activates, AI analysis begins
- The worker transitions to the active screen with audio narration
- Optionally click **START WORK** to activate the frost game

### Tips
- Disable sleep and screen saver on the display device
- Place speakers near the display, not the operator laptop
- The system auto-recovers from camera disconnects and Gemini rate limits

---

## Troubleshooting

**Camera not detected (local):** Try changing `camera > index` in `config.yaml` to `1` or `2`.

**Camera not detected (HF Spaces):** The browser must grant camera permission. Check that the site is served over HTTPS (HuggingFace Spaces provides this).

**Gemini 429 errors:** API rate limit. The app retries with backoff automatically. If persistent, increase `analysis_interval` in `config.yaml`.

**No sound (local):** Check Windows audio output device. Make sure speakers are connected and volume is up.

**No sound (HF Spaces):** The worker page must receive a user interaction (click/tap) before browsers allow audio autoplay. Click anywhere on the worker page after loading.

**Ollama not connecting (local only):** Make sure Ollama is running (`ollama serve`). Download from [ollama.com/download](https://ollama.com/download).

**Black video after stopping:** Expected. The camera is released when stopped. Click START to resume.

**Stale client in device list:** Clients are cleaned up 15 seconds after their last heartbeat. Closing a tab triggers an immediate unregister via `sendBeacon`.

---

## Dependencies

```
PyYAML>=6.0                # Configuration
edge-tts>=6.1.0            # Text-to-speech (MP3 generation)
google-genai>=1.0.0        # Gemini API client
python-dotenv>=1.0.0       # .env file support
fastapi>=0.115.0           # Web framework
uvicorn[standard]>=0.32.0  # ASGI server
jinja2>=3.1.0              # Template rendering
sse-starlette>=2.0.0       # Server-Sent Events
python-multipart>=0.0.9    # Form data parsing
```

Local mode additionally requires: `opencv-python`, `numpy`
