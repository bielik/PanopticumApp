"""
tts.py — Text-to-Speech for server-side MP3 generation.

Generates MP3 bytes using edge-tts. No local playback — audio is served
to the exhibition page via HTTP for browser-side playback.
"""

import logging

import edge_tts

log = logging.getLogger("panopticum.tts")


# Default voice settings (match config.yaml edge_tts section)
DEFAULT_VOICE = "en-US-GuyNeural"
DEFAULT_RATE = "-15%"
DEFAULT_VOLUME = "+0%"
DEFAULT_PITCH = "-15Hz"

# Robotic voice for Fitter Happier lyrics
ROBOTIC_VOICE = "en-US-JennyNeural"
ROBOTIC_RATE = "-25%"
ROBOTIC_VOLUME = "+0%"
ROBOTIC_PITCH = "-15Hz"


async def generate_speech(text: str) -> bytes:
    """Generate MP3 bytes from text using edge-tts. Returns bytes or empty."""
    try:
        communicate = edge_tts.Communicate(
            text,
            DEFAULT_VOICE,
            rate=DEFAULT_RATE,
            volume=DEFAULT_VOLUME,
            pitch=DEFAULT_PITCH,
        )
        chunks = []
        async for chunk in communicate.stream():
            if chunk["type"] == "audio":
                chunks.append(chunk["data"])
        mp3_bytes = b"".join(chunks)
        log.info(f"Generated speech: {len(mp3_bytes)} bytes for '{text[:60]}'")
        return mp3_bytes
    except Exception as e:
        log.error(f"TTS generation error: {e}")
        return b""


async def generate_robotic_speech(text: str) -> bytes:
    """Generate MP3 bytes with robotic female voice for lyrics."""
    try:
        communicate = edge_tts.Communicate(
            text,
            ROBOTIC_VOICE,
            rate=ROBOTIC_RATE,
            volume=ROBOTIC_VOLUME,
            pitch=ROBOTIC_PITCH,
        )
        chunks = []
        async for chunk in communicate.stream():
            if chunk["type"] == "audio":
                chunks.append(chunk["data"])
        mp3_bytes = b"".join(chunks)
        log.info(f"Generated robotic speech: {len(mp3_bytes)} bytes")
        return mp3_bytes
    except Exception as e:
        log.error(f"Robotic TTS error: {e}")
        return b""
