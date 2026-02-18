"""
tts.py — Text-to-Speech for server-side MP3 generation.

Generates MP3 bytes using edge-tts. No local playback — audio is served
to the worker page via HTTP for browser-side playback.
"""

import logging

import edge_tts

log = logging.getLogger("panopticum.tts")


# Tone-specific voices (supportive → neutral → judgmental)
TONE_VOICES = {
    "supportive": {"voice": "en-AU-WilliamNeural", "rate": "-15%", "pitch": "-15Hz"},
    "neutral":    {"voice": "en-GB-SoniaNeural",    "rate": "-15%", "pitch": "-15Hz"},
    "judgmental": {"voice": "en-US-GuyNeural",       "rate": "-15%", "pitch": "-15Hz"},
}
DEFAULT_VOLUME = "+0%"

# Robotic voice for Fitter Happier lyrics
ROBOTIC_VOICE = "en-US-JennyNeural"
ROBOTIC_RATE = "-25%"
ROBOTIC_VOLUME = "+0%"
ROBOTIC_PITCH = "-15Hz"


def _voice_for_tone(tone_value: float) -> dict:
    """Pick voice settings based on tone slider value."""
    if tone_value <= 0.25:
        return TONE_VOICES["supportive"]
    if tone_value <= 0.75:
        return TONE_VOICES["neutral"]
    return TONE_VOICES["judgmental"]


async def generate_speech(text: str, tone_value: float = 0.5) -> bytes:
    """Generate MP3 bytes from text using edge-tts. Returns bytes or empty."""
    try:
        v = _voice_for_tone(tone_value)
        communicate = edge_tts.Communicate(
            text,
            v["voice"],
            rate=v["rate"],
            volume=DEFAULT_VOLUME,
            pitch=v["pitch"],
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
