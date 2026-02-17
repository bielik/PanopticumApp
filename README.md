# PANOPTICUM

An interactive surveillance art installation.

A camera watches a space. An AI describes what it sees. A voice speaks the description out loud. The cosy becomes clinical. The private becomes observed. The machine judges.

## Architecture

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

**Primary backend:** Google Gemini API — multimodal vision + text in a single call. Handles scene description, change detection, and narration with a judgmental surveillance personality.

**Offline fallback:** Ollama (moondream + llama3.2:3b) — local two-model pipeline. Activates automatically if Gemini fails.

**Web interface:** FastAPI server with live MJPEG video, Server-Sent Events for real-time state sync, and REST API for controls. Two modes: operator control page and fullscreen exhibition display.

## Requirements

- Windows 10/11 (or any OS with Python 3.9+)
- USB webcam or built-in camera
- Internet connection (for Gemini API + edge-tts)
- Speakers or audio output
- Gemini API key (free tier available)

## Quick Setup

### 1. Install Python

Download Python 3.11+ from [python.org](https://www.python.org/downloads/).
During installation, **check "Add to PATH"**.

### 2. Get a Gemini API key

Get a free key from [aistudio.google.com/apikey](https://aistudio.google.com/apikey).

### 3. Install dependencies

```
python -m venv venv
venv\Scripts\activate
pip install -r requirements.txt
```

### 4. Configure your API key

Create a `.env` file in the project root:

```
GEMINI_API_KEY=your_api_key_here
```

### 5. Test your setup

```
python setup_check.py
```

### 6. Run

Open a terminal (Command Prompt, PowerShell, or Windows Terminal), navigate to the project folder, activate the virtual environment, and start the app:

```
cd C:\Users\MartinBielik\Dev\PanopticumApp
venv\Scripts\activate
python main.py
```

This single command starts everything — the web server, camera system, AI analysis, and TTS all run inside one Python process. There is nothing else to install or start separately.

Once running, open a browser:

- **Control page:** `http://localhost:8000/` — video feed + interactive controls
- **Exhibition page:** `http://localhost:8000/exhibit` — fullscreen display, no controls, hidden cursor

The camera and analysis pipeline start **stopped**. Click **START** in the web UI to begin. Click **STOP** to pause (releases camera, zero API calls). The web server stays running either way.

To shut down the whole process, press **Ctrl+C** in the terminal.

## Web UI

The control page provides real-time operator controls. The exhibition page shows the same video feed and AI narration overlay but hides all controls for a clean display.

### Start/Stop

The pipeline (camera, AI analysis, TTS) starts stopped on launch. A single toggle button controls the entire pipeline:

- **START** (green) — opens the camera, begins AI analysis and TTS narration
- **STOP** (red) — releases the camera, halts all API calls (zero traffic while stopped)

The web server stays running in both states. Worker threads idle-loop rather than being killed, so restarting is instant.

### Video Effects

Four display effects applied to the video stream only (the AI always sees the raw frame):

- **Original** — unprocessed camera feed
- **CCTV** — grayscale, pixelated, noisy
- **Night Vision** — green-tinted with noise
- **Noir** — high-contrast black and white with vignette

### Tone Slider

A slider from 0.0 to 1.0 controls the AI's narration personality:

- **Flattering** (0.0) — supportive, encouraging observations
- **Neutral** (0.5) — factual, clinical reporting
- **Judgmental** (1.0) — dry, sarcastic commentary (default)

### Video Overlay

Both pages display a surveillance-style overlay on the video feed:

- Live timestamp (top-left)
- Blinking REC indicator (top-right)
- Camera label (bottom-right)
- AI narration text with fade-in/fade-out (bottom)
- Audio indicator when TTS is speaking (bottom-left)

### Real-Time Sync

All state changes (start/stop, effects, tone, descriptions, speaking status) sync across connected browsers via Server-Sent Events. Open the control page on a laptop and the exhibit page on a TV — they stay in sync.

### REST API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/active` | GET/POST | Start/stop the pipeline (`{active: bool}`) |
| `/api/effect` | GET/POST | Get/set video effect (`{effect: str}`) |
| `/api/tone` | GET/POST | Get/set tone value (`{value: 0.0-1.0}`) |
| `/api/status` | GET | Full state snapshot |
| `/stream` | GET | MJPEG video stream |
| `/events` | GET | SSE event stream |

## How It Works

1. **Start** — Operator clicks START in the web UI. Camera opens, analysis begins
2. **Introduction** — Gemini describes the scene in a full sentence with the current tone
3. **Change detection** — Subsequent frames are compared against observation history. If nothing changed: silence. If something changed: a 3-8 word status update is spoken
4. **Stale refresh** — If silent for 10+ seconds, a scene status update is forced (configurable via `stale_timeout`)
5. **Fallback** — If Gemini hits rate limits or goes down, the app automatically switches to the local Ollama pipeline
6. **Stop** — Operator clicks STOP. Camera releases, API calls cease, TTS goes silent

## Customization

### Change the voice, timing, or camera

Edit `config.yaml`. All settings are documented with comments.

### Change what the AI says

Edit the prompt files in `prompts/`:

- `gemini_surveillance.txt` — Gemini unified prompt (vision + narration + judgment)
- `narrator_surveillance.txt` — Ollama fallback narrator prompt
- `surveillance.txt` — Vision-only prompt (used when narrator is disabled)

### Use Ollama instead of Gemini (fully offline)

In `config.yaml`:

```yaml
vision:
  backend: "ollama"    # switch from "gemini" to "ollama"
tts:
  backend: "pyttsx3"   # offline TTS
```

You'll need Ollama installed with models pulled:

```
ollama pull moondream
ollama pull llama3.2:3b
```

### Cost

Gemini 2.0 Flash: ~$0.01/hour at 3-second intervals. Essentially free. Zero cost while stopped.

## For the Exhibition

- Run `python main.py` on the operator laptop
- Open `http://localhost:8000/exhibit` on the display device (TV, projector, second monitor)
- Open `http://localhost:8000/` on the operator's laptop or phone to control start/stop, effects, and tone
- Click START when ready to begin the installation
- Disable Windows sleep and screen saver
- Place a speaker near the display (not next to the laptop)
- The system auto-recovers if the camera disconnects or Gemini goes down

## Troubleshooting

**Camera not detected**: Try changing `camera > index` in `config.yaml` to `1` or `2`.

**Gemini 429 errors**: You've hit the API rate limit. The app will retry with backoff. If persistent, increase `analysis_interval` in `config.yaml` or check your billing at [ai.dev/rate-limit](https://ai.dev/rate-limit).

**No sound**: Check Windows audio output device. Make sure speakers are connected and volume is up.

**Ollama not connecting**: Make sure Ollama is running (`ollama serve`). Download from [ollama.com/download](https://ollama.com/download).

**Black video after stopping**: Expected. The camera is released when stopped. Click START to resume.
