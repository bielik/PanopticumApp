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
    frequency_for_tone, get_client_list, get_room, heartbeat_client,
    register_client, rooms, unregister_client,
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

class UnregisterRequest(BaseModel):
    client_id: str

class ActionSettingRequest(BaseModel):
    setting: str  # "automatic" or "manual"

class FrequencyRequest(BaseModel):
    value: float

class CommentLengthRequest(BaseModel):
    value: int

class HeatStrengthRequest(BaseModel):
    value: float


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
        "frequency": room.analysis_interval,
        "comment_length": room.comment_length,
        "description": room.latest_description,
        "description_timestamp": room.description_timestamp,
        "description_type": room.description_type,
        "action_setting": room.action_setting,
        "action_phase": room.action_phase,
        "action_requested": room.action_requested,
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

    # Reset action state on start
    if req.active:
        room.action_last_comment_time = time.time()
        room.action_phase = "commenting"
        room.action_requested = ""
        room._action_phase_version += 1

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
    # Auto-reset frequency to tone default
    room.analysis_interval = frequency_for_tone(value)
    room._frequency_version += 1
    room.touch()
    log.info(f"[{code}] Tone: {value:.2f}, frequency auto-set to {room.analysis_interval}s")
    return {"value": value}


@app.post("/room/{code}/api/frequency")
async def room_set_frequency(code: str, req: FrequencyRequest):
    room = get_room(code)
    if not room:
        return JSONResponse(status_code=404, content={"error": "Room not found"})
    value = max(3.0, min(600.0, req.value))
    room.analysis_interval = value
    room._frequency_version += 1
    room.touch()
    log.info(f"[{code}] Frequency: {value:.0f}s")
    return {"value": value}


@app.post("/room/{code}/api/comment-length")
async def room_set_comment_length(code: str, req: CommentLengthRequest):
    room = get_room(code)
    if not room:
        return JSONResponse(status_code=404, content={"error": "Room not found"})
    value = max(3, min(50, req.value))
    room.comment_length = value
    room._comment_length_version += 1
    room.touch()
    log.info(f"[{code}] Comment length: {value} words")
    return {"value": value}


@app.post("/room/{code}/api/heat-strength")
async def room_set_heat_strength(code: str, req: HeatStrengthRequest):
    room = get_room(code)
    if not room:
        return JSONResponse(status_code=404, content={"error": "Room not found"})
    value = max(0.1, min(1.0, req.value))
    room.heat_strength = value
    room._heat_strength_version += 1
    room.touch()
    log.info(f"[{code}] Heat strength: {value:.0%}")
    return {"value": value}


# ---------------------------------------------------------------------------
# Action mode API
# ---------------------------------------------------------------------------
@app.post("/room/{code}/api/action-setting")
async def room_set_action_setting(code: str, req: ActionSettingRequest):
    room = get_room(code)
    if not room:
        return JSONResponse(status_code=404, content={"error": "Room not found"})
    if req.setting not in ("automatic", "manual"):
        return JSONResponse(status_code=400, content={"error": "Invalid setting"})
    room.action_setting = req.setting
    if req.setting == "automatic":
        room.action_last_comment_time = time.time()
    room._action_phase_version += 1
    room.touch()
    log.info(f"[{code}] Action setting: {req.setting}")
    return {"setting": req.setting}


@app.post("/room/{code}/api/trigger-action")
async def room_trigger_action(code: str):
    room = get_room(code)
    if not room:
        return JSONResponse(status_code=404, content={"error": "Room not found"})
    if room.action_phase != "commenting":
        return JSONResponse(status_code=400, content={"error": "Action already in progress"})
    if not room.active:
        return JSONResponse(status_code=400, content={"error": "Pipeline not active"})
    room.action_phase = "action_requesting"
    room._action_phase_version += 1
    room.touch()
    log.info(f"[{code}] Action triggered manually")
    return {"ok": True}


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
    if client is None:
        return JSONResponse(status_code=409, content={"error": "room_occupied"})
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
        headers={
            "Cache-Control": "no-cache, no-store, must-revalidate",
            "X-Accel-Buffering": "no",
        },
    )


@app.get("/room/{code}/stream/snapshot")
async def room_video_snapshot(code: str):
    """Return the latest frame as a single JPEG image."""
    room = get_room(code)
    if not room:
        return JSONResponse(status_code=404, content={"error": "Room not found"})
    jpeg = room.latest_frame_jpeg
    if jpeg is None:
        return Response(status_code=204)
    return Response(
        content=jpeg,
        media_type="image/jpeg",
        headers={"Cache-Control": "no-cache, no-store, must-revalidate"},
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
    last_action_phase_version = -1
    last_frequency_version = -1
    last_comment_length_version = -1
    last_heat_strength_version = -1
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
                "text": desc, "timestamp": desc_time, "tone": room.description_tone,
                "type": room.description_type,
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

        action_phase_version = room._action_phase_version
        if action_phase_version != last_action_phase_version:
            last_action_phase_version = action_phase_version
            events.append(("action_phase", json.dumps({
                "setting": room.action_setting,
                "phase": room.action_phase,
                "action": room.action_requested,
            })))

        freq_version = room._frequency_version
        if freq_version != last_frequency_version:
            last_frequency_version = freq_version
            events.append(("frequency", json.dumps({
                "value": room.analysis_interval,
            })))

        cl_version = room._comment_length_version
        if cl_version != last_comment_length_version:
            last_comment_length_version = cl_version
            events.append(("comment_length", json.dumps({
                "value": room.comment_length,
            })))

        hs_version = room._heat_strength_version
        if hs_version != last_heat_strength_version:
            last_heat_strength_version = hs_version
            events.append(("heat_strength", json.dumps({
                "value": room.heat_strength,
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
    log.info(f"[{code}] Analysis loop started (dynamic interval, default={room.analysis_interval}s)")

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
                await asyncio.sleep(room.analysis_interval)
                continue

            try:
                phase = room.action_phase
                log.info(f"[{code}] Cycle start: phase={phase}, elapsed_since_start={time.time() - cycle_start:.1f}s")

                if phase == "commenting":
                    # --- COMMENTING phase (existing behavior) ---
                    t0 = time.time()
                    narration = await asyncio.get_event_loop().run_in_executor(
                        None,
                        room.gemini.describe_and_narrate,
                        jpeg_bytes,
                        room.tone_preamble,
                        room.comment_length,
                    )
                    gemini_time = time.time() - t0
                    log.info(f"[{code}] Gemini describe_and_narrate: {gemini_time:.1f}s -> {'NO_CHANGE' if narration is None else repr(narration[:60])}")

                    if narration is not None:
                        room.description_type = "commentary"
                        room.description_tone = room.tone_value
                        room.latest_description = narration
                        room.description_timestamp = time.time()
                        room.cycle_count += 1

                        t0 = time.time()
                        mp3_bytes = await generate_speech(narration, room.tone_value)
                        tts_time = time.time() - t0
                        log.info(f"[{code}] TTS: {tts_time:.1f}s, {len(mp3_bytes) if mp3_bytes else 0} bytes")
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

                    # Check auto-trigger for action mode
                    if room.action_setting == "automatic" and room.action_last_comment_time > 0:
                        elapsed_since_comment = time.time() - room.action_last_comment_time
                        if elapsed_since_comment >= 60:
                            room.action_phase = "action_requesting"
                            room._action_phase_version += 1
                            log.info(f"[{code}] Action auto-triggered after {elapsed_since_comment:.0f}s")

                elif phase == "action_requesting":
                    # --- ACTION_REQUESTING phase ---
                    t0 = time.time()
                    action_text = await asyncio.get_event_loop().run_in_executor(
                        None,
                        room.gemini.generate_action_request,
                        jpeg_bytes,
                        room.tone_preamble,
                    )
                    gemini_time = time.time() - t0
                    log.info(f"[{code}] Gemini generate_action_request: {gemini_time:.1f}s -> '{action_text}'")

                    room.action_requested = action_text
                    room.action_request_time = time.time()

                    # Push through normal description/audio pipeline
                    room.description_type = "action_request"
                    room.description_tone = room.tone_value
                    room.latest_description = action_text
                    room.description_timestamp = time.time()

                    t0 = time.time()
                    mp3_bytes = await generate_speech(action_text, room.tone_value)
                    tts_time = time.time() - t0
                    log.info(f"[{code}] TTS (action request): {tts_time:.1f}s")
                    if mp3_bytes:
                        audio_ts = room.description_timestamp
                        room.audio_files[audio_ts] = mp3_bytes

                    # Transition to verifying
                    room.action_phase = "action_verifying"
                    room._action_phase_version += 1
                    log.info(f"[{code}] Action requested: '{action_text}' -> verifying")

                elif phase == "action_verifying":
                    # --- ACTION_VERIFYING phase ---
                    elapsed_since_request = time.time() - room.action_request_time

                    t0 = time.time()
                    completed = await asyncio.get_event_loop().run_in_executor(
                        None,
                        room.gemini.verify_action,
                        jpeg_bytes,
                        room.action_requested,
                    )
                    gemini_time = time.time() - t0
                    log.info(f"[{code}] Gemini verify_action: {gemini_time:.1f}s -> {'COMPLETED' if completed else 'NOT_YET'} ({elapsed_since_request:.0f}s since request)")

                    timed_out = elapsed_since_request >= 30

                    if completed or timed_out:
                        t0 = time.time()
                        response_text = await asyncio.get_event_loop().run_in_executor(
                            None,
                            room.gemini.generate_action_response,
                            jpeg_bytes,
                            room.action_requested,
                            completed,
                            room.tone_preamble,
                        )
                        gemini_time = time.time() - t0
                        log.info(f"[{code}] Gemini generate_action_response: {gemini_time:.1f}s -> '{response_text}'")

                        room.description_type = "action_completed" if completed else "action_timeout"
                        room.description_tone = room.tone_value
                        room.latest_description = response_text
                        room.description_timestamp = time.time()

                        t0 = time.time()
                        mp3_bytes = await generate_speech(response_text, room.tone_value)
                        tts_time = time.time() - t0
                        log.info(f"[{code}] TTS (action response): {tts_time:.1f}s")
                        if mp3_bytes:
                            audio_ts = room.description_timestamp
                            room.audio_files[audio_ts] = mp3_bytes

                        reason = "completed" if completed else f"timed out ({elapsed_since_request:.0f}s)"
                        log.info(f"[{code}] Action {reason}: '{room.action_requested}' -> commenting")

                        # Transition back to commenting
                        room.action_phase = "commenting"
                        room.action_requested = ""
                        room.action_last_comment_time = time.time()
                        room._action_phase_version += 1

                consecutive_failures = 0

            except asyncio.CancelledError:
                raise
            except Exception as e:
                consecutive_failures += 1
                error_str = str(e)

                retry_delay = _extract_retry_delay(error_str)
                if retry_delay and consecutive_failures < max_failures:
                    log.warning(f"[{code}] Rate limited. Waiting {retry_delay:.0f}s ({consecutive_failures}/{max_failures}). Error: {error_str[:200]}")
                    await asyncio.sleep(retry_delay)
                    continue

                log.warning(f"[{code}] Vision error ({consecutive_failures}/{max_failures}): {e}")

                if consecutive_failures >= max_failures:
                    log.error(f"[{code}] Too many failures, pausing analysis for 30s")
                    consecutive_failures = 0
                    await asyncio.sleep(30)

            # Sleep remaining interval — wake early if action phase changes
            initial_phase = room.action_phase
            effective_interval = room.analysis_interval if room.action_phase == "commenting" else 3
            cycle_elapsed = time.time() - cycle_start
            remaining = effective_interval - cycle_elapsed
            log.info(f"[{code}] Cycle done: total={cycle_elapsed:.1f}s, sleeping={max(0, remaining):.1f}s")
            while remaining > 0:
                step = min(remaining, 0.3)
                await asyncio.sleep(step)
                remaining -= step
                if room.action_phase != initial_phase:
                    log.info(f"[{code}] Sleep interrupted: phase changed {initial_phase} -> {room.action_phase}")
                    break

    except asyncio.CancelledError:
        log.info(f"[{code}] Analysis loop cancelled")
    except Exception as e:
        log.error(f"[{code}] Analysis loop error: {e}", exc_info=True)
    finally:
        log.info(f"[{code}] Analysis loop stopped")


def _extract_retry_delay(error_str: str) -> float | None:
    """Extract retry delay in seconds from a Gemini 429 error message."""
    # Try to extract explicit retry delay from error message
    match = re.search(r"retry[_ ]?[iI]n[:\s'\"]*(\d+\.?\d*)\s*s", error_str, re.IGNORECASE)
    if match:
        return min(float(match.group(1)), 60.0)
    match = re.search(r"retryDelay['\"]?\s*:\s*['\"]?(\d+)", error_str, re.IGNORECASE)
    if match:
        return min(float(match.group(1)), 60.0)
    # No explicit delay found — use a short retry (paid tiers have high limits)
    if "429" in error_str or "RESOURCE_EXHAUSTED" in error_str:
        return 3.0
    return None


# ---------------------------------------------------------------------------
# Run with uvicorn when executed directly
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=7860, log_level="info")
