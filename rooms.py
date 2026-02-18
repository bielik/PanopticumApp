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
CLIENT_STALE_SECONDS = 15


ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "admin")


def _generate_code() -> str:
    """Generate a room code like PANOPT-7X3K."""
    chars = string.ascii_uppercase + string.digits
    suffix = "".join(random.choices(chars, k=4))
    return f"PANOPT-{suffix}"


@dataclass
class Client:
    id: str                     # UUID from browser sessionStorage
    role: str                   # "controller" or "worker"
    label: str = ""             # e.g. "Controller (Win32)"
    last_heartbeat: float = 0.0


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

    # Frame relay (controller -> worker)
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

    # Client management
    clients: dict[str, Client] = field(default_factory=dict)
    active_source_client_id: str | None = None
    _clients_version: int = 0

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


# ---------------------------------------------------------------------------
# Client management
# ---------------------------------------------------------------------------

def register_client(room: Room, client_id: str, role: str, label: str = "") -> Client:
    """Register a client in the room. Auto-assigns first controller as source."""
    now = time.time()
    client = Client(id=client_id, role=role, label=label, last_heartbeat=now)
    room.clients[client_id] = client
    room._clients_version += 1

    # Auto-assign source if none set and this is a controller
    if room.active_source_client_id is None and role == "controller":
        room.active_source_client_id = client_id
        log.info(f"[{room.id}] Auto-assigned source to {client_id}")

    log.info(f"[{room.id}] Client registered: {client_id} ({role}) — {len(room.clients)} connected")
    return client


def heartbeat_client(room: Room, client_id: str) -> bool:
    """Update heartbeat timestamp. Returns False if client not found."""
    client = room.clients.get(client_id)
    if not client:
        return False
    client.last_heartbeat = time.time()
    return True


def unregister_client(room: Room, client_id: str):
    """Remove a client. Clears source if it was the removed client."""
    removed = room.clients.pop(client_id, None)
    if not removed:
        return
    room._clients_version += 1

    if room.active_source_client_id == client_id:
        room.active_source_client_id = None
        # Auto-assign to first remaining controller
        for cid, c in room.clients.items():
            if c.role == "controller":
                room.active_source_client_id = cid
                log.info(f"[{room.id}] Source re-assigned to {cid}")
                break

    log.info(f"[{room.id}] Client unregistered: {client_id} — {len(room.clients)} remaining")


def cleanup_stale_clients(room: Room):
    """Remove clients with no heartbeat for CLIENT_STALE_SECONDS."""
    now = time.time()
    stale = [
        cid for cid, c in room.clients.items()
        if now - c.last_heartbeat > CLIENT_STALE_SECONDS
    ]
    for cid in stale:
        unregister_client(room, cid)
    if stale:
        log.info(f"[{room.id}] Cleaned up {len(stale)} stale client(s)")


def set_active_source(room: Room, client_id: str) -> bool:
    """Designate a client as the video source. Returns False if client not found."""
    if client_id not in room.clients:
        return False
    room.active_source_client_id = client_id
    room._clients_version += 1
    log.info(f"[{room.id}] Source set to {client_id}")
    return True


def get_client_list(room: Room) -> list[dict]:
    """Return serializable list of clients for SSE/API."""
    return [
        {
            "id": c.id,
            "role": c.role,
            "label": c.label,
            "is_source": c.id == room.active_source_client_id,
        }
        for c in room.clients.values()
    ]


def _create_gemini(config: dict) -> GeminiVision | None:
    """Create a GeminiVision instance for a room."""
    try:
        return GeminiVision(config)
    except Exception as e:
        log.error(f"Failed to create GeminiVision: {e}")
        return None
