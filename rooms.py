"""
rooms.py — Room system for multi-user PANOPTICUM on HuggingFace Spaces.

Each room has its own state, Gemini vision instance, analysis loop, and TTS generation.
Rooms are created by admin and accessed via room codes.
"""

import asyncio
import logging
import os
import random
import string
import time
from dataclasses import dataclass, field

from tone import build_tone_preamble
from vision import GeminiVision

log = logging.getLogger("panopticum.rooms")

MAX_ROOMS = 5
ROOM_EXPIRY_SECONDS = 30 * 60  # 30 minutes of inactivity

ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "admin")


def _generate_code() -> str:
    """Generate a room code like PANOPT-7X3K."""
    chars = string.ascii_uppercase + string.digits
    suffix = "".join(random.choices(chars, k=4))
    return f"PANOPT-{suffix}"


@dataclass
class Room:
    id: str
    created_at: float
    last_activity: float

    # Control state
    active: bool = False
    current_effect: str = "natural"
    tone_value: float = 0.5
    tone_preamble: str = field(default="")

    # Frame relay (controller -> exhibition)
    latest_frame_jpeg: bytes | None = None
    frame_timestamp: float = 0.0

    # AI state
    gemini: GeminiVision | None = None
    latest_description: str = ""
    description_timestamp: float = 0.0
    cycle_count: int = 0
    lyrics_index: int = 0
    lyrics_line: str = ""
    lyrics_timestamp: float = 0.0

    # Audio files: timestamp -> mp3 bytes
    audio_files: dict = field(default_factory=dict)

    # Background task reference
    _analysis_task: asyncio.Task | None = field(default=None, repr=False)

    def touch(self):
        """Update last activity timestamp."""
        self.last_activity = time.time()


# Global room registry
rooms: dict[str, Room] = {}


def create_room(password: str, config: dict) -> Room | None:
    """Create a new room if admin password is correct and capacity allows."""
    if password != ADMIN_PASSWORD:
        return None

    if len(rooms) >= MAX_ROOMS:
        return None

    # Generate unique code
    code = _generate_code()
    while code in rooms:
        code = _generate_code()

    now = time.time()

    # Create per-room Gemini instance
    gemini = _create_gemini(config)

    # Initialize tone preamble
    tone_preamble = build_tone_preamble(0.5)

    room = Room(
        id=code,
        created_at=now,
        last_activity=now,
        tone_preamble=tone_preamble,
        gemini=gemini,
    )
    rooms[code] = room
    log.info(f"Room created: {code} ({len(rooms)}/{MAX_ROOMS})")
    return room


def get_room(code: str) -> Room | None:
    """Get a room by code, or None if not found."""
    return rooms.get(code)


def delete_room(code: str):
    """Delete a room and cancel its background task."""
    room = rooms.pop(code, None)
    if room and room._analysis_task:
        room._analysis_task.cancel()
    if room:
        log.info(f"Room deleted: {code}")


def cleanup_expired():
    """Remove rooms that have been inactive for too long."""
    now = time.time()
    expired = [
        code for code, room in rooms.items()
        if now - room.last_activity > ROOM_EXPIRY_SECONDS
    ]
    for code in expired:
        delete_room(code)
    if expired:
        log.info(f"Expired {len(expired)} room(s): {expired}")


def _create_gemini(config: dict) -> GeminiVision | None:
    """Create a GeminiVision instance for a room."""
    try:
        return GeminiVision(config)
    except Exception as e:
        log.error(f"Failed to create GeminiVision: {e}")
        return None
