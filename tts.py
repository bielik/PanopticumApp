"""
tts.py — Text-to-Speech interface.

Converts AI descriptions into spoken audio.
Supports edge-tts (free Microsoft cloud) and pyttsx3 (offline fallback).
"""

import asyncio
import logging
import os
import tempfile
import time

import pygame

log = logging.getLogger("panopticum.tts")


def create_tts_backend(config):
    """Factory: return the right TTS backend based on config."""
    backend = config["tts"]["backend"]
    if backend == "edge-tts":
        return EdgeTTSBackend(config)
    elif backend == "pyttsx3":
        return Pyttsx3Backend(config)
    else:
        raise ValueError(f"Unknown TTS backend: {backend}")


class EdgeTTSBackend:
    """Free cloud TTS using Microsoft Edge's speech service."""

    def __init__(self, config):
        cfg = config["tts"]["edge_tts"]
        self.voice = cfg["voice"]
        self.rate = cfg["rate"]
        self.volume = cfg["volume"]
        self.pitch = cfg["pitch"]

        # Initialize pygame mixer for audio playback
        if not pygame.mixer.get_init():
            pygame.mixer.init()

        log.info(f"EdgeTTS initialized: voice={self.voice}")

    def speak(self, text: str):
        """Generate speech and play it. Blocks until playback finishes."""
        import edge_tts

        # Create a temp file for the audio
        fd, temp_path = tempfile.mkstemp(suffix=".mp3")
        os.close(fd)

        try:
            # edge-tts is async — run in a fresh event loop
            log.info(f"Generating speech: {text[:60]}...")
            asyncio.run(self._generate(edge_tts, text, temp_path))

            file_size = os.path.getsize(temp_path)
            log.info(f"Audio file generated: {file_size} bytes")

            if file_size == 0:
                log.warning("Empty audio file generated, skipping playback")
                return

            # Re-init mixer if needed (use 0 for auto-detect frequency)
            if not pygame.mixer.get_init():
                pygame.mixer.init()

            # Play the audio
            pygame.mixer.music.load(temp_path)
            pygame.mixer.music.play()
            log.info("Playing audio...")
            while pygame.mixer.music.get_busy():
                time.sleep(0.1)
            pygame.mixer.music.unload()
            log.info("Audio playback finished")

        except Exception as e:
            log.error(f"EdgeTTS speak error: {e}", exc_info=True)
        finally:
            # Clean up temp file
            try:
                os.unlink(temp_path)
            except OSError:
                pass

    async def _generate(self, edge_tts, text: str, output_path: str):
        """Async helper to generate the audio file."""
        communicate = edge_tts.Communicate(
            text,
            self.voice,
            rate=self.rate,
            volume=self.volume,
            pitch=self.pitch,
        )
        await communicate.save(output_path)

    def speak_robotic(self, text: str):
        """Speak with a robotic female voice. Blocks until playback finishes."""
        import edge_tts

        fd, temp_path = tempfile.mkstemp(suffix=".mp3")
        os.close(fd)

        try:
            log.info(f"Generating robotic speech: {text[:60]}...")
            asyncio.run(self._generate_robotic(edge_tts, text, temp_path))

            file_size = os.path.getsize(temp_path)
            if file_size == 0:
                log.warning("Empty robotic audio file, skipping")
                return

            if not pygame.mixer.get_init():
                pygame.mixer.init()

            pygame.mixer.music.load(temp_path)
            pygame.mixer.music.play()
            while pygame.mixer.music.get_busy():
                time.sleep(0.1)
            pygame.mixer.music.unload()

        except Exception as e:
            log.error(f"Robotic TTS error: {e}", exc_info=True)
        finally:
            try:
                os.unlink(temp_path)
            except OSError:
                pass

    async def _generate_robotic(self, edge_tts, text: str, output_path: str):
        """Generate audio with a robotic female voice."""
        communicate = edge_tts.Communicate(
            text,
            "en-US-JennyNeural",
            rate="-25%",
            volume="+0%",
            pitch="-15Hz",
        )
        await communicate.save(output_path)


class Pyttsx3Backend:
    """Offline TTS using Windows SAPI5 voices."""

    def __init__(self, config):
        import pyttsx3

        cfg = config["tts"]["pyttsx3"]
        self.engine = pyttsx3.init()
        self.engine.setProperty("rate", cfg["rate"])
        self.engine.setProperty("volume", cfg["volume"])
        log.info("Pyttsx3 initialized")

    def speak(self, text: str):
        """Speak text. Blocks until done."""
        try:
            self.engine.say(text)
            self.engine.runAndWait()
        except Exception as e:
            log.error(f"Pyttsx3 speak error: {e}")
            raise
