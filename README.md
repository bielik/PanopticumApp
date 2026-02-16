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
```

**Primary backend:** Google Gemini API — multimodal vision + text in a single call. Handles scene description, change detection, and narration with a judgmental surveillance personality.

**Offline fallback:** Ollama (moondream + llama3.2:3b) — local two-model pipeline. Activates automatically if Gemini fails.

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

```
python main.py
```

Or double-click `run.bat`. Press **ESC** to quit, **F** to toggle fullscreen.

## How It Works

1. **Introduction** — On launch, Gemini describes the scene in a full sentence with a judgmental surveillance tone
2. **Change detection** — Subsequent frames are compared against observation history. If nothing changed: silence. If something changed: a 3-8 word status update is spoken
3. **Stale refresh** — If silent for 10+ seconds, a scene status update is forced (configurable via `stale_timeout`)
4. **Fallback** — If Gemini hits rate limits or goes down, the app automatically switches to the local Ollama pipeline

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

Gemini 2.0 Flash: ~$0.01/hour at 3-second intervals. Essentially free.

## For the Exhibition

- Disable Windows sleep and screen saver
- Connect an external monitor via HDMI for the TV display
- Place a speaker near the TV (not next to the laptop)
- Use `run.bat` for easy startup
- The system auto-recovers if the camera disconnects or Gemini goes down

## Troubleshooting

**Camera not detected**: Try changing `camera > index` in `config.yaml` to `1` or `2`.

**Gemini 429 errors**: You've hit the API rate limit. The app will retry with backoff. If persistent, increase `analysis_interval` in `config.yaml` or check your billing at [ai.dev/rate-limit](https://ai.dev/rate-limit).

**No sound**: Check Windows audio output device. Make sure speakers are connected and volume is up.

**Ollama not connecting**: Make sure Ollama is running (`ollama serve`). Download from [ollama.com/download](https://ollama.com/download).
