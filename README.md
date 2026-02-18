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
| Camera | USB/built-in via OpenCV | Browser `getUserMedia` |
| TTS output | Local speakers (pyttsx3/edge-tts) | MP3 streamed to worker browser |
| Users | Single operator | Multiple rooms, multiple clients per room |
| Video relay | Direct OpenCV → MJPEG | Browser → base64 POST → server MJPEG |
| URL | `http://localhost:8000` | [huggingface.co/spaces/MartinBLK/Panopticum](https://huggingface.co/spaces/MartinBLK/Panopticum) |

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
[Web UI]  <--  MJPEG stream + SSE events + REST controls
```

**Primary backend:** Google Gemini API — multimodal vision + text in a single call. Handles scene description, change detection, and narration with a tone-adjustable personality.

**Offline fallback (local mode only):** Ollama (moondream + llama3.2:3b) — local two-model pipeline. Activates automatically if Gemini fails.

### Local Mode Architecture

```
main.py
  ├── Camera Thread ──── OpenCV capture → apply effects → JPEG encode
  ├── Analysis Thread ── Gemini/Ollama vision → narration
  ├── TTS Thread ─────── pyttsx3/edge-tts → local speakers
  └── FastAPI Server ─── MJPEG stream + SSE + REST
```

Three background threads share state through a `SharedState` dataclass with threading locks. The camera captures raw frames, the analysis thread sends them to Gemini, and the TTS thread speaks the narration through local speakers. The web UI is optional — it mirrors the local display.

### HuggingFace Spaces Architecture

```
Browser (Controller)        server.py              Browser (Worker)
  │                            │                        │
  ├─ getUserMedia ─────────────┤                        │
  │   (camera capture)         │                        │
  │                            │                        │
  ├─ POST /api/frame ─────────→│                        │
  │   (base64 JPEG, 4fps)     │                        │
  │                            ├── [Room State] ───────→│ GET /stream (MJPEG)
  │                            │                        │
  │                            ├── Gemini Vision ──────→│ SSE "description"
  │                            │                        │
  │                            ├── edge-tts ───────────→│ SSE "audio" → /audio/{ts}
  │                            │                        │
  ├─ SSE /events ←────────────┤                        ├─ SSE /events
  │   (state sync)             │                        │   (state sync + audio cues)
  │                            │                        │
  └─ REST /api/* ─────────────→│                        │
      (controls)               │                        │
```

No OpenCV, no local speakers, no camera thread. The browser captures the camera via `getUserMedia`, encodes JPEG on a `<canvas>`, and POSTs base64 frames to the server. The server stores frames in memory, runs Gemini analysis in an async background task, generates MP3 audio via edge-tts, and serves everything through MJPEG streaming, SSE events, and REST endpoints.

#### Multi-Room System

Each room is an isolated instance with its own:
- Gemini vision backend + observation history
- Frame relay buffer
- Analysis loop (async background task)
- Audio file cache
- Connected clients list
- Active source designation

Rooms are created by an admin (password-protected), identified by codes like `PANOPT-7X3K`, and expire after 30 minutes of inactivity. Up to 5 rooms can run simultaneously.

#### Multi-Client Video Source

Multiple browsers can connect to the same room. Only one client at a time is the **active video source** — the device whose camera frames are uploaded and analyzed.

- **Client registration:** Each browser generates a UUID (`crypto.randomUUID()`) stored in `sessionStorage` and registers with the server on page load.
- **Heartbeat:** Every 10 seconds, clients send a keep-alive. Stale clients (no heartbeat for 15s) are automatically removed.
- **Source designation:** The first controller to connect becomes the source automatically. Any connected device (controller or worker) can be manually set as the source via the "Connected Devices" panel.
- **Non-source controllers:** Controllers that are not the active source display the MJPEG stream from the source device, so all screens show the same feed. Camera permission is only requested when a device becomes the source.
- **Frame rejection:** The server returns 403 for frame uploads from non-source clients, preventing visual chaos from multiple uploaders.
- **Worker as source:** The worker device can run its own camera — when designated as source, it hides the MJPEG stream, activates `getUserMedia`, and uploads frames.
- **Camera picker:** The active source device shows a dropdown to switch between available cameras.

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
| `/room/{code}` | Controller | Camera feed + controls + activity log |
| `/room/{code}/worker` | Worker | Fullscreen display, no controls, hidden cursor |

### User Flow

1. **Admin** opens the Space URL → enters admin password → clicks **Create**
2. A room code is generated (e.g. `PANOPT-7X3K`) with links to controller and worker
3. **Admin** opens the controller page → automatically becomes the video source → browser requests camera permission
4. **Admin** clicks **START PANOPTICUM** → camera feed uploads to server, Gemini analysis begins
5. **Worker device** joins via code or direct link → shows fullscreen MJPEG stream + audio narration
6. **Additional controllers** can join — they see the MJPEG stream from the source device (no camera prompt); only the designated source uploads frames
7. Source can be switched to any connected device via the "Connected Devices" panel
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

**Start/Stop** — A single toggle button controls the entire pipeline:
- **START PANOPTICUM** (blue) — begins camera capture, AI analysis, and TTS narration
- **STOP PANOPTICUM** (red) — releases camera, halts all API calls

**Video Effects** — Display-only filters (the AI always analyzes the raw frame):
- **Insta** — warm sepia tones with vignette overlay and rotating motivational messages
- **Natural** — unprocessed camera feed
- **CCTV** — grayscale with scanlines, green timestamp, blinking REC indicator

**Tone** — Three preset personalities for the AI narration:
- **Supportive** (0.0) — encouraging, praises everything
- **Neutral** (0.5) — factual, clinical reporting
- **Judgmental** (1.0) — critical micromanager, dry commentary

**Sync Toggle** — Links effect and tone: Insta ↔ Supportive, Natural ↔ Neutral, CCTV ↔ Judgmental.

**Worker Link** — Direct link to open the worker view for this room.

**Source Controls** (HuggingFace Spaces only):
- **Source status** — Shows whether this device is the active video source
- **Camera picker** — Dropdown to switch between available cameras (visible when this device is the source)

**Connected Devices** (HuggingFace Spaces only):
- Lists all connected browsers with role, label, and source status
- **Set Source** button on each non-source device to switch which device uploads frames

**Activity Log** — Scrollable panel showing the last 10 AI observations with timestamps and tone tags. Entries that were skipped (superseded by a newer description before they could be read aloud) appear dimmed with a ⏭ indicator. Collapsible via the × button.

### Worker Page

Fullscreen display with no controls, no cursor, black background. Shows the video feed with effect overlays and plays TTS audio. In CCTV mode, displays Radiohead's "Fitter Happier" lyrics every 4th analysis cycle when tone is judgmental. When the session is not active, shows an idle message: "Panopticum Interrupted — Wait for instructions from the control room."

#### Audio Playback — "Latest Wins"

The worker page uses a "latest wins" audio strategy to keep narration close to real-time. When a new description arrives while audio is already playing, all previously queued descriptions are discarded — only the latest one plays next. This prevents the accumulating delay that occurs when descriptions are generated faster than they can be read aloud. Currently playing audio is never interrupted; it finishes naturally before the latest pending description plays.

Lyrics audio (Fitter Happier) is best-effort: it only plays when no narration is playing or pending, ensuring it never blocks scene descriptions.

### Overlays

Both pages display effect-specific overlays on the video:
- **CCTV mode:** Live timestamp (top-left), blinking REC indicator (top-right), CAM-01 label (bottom-right), scanline filter, lyrics text
- **Insta mode:** Vignette border, rotating motivational messages with serif typography and blur backdrop
- **Natural mode:** No overlays

---

## Fitter Happier (Judgmental Mode)

When tone is set to Judgmental (≥ 0.75), every 4th analysis cycle triggers a robotic female voice reading a line from Radiohead's "Fitter Happier." The lyrics appear as green terminal text in CCTV mode. 30 lines cycle endlessly.

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
| `frame` | POST | `{frame: base64, client_id: str}` | `{ok: true}` or 403 |
| `register` | POST | `{client_id, role, label}` | `{ok, is_source, clients}` |
| `heartbeat` | POST | `{client_id}` | `{ok: true}` |
| `set-source` | POST | `{client_id}` | `{ok, clients}` |
| `unregister` | POST | `{client_id}` | `{ok: true}` |

### Streaming

| Endpoint | Type | Description |
|----------|------|-------------|
| `/room/{code}/stream` | MJPEG | Continuous JPEG frames (`multipart/x-mixed-replace`) |
| `/room/{code}/events` | SSE | Real-time events: `active`, `description`, `effect`, `tone`, `lyrics`, `audio`, `audio_robotic`, `clients` |
| `/room/{code}/audio/{timestamp}` | HTTP | MP3 audio file |

### SSE Event Types

| Event | Payload | Description |
|-------|---------|-------------|
| `active` | `{active: bool}` | Pipeline started/stopped |
| `description` | `{text, timestamp, tone}` | New AI observation |
| `effect` | `{effect: str}` | Effect changed |
| `tone` | `{value: float}` | Tone changed |
| `lyrics` | `{text: str}` | Fitter Happier lyrics line |
| `audio` | `{url: str}` | New narration MP3 ready (worker plays latest, skips stale) |
| `audio_robotic` | `{url: str}` | New robotic lyrics MP3 ready (best-effort, skipped if narration active) |
| `clients` | `{clients: [...], active_source: str}` | Client list changed (join/leave/source switch) |

---

## How It Works

1. **Start** — Operator clicks START PANOPTICUM. Camera opens (local) or browser captures (HF Spaces). Analysis begins.
2. **Introduction** — Gemini describes the scene in a full sentence with the current tone personality.
3. **Change detection** — Subsequent frames are compared against observation history (max 10). If nothing changed: silence. If something changed: a 3-8 word status update.
4. **Stale refresh** — If silent for 10+ seconds, a scene description is forced (configurable via `stale_timeout`).
5. **TTS** — New descriptions are spoken via edge-tts. In local mode, through speakers. In HF Spaces, MP3 is streamed to the worker browser. The worker page uses a "latest wins" strategy — if descriptions arrive faster than they can be spoken, only the most recent one plays next (skipped entries are marked in the activity log).
6. **Fitter Happier** — Every 4th cycle in judgmental mode: robotic female voice reads lyrics. Lyrics are best-effort and only play when no narration is active or pending.
7. **Fallback** (local only) — If Gemini hits rate limits or goes down, the app switches to the local Ollama pipeline.
8. **Stop** — Operator clicks STOP PANOPTICUM. Camera releases, API calls cease, TTS goes silent.

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
│
├── static/
│   ├── app.js           # Frontend logic (controller + worker, client registration)
│   └── style.css        # Styling (corporate surveillance aesthetic)
│
├── templates/
│   ├── lobby.html       # Room join/create page
│   ├── control.html     # Controller page (camera + controls + client panel)
│   └── worker.html      # Worker page (fullscreen, audio playback)
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
- Open the **controller** link on the operator's device
- Open the **worker** link on the display device (TV, projector, kiosk)
- Grant camera permission on the controller, click START PANOPTICUM
- The worker device shows the fullscreen feed with audio narration
- To use the display device's own camera: set it as the source in "Connected Devices"

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

**Multiple controllers uploading frames:** Only the designated source client's frames are accepted. Other controllers' frame uploads are rejected with 403. Switch the source via the "Connected Devices" panel.

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
