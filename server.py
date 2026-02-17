"""
server.py — FastAPI web server for PANOPTICUM.

Serves MJPEG video stream, SSE events, REST API for controls,
and HTML pages for control and exhibition modes.
"""

import asyncio
import json
import logging
import time

from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from pydantic import BaseModel

from tone import build_tone_preamble

log = logging.getLogger("panopticum.server")

app = FastAPI(title="PANOPTICUM")
app.mount("/static", StaticFiles(directory="static"), name="static")
templates = Jinja2Templates(directory="templates")

# These are set by main.py before uvicorn starts
state = None
config = None

VALID_EFFECTS = ["original", "cctv", "nightvision", "noir"]


# ---------------------------------------------------------------------------
# Pages
# ---------------------------------------------------------------------------
@app.get("/", response_class=HTMLResponse)
async def control_page(request: Request):
    """Control page — video + overlay + controls."""
    return templates.TemplateResponse("control.html", {
        "request": request,
        "effects": VALID_EFFECTS,
    })


@app.get("/exhibit", response_class=HTMLResponse)
async def exhibit_page(request: Request):
    """Exhibition page — fullscreen video + overlay, no controls."""
    return templates.TemplateResponse("exhibit.html", {"request": request})


# ---------------------------------------------------------------------------
# MJPEG stream
# ---------------------------------------------------------------------------
async def _mjpeg_generator():
    """Yield MJPEG frames from shared state."""
    while True:
        jpeg = None
        with state.lock:
            jpeg = state.display_frame_jpeg

        if jpeg is not None:
            yield (
                b"--frame\r\n"
                b"Content-Type: image/jpeg\r\n\r\n"
                + jpeg
                + b"\r\n"
            )

        await asyncio.sleep(0.03)  # ~33fps


@app.get("/stream")
async def video_stream():
    """MJPEG video stream endpoint."""
    return StreamingResponse(
        _mjpeg_generator(),
        media_type="multipart/x-mixed-replace; boundary=frame",
    )


# ---------------------------------------------------------------------------
# SSE events
# ---------------------------------------------------------------------------
async def _sse_generator():
    """Push state changes as Server-Sent Events."""
    last_description = ""
    last_speaking = False
    last_effect = ""
    last_tone = -1.0
    last_active = None

    while True:
        events = []

        with state.lock:
            desc = state.latest_description
            desc_time = state.description_timestamp
            speaking = state.is_speaking
            effect = state.current_effect
            tone = state.tone_value
            active = state.active

        if active != last_active:
            last_active = active
            events.append(("active", json.dumps({"active": active})))

        if desc != last_description:
            last_description = desc
            events.append(("description", json.dumps({
                "text": desc,
                "timestamp": desc_time,
            })))

        if speaking != last_speaking:
            last_speaking = speaking
            events.append(("speaking", json.dumps({"speaking": speaking})))

        if effect != last_effect:
            last_effect = effect
            events.append(("effect", json.dumps({"effect": effect})))

        if tone != last_tone:
            last_tone = tone
            events.append(("tone", json.dumps({"value": tone})))

        for event_type, data in events:
            yield f"event: {event_type}\ndata: {data}\n\n"

        await asyncio.sleep(0.2)  # 5Hz


@app.get("/events")
async def sse_events():
    """Server-Sent Events endpoint for real-time state updates."""
    return StreamingResponse(
        _sse_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


# ---------------------------------------------------------------------------
# REST API
# ---------------------------------------------------------------------------
class ActiveRequest(BaseModel):
    active: bool


class EffectRequest(BaseModel):
    effect: str


class ToneRequest(BaseModel):
    value: float


@app.get("/api/active")
async def get_active():
    """Get current active (running pipeline) state."""
    with state.lock:
        return {"active": state.active}


@app.post("/api/active")
async def set_active(req: ActiveRequest):
    """Start or stop the camera + analysis + TTS pipeline."""
    with state.lock:
        state.active = req.active
    log.info(f"Pipeline {'STARTED' if req.active else 'STOPPED'}")
    return {"active": req.active}


@app.get("/api/effect")
async def get_effect():
    """Get current video effect."""
    with state.lock:
        return {"effect": state.current_effect}


@app.post("/api/effect")
async def set_effect(req: EffectRequest):
    """Set video effect."""
    if req.effect not in VALID_EFFECTS:
        return JSONResponse(
            status_code=400,
            content={"error": f"Invalid effect. Choose from: {VALID_EFFECTS}"},
        )
    with state.lock:
        state.current_effect = req.effect
    log.info(f"Effect changed to: {req.effect}")
    return {"effect": req.effect}


@app.get("/api/tone")
async def get_tone():
    """Get current tone value."""
    with state.lock:
        return {"value": state.tone_value}


@app.post("/api/tone")
async def set_tone(req: ToneRequest):
    """Set tone value (0.0–1.0)."""
    value = max(0.0, min(1.0, req.value))
    preamble = build_tone_preamble(value)
    with state.lock:
        state.tone_value = value
        state.tone_preamble = preamble
    log.info(f"Tone changed to: {value:.2f}")
    return {"value": value}


@app.get("/api/status")
async def get_status():
    """Full status snapshot."""
    with state.lock:
        return {
            "active": state.active,
            "effect": state.current_effect,
            "tone": state.tone_value,
            "description": state.latest_description,
            "description_timestamp": state.description_timestamp,
            "speaking": state.is_speaking,
            "running": state.running,
        }
