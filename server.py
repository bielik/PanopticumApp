"""
server.py — FastAPI web server for PANOPTICUM (HuggingFace Spaces).

Room-scoped routes: lobby, controller, worker, MJPEG relay, SSE, audio.
Per-room async analysis loop using Gemini vision + edge-tts.
"""

import asyncio
import base64
import json
import logging
import re
import time

import yaml
from dotenv import load_dotenv
load_dotenv()

from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse, JSONResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from pydantic import BaseModel

from rooms import (
    Room, cleanup_expired, cleanup_stale_clients, create_room,
    get_client_list, get_room, heartbeat_client, register_client, rooms,
    set_active_source, unregister_client,
)
from tone import build_tone_preamble
from tts import generate_robotic_speech, generate_speech

log = logging.getLogger("panopticum.server")

# ---------------------------------------------------------------------------
# App setup
# ---------------------------------------------------------------------------
app = FastAPI(title="PANOPTICUM")
app.mount("/static", StaticFiles(directory="static"), name="static")
templates = Jinja2Templates(directory="templates")

VALID_EFFECTS = ["insta", "natural", "cctv"]

# Fitter Happier lyrics (Radiohead) — spoken in judgmental mode
FITTER_HAPPIER_LYRICS = [
    "Fitter, happier\nMore productive",
    "Comfortable\nNot drinking too much",
    "Regular exercise at the gym\nThree days a week",
    "This is the Panic Office\nSection 917 may have been hit",
    "Activate following procedure",
    "Getting on better with your\nAssociate employee contemporaries",
    "At ease\nEating well",
    "No more microwave dinners\nAnd saturated fats",
    "A patient, better driver\nA safer car",
    "Baby smiling in back seat\nSleeping well, no bad dreams",
    "No paranoia\nCareful to all animals",
    "Never washing spiders\nDown the plughole",
    "Keep in contact with old friends\nEnjoy a drink now and then",
    "Will frequently check credit\nAt moral bank",
    "Fond, but not in love\nCharity standing orders",
    "On Sundays\nRing road supermarket",
    "No killing moths or putting\nBoiling water on the ants",
    "No longer afraid of the dark\nOr midday shadows",
    "Nothing so ridiculously\nTeenage and desperate",
    "At a better pace\nSlower and more calculated",
    "No chance of escape\nNow self-employed",
    "Concerned, but powerless\nAn empowered and informed\nMember of society",
    "Pragmatism, not idealism\nWill not cry in public",
    "Less chance of illness\nTires that grip in the wet",
    "A good memory\nStill cries at a good film",
    "Still kisses with saliva\nNo longer empty and frantic",
    "Like a cat, tied to a stick\nThat's driven into\nFrozen winter shit",
    "The ability to laugh\nAt weakness",
    "Calm\nFitter, healthier\nAnd more productive",
    "A pig in a cage\nOn antibiotics",
]


# ---------------------------------------------------------------------------
# Load config at import time
# ---------------------------------------------------------------------------
def _load_config() -> dict:
    try:
        with open("config.yaml", "r", encoding="utf-8") as f:
            return yaml.safe_load(f)
    except FileNotFoundError:
        log.warning("config.yaml not found, using defaults")
        return {
            "vision": {"backend": "gemini", "gemini": {"api_key": "", "model": "gemini-2.0-flash"}},
            "prompt": {"file": "prompts/surveillance.txt", "max_words": 40},
            "narrator": {"enabled": True, "prompt_file": "prompts/gemini_surveillance.txt",
                         "max_history": 10, "stale_timeout": 10},
            "timing": {"analysis_interval": 3},
            "tts": {"backend": "edge-tts", "edge_tts": {"voice": "en-US-GuyNeural",
                     "rate": "-15%", "volume": "+0%", "pitch": "-15Hz"}},
        }


config = _load_config()

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
    datefmt="%H:%M:%S",
)


# ---------------------------------------------------------------------------
# Startup: periodic room cleanup
# ---------------------------------------------------------------------------
@app.on_event("startup")
async def startup_cleanup_task():
    async def _cleanup_loop():
        while True:
            cleanup_expired()
            for room in rooms.values():
                _cleanup_audio(room)
            await asyncio.sleep(60)

    async def _client_cleanup_loop():
        while True:
            for room in rooms.values():
                cleanup_stale_clients(room)
            await asyncio.sleep(5)

    asyncio.create_task(_cleanup_loop())
    asyncio.create_task(_client_cleanup_loop())


def _cleanup_audio(room: Room):
    """Remove audio files older than 2 minutes."""
    now = time.time()
    old_keys = [k for k, _ in room.audio_files.items() if now - k > 120]
    for k in old_keys:
        del room.audio_files[k]


# ---------------------------------------------------------------------------
# Pages
# ---------------------------------------------------------------------------
@app.get("/", response_class=HTMLResponse)
async def lobby_page(request: Request):
    """Lobby — create room (admin) or join room (code)."""
    return templates.TemplateResponse("lobby.html", {"request": request})


@app.get("/room/{code}", response_class=HTMLResponse)
async def controller_page(request: Request, code: str):
    """Controller page — browser camera + controls + activity log."""
    room = get_room(code)
    if not room:
        return templates.TemplateResponse("lobby.html", {
            "request": request, "error": f"Room {code} not found."
        })
    room.touch()
    return templates.TemplateResponse("control.html", {
        "request": request, "room_code": code,
    })


@app.get("/room/{code}/worker", response_class=HTMLResponse)
async def worker_page(request: Request, code: str):
    """Worker page — fullscreen video + overlays + audio."""
    room = get_room(code)
    if not room:
        return templates.TemplateResponse("lobby.html", {
            "request": request, "error": f"Room {code} not found."
        })
    room.touch()
    return templates.TemplateResponse("worker.html", {
        "request": request, "room_code": code,
    })


# ---------------------------------------------------------------------------
# Room management API
# ---------------------------------------------------------------------------
class CreateRoomRequest(BaseModel):
    password: str

class JoinRoomRequest(BaseModel):
    code: str


@app.post("/api/create-room")
async def api_create_room(req: CreateRoomRequest):
    """Create a new room (requires admin password)."""
    room = create_room(req.password, config)
    if room is None:
        return JSONResponse(status_code=403, content={
            "error": "Invalid password or max rooms reached."
        })
    return {"code": room.id}


@app.post("/api/join-room")
async def api_join_room(req: JoinRoomRequest):
    """Validate a room code exists."""
    code = req.code.strip().upper()
    room = get_room(code)
    if not room:
        return JSONResponse(status_code=404, content={"error": "Room not found."})
    room.touch()
    return {"code": room.id}


@app.get("/api/rooms")
async def api_list_rooms():
    """List active rooms (for admin debugging)."""
    return {
        "rooms": [
            {"code": r.id, "active": r.active, "created": r.created_at,
             "last_activity": r.last_activity, "effect": r.current_effect}
            for r in rooms.values()
        ]
    }


# ---------------------------------------------------------------------------
# Room-scoped REST API
# ---------------------------------------------------------------------------
class ActiveRequest(BaseModel):
    active: bool

class EffectRequest(BaseModel):
    effect: str

class ToneRequest(BaseModel):
    value: float

class FrameRequest(BaseModel):
    frame: str  # base64-encoded JPEG
    client_id: str = ""  # source client identifier


class RegisterRequest(BaseModel):
    client_id: str
    role: str
    label: str = ""

class HeartbeatRequest(BaseModel):
    client_id: str

class SetSourceRequest(BaseModel):
    client_id: str

class UnregisterRequest(BaseModel):
    client_id: str


@app.get("/room/{code}/api/status")
async def room_status(code: str):
    room = get_room(code)
    if not room:
        return JSONResponse(status_code=404, content={"error": "Room not found"})
    room.touch()
    return {
        "active": room.active,
        "effect": room.current_effect,
        "tone": room.tone_value,
        "description": room.latest_description,
        "description_timestamp": room.description_timestamp,
    }


@app.get("/room/{code}/api/active")
async def room_get_active(code: str):
    room = get_room(code)
    if not room:
        return JSONResponse(status_code=404, content={"error": "Room not found"})
    return {"active": room.active}


@app.post("/room/{code}/api/active")
async def room_set_active(code: str, req: ActiveRequest):
    room = get_room(code)
    if not room:
        return JSONResponse(status_code=404, content={"error": "Room not found"})
    room.active = req.active
    room.touch()
    log.info(f"[{code}] Pipeline {'STARTED' if req.active else 'STOPPED'}")

    # Start or stop analysis loop
    if req.active and (room._analysis_task is None or room._analysis_task.done()):
        room._analysis_task = asyncio.create_task(_analysis_loop(room))
    elif not req.active and room._analysis_task and not room._analysis_task.done():
        room._analysis_task.cancel()

    return {"active": room.active}


@app.get("/room/{code}/api/effect")
async def room_get_effect(code: str):
    room = get_room(code)
    if not room:
        return JSONResponse(status_code=404, content={"error": "Room not found"})
    return {"effect": room.current_effect}


@app.post("/room/{code}/api/effect")
async def room_set_effect(code: str, req: EffectRequest):
    room = get_room(code)
    if not room:
        return JSONResponse(status_code=404, content={"error": "Room not found"})
    if req.effect not in VALID_EFFECTS:
        return JSONResponse(status_code=400, content={
            "error": f"Invalid effect. Choose from: {VALID_EFFECTS}"
        })
    room.current_effect = req.effect
    room.touch()
    log.info(f"[{code}] Effect: {req.effect}")
    return {"effect": req.effect}


@app.get("/room/{code}/api/tone")
async def room_get_tone(code: str):
    room = get_room(code)
    if not room:
        return JSONResponse(status_code=404, content={"error": "Room not found"})
    return {"value": room.tone_value}


@app.post("/room/{code}/api/tone")
async def room_set_tone(code: str, req: ToneRequest):
    room = get_room(code)
    if not room:
        return JSONResponse(status_code=404, content={"error": "Room not found"})
    value = max(0.0, min(1.0, req.value))
    room.tone_value = value
    room.tone_preamble = build_tone_preamble(value)
    room.touch()
    log.info(f"[{code}] Tone: {value:.2f}")
    return {"value": value}


# ---------------------------------------------------------------------------
# Client management API
# ---------------------------------------------------------------------------
@app.post("/room/{code}/api/register")
async def room_register_client(code: str, req: RegisterRequest):
    room = get_room(code)
    if not room:
        return JSONResponse(status_code=404, content={"error": "Room not found"})
    if req.role not in ("controller", "worker"):
        return JSONResponse(status_code=400, content={"error": "Invalid role"})
    client = register_client(room, req.client_id, req.role, req.label)
    room.touch()
    return {
        "ok": True,
        "is_source": client.id == room.active_source_client_id,
        "clients": get_client_list(room),
    }


@app.post("/room/{code}/api/heartbeat")
async def room_heartbeat(code: str, req: HeartbeatRequest):
    room = get_room(code)
    if not room:
        return JSONResponse(status_code=404, content={"error": "Room not found"})
    found = heartbeat_client(room, req.client_id)
    if not found:
        return JSONResponse(status_code=404, content={"error": "Client not found"})
    room.touch()
    return {"ok": True}


@app.post("/room/{code}/api/set-source")
async def room_set_source(code: str, req: SetSourceRequest):
    room = get_room(code)
    if not room:
        return JSONResponse(status_code=404, content={"error": "Room not found"})
    ok = set_active_source(room, req.client_id)
    if not ok:
        return JSONResponse(status_code=404, content={"error": "Client not found"})
    room.touch()
    return {"ok": True, "clients": get_client_list(room)}


@app.post("/room/{code}/api/unregister")
async def room_unregister_client(code: str, req: Request):
    room = get_room(code)
    if not room:
        return JSONResponse(status_code=404, content={"error": "Room not found"})
    try:
        body = await req.json()
        client_id = body.get("client_id", "")
    except Exception:
        # sendBeacon may send text/plain; attempt raw body parse
        try:
            raw = await req.body()
            body = json.loads(raw)
            client_id = body.get("client_id", "")
        except Exception:
            return JSONResponse(status_code=400, content={"error": "Invalid body"})
    if client_id:
        unregister_client(room, client_id)
    return {"ok": True}


# ---------------------------------------------------------------------------
# Frame upload (controller -> server)
# ---------------------------------------------------------------------------
@app.post("/room/{code}/api/frame")
async def room_upload_frame(code: str, req: FrameRequest):
    room = get_room(code)
    if not room:
        return JSONResponse(status_code=404, content={"error": "Room not found"})

    # Reject frames from non-source clients
    if room.active_source_client_id:
        if not req.client_id or req.client_id != room.active_source_client_id:
            return JSONResponse(status_code=403, content={"error": "Not the active source"})

    try:
        # Strip data URL prefix if present
        frame_data = req.frame
        if "," in frame_data:
            frame_data = frame_data.split(",", 1)[1]
        jpeg_bytes = base64.b64decode(frame_data)
        room.latest_frame_jpeg = jpeg_bytes
        room.frame_timestamp = time.time()
        room.touch()
        return {"ok": True}
    except Exception as e:
        return JSONResponse(status_code=400, content={"error": str(e)})


# ---------------------------------------------------------------------------
# MJPEG stream (server -> worker)
# ---------------------------------------------------------------------------
async def _mjpeg_generator(room: Room):
    """Yield MJPEG frames from a room's latest frame."""
    last_frame = None
    while True:
        jpeg = room.latest_frame_jpeg
        if jpeg is not None and jpeg is not last_frame:
            last_frame = jpeg
            yield (
                b"--frame\r\n"
                b"Content-Type: image/jpeg\r\n\r\n"
                + jpeg
                + b"\r\n"
            )
        await asyncio.sleep(0.05)  # ~20fps max


@app.get("/room/{code}/stream")
async def room_video_stream(code: str):
    room = get_room(code)
    if not room:
        return JSONResponse(status_code=404, content={"error": "Room not found"})
    room.touch()
    return StreamingResponse(
        _mjpeg_generator(room),
        media_type="multipart/x-mixed-replace; boundary=frame",
    )


# ---------------------------------------------------------------------------
# SSE events (server -> controller + worker)
# ---------------------------------------------------------------------------
async def _sse_generator(room: Room):
    """Push state changes as Server-Sent Events for a room."""
    last_description = ""
    last_desc_time = 0.0
    last_effect = ""
    last_tone = -1.0
    last_active = None
    last_lyrics = ""
    last_lyrics_time = 0.0
    last_clients_version = -1
    emitted_audio_keys: set = set()

    while True:
        events = []

        active = room.active
        desc = room.latest_description
        desc_time = room.description_timestamp
        effect = room.current_effect
        tone = room.tone_value
        lyrics = room.lyrics_line
        lyrics_time = room.lyrics_timestamp
        clients_version = room._clients_version

        if active != last_active:
            last_active = active
            events.append(("active", json.dumps({"active": active})))

        if desc != last_description or desc_time != last_desc_time:
            last_description = desc
            last_desc_time = desc_time
            events.append(("description", json.dumps({
                "text": desc, "timestamp": desc_time, "tone": tone,
            })))

        if effect != last_effect:
            last_effect = effect
            events.append(("effect", json.dumps({"effect": effect})))

        if tone != last_tone:
            last_tone = tone
            events.append(("tone", json.dumps({"value": tone})))

        if lyrics != last_lyrics or lyrics_time != last_lyrics_time:
            last_lyrics = lyrics
            last_lyrics_time = lyrics_time
            if lyrics:
                events.append(("lyrics", json.dumps({"text": lyrics})))

        if clients_version != last_clients_version:
            last_clients_version = clients_version
            events.append(("clients", json.dumps({
                "clients": get_client_list(room),
                "active_source": room.active_source_client_id,
            })))

        # Emit audio events for any new audio files (decoupled from description timing)
        for audio_ts in list(room.audio_files.keys()):
            if audio_ts not in emitted_audio_keys:
                emitted_audio_keys.add(audio_ts)
                # Determine if this is description audio or robotic lyrics audio
                if audio_ts == room.lyrics_timestamp and room.lyrics_line:
                    events.append(("audio_robotic", json.dumps({
                        "url": f"/room/{room.id}/audio/{audio_ts}",
                    })))
                else:
                    events.append(("audio", json.dumps({
                        "url": f"/room/{room.id}/audio/{audio_ts}",
                        "timestamp": audio_ts,
                    })))

        # Clean up stale keys from emitted set
        if len(emitted_audio_keys) > 100:
            current_keys = set(room.audio_files.keys())
            emitted_audio_keys &= current_keys

        for event_type, data in events:
            yield f"event: {event_type}\ndata: {data}\n\n"

        await asyncio.sleep(0.2)


@app.get("/room/{code}/events")
async def room_sse_events(code: str):
    room = get_room(code)
    if not room:
        return JSONResponse(status_code=404, content={"error": "Room not found"})
    room.touch()
    return StreamingResponse(
        _sse_generator(room),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


# ---------------------------------------------------------------------------
# Audio serving
# ---------------------------------------------------------------------------
@app.get("/room/{code}/audio/{audio_id}")
async def room_audio(code: str, audio_id: str):
    room = get_room(code)
    if not room:
        return JSONResponse(status_code=404, content={"error": "Room not found"})

    try:
        ts = float(audio_id.replace(".mp3", ""))
    except ValueError:
        return JSONResponse(status_code=400, content={"error": "Invalid audio ID"})

    mp3_bytes = room.audio_files.get(ts)
    if not mp3_bytes:
        return JSONResponse(status_code=404, content={"error": "Audio not found"})

    return Response(content=mp3_bytes, media_type="audio/mpeg")


# ---------------------------------------------------------------------------
# Per-room analysis loop (async background task)
# ---------------------------------------------------------------------------
async def _analysis_loop(room: Room):
    """Background task: analyze frames from controller, generate TTS, broadcast via SSE."""
    code = room.id
    interval = config.get("timing", {}).get("analysis_interval", 3)
    log.info(f"[{code}] Analysis loop started (interval={interval}s)")

    consecutive_failures = 0
    max_failures = 5

    try:
        while room.active:
            cycle_start = time.time()

            # Wait for a frame
            if room.latest_frame_jpeg is None:
                await asyncio.sleep(0.5)
                continue

            jpeg_bytes = room.latest_frame_jpeg

            if room.gemini is None:
                log.warning(f"[{code}] No Gemini instance, skipping analysis")
                await asyncio.sleep(interval)
                continue

            try:
                # Run Gemini call in thread pool (it's synchronous)
                narration = await asyncio.get_event_loop().run_in_executor(
                    None,
                    room.gemini.describe_and_narrate,
                    jpeg_bytes,
                    room.tone_preamble,
                )
                consecutive_failures = 0

                if narration is not None:
                    room.latest_description = narration
                    room.description_timestamp = time.time()
                    room.cycle_count += 1

                    # Generate TTS audio
                    mp3_bytes = await generate_speech(narration)
                    if mp3_bytes:
                        audio_ts = room.description_timestamp
                        room.audio_files[audio_ts] = mp3_bytes

                    # Every 4th cycle in judgmental mode: robotic lyrics
                    if room.cycle_count % 4 == 0 and room.tone_value >= 0.75:
                        line = FITTER_HAPPIER_LYRICS[room.lyrics_index % len(FITTER_HAPPIER_LYRICS)]
                        room.lyrics_index += 1
                        room.lyrics_line = line
                        room.lyrics_timestamp = time.time()

                        spoken = line.replace("\n", " ")
                        robotic_bytes = await generate_robotic_speech(spoken)
                        if robotic_bytes:
                            robotic_ts = room.lyrics_timestamp
                            room.audio_files[robotic_ts] = robotic_bytes

            except asyncio.CancelledError:
                raise
            except Exception as e:
                consecutive_failures += 1
                error_str = str(e)

                retry_delay = _extract_retry_delay(error_str)
                if retry_delay and consecutive_failures < max_failures:
                    log.warning(f"[{code}] Rate limited. Waiting {retry_delay:.0f}s ({consecutive_failures}/{max_failures})")
                    await asyncio.sleep(retry_delay)
                    continue

                log.warning(f"[{code}] Vision error ({consecutive_failures}/{max_failures}): {e}")

                if consecutive_failures >= max_failures:
                    log.error(f"[{code}] Too many failures, pausing analysis for 30s")
                    consecutive_failures = 0
                    await asyncio.sleep(30)

            # Sleep remaining interval
            elapsed = time.time() - cycle_start
            remaining = interval - elapsed
            if remaining > 0:
                await asyncio.sleep(remaining)

    except asyncio.CancelledError:
        log.info(f"[{code}] Analysis loop cancelled")
    except Exception as e:
        log.error(f"[{code}] Analysis loop error: {e}", exc_info=True)
    finally:
        log.info(f"[{code}] Analysis loop stopped")


def _extract_retry_delay(error_str: str) -> float | None:
    """Extract retry delay in seconds from a Gemini 429 error message."""
    match = re.search(r"retry[_ ]?[iI]n[:\s'\"]*(\d+\.?\d*)\s*s", error_str, re.IGNORECASE)
    if match:
        return min(float(match.group(1)), 60.0)
    match = re.search(r"retryDelay['\"]?\s*:\s*['\"]?(\d+)", error_str, re.IGNORECASE)
    if match:
        return min(float(match.group(1)), 60.0)
    if "429" in error_str or "RESOURCE_EXHAUSTED" in error_str:
        return 30.0
    return None


# ---------------------------------------------------------------------------
# Run with uvicorn when executed directly
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=7860, log_level="info")
