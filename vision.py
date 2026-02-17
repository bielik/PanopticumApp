"""
vision.py — Vision model interface.

Sends camera frames to an AI model and gets back scene descriptions.
Supports Ollama (local, free) and Google Gemini (cheap API fallback).
"""

import base64
import logging
import os
import re
import time
from pathlib import Path

import cv2

log = logging.getLogger("panopticum.vision")


def create_vision_backend(config):
    """Factory: return the right vision backend based on config."""
    backend = config["vision"]["backend"]
    if backend == "ollama":
        return OllamaVision(config)
    elif backend == "gemini":
        return GeminiVision(config)
    else:
        raise ValueError(f"Unknown vision backend: {backend}")


def load_prompt(config):
    """Load the prompt template from the configured file."""
    prompt_path = Path(config["prompt"]["file"])
    max_words = config["prompt"]["max_words"]

    if prompt_path.exists():
        template = prompt_path.read_text(encoding="utf-8").strip()
        return template.replace("{max_words}", str(max_words))
    else:
        log.warning(f"Prompt file not found: {prompt_path}. Using default.")
        return (
            f"You are an automated surveillance system. "
            f"Describe what you see in one brief clinical sentence, "
            f"maximum {max_words} words. "
            f"Refer to people as 'subject' or 'individual'. "
            f"Use cold, detached language."
        )


def load_narration_prompt(config):
    """Load the combined vision+narration prompt for Gemini unified mode."""
    narrator_cfg = config.get("narrator", {})
    prompt_path = Path(narrator_cfg.get("prompt_file", "prompts/gemini_surveillance.txt"))

    if prompt_path.exists():
        template = prompt_path.read_text(encoding="utf-8").strip()
        log.info(f"Narration prompt loaded from {prompt_path}")
        return template
    else:
        log.warning(f"Narration prompt not found: {prompt_path}. Using built-in default.")
        return (
            "You are an automated surveillance monitoring system.\n"
            "Previous observations: {history}\n"
            "Last spoken report: {last_spoken}\n"
            "If NOTHING changed, respond: NO_CHANGE\n"
            "Otherwise respond with a 2-5 word surveillance status fragment."
        )


class OllamaVision:
    """Local vision model via Ollama."""

    def __init__(self, config):
        import ollama

        ollama_cfg = config["vision"]["ollama"]
        self.client = ollama.Client(host=ollama_cfg["host"], timeout=ollama_cfg["timeout"])
        self.model = ollama_cfg["model"]
        self.prompt = load_prompt(config)
        log.info(f"OllamaVision initialized: model={self.model}")

    def describe(self, jpeg_bytes: bytes) -> str:
        """Send a JPEG frame to the vision model and return its description."""
        response = self.client.chat(
            model=self.model,
            messages=[
                {
                    "role": "user",
                    "content": self.prompt,
                    "images": [jpeg_bytes],
                }
            ],
        )
        text = response.message.content.strip()
        log.info(f"Ollama: {text}")
        return text


class GeminiVision:
    """Google Gemini API — primary vision backend."""

    def __init__(self, config):
        from google import genai

        gemini_cfg = config["vision"]["gemini"]
        api_key = gemini_cfg["api_key"] or os.environ.get("GEMINI_API_KEY", "")
        if not api_key:
            raise ValueError(
                "Gemini API key not set. Put it in config.yaml or set GEMINI_API_KEY env var."
            )

        self.client = genai.Client(api_key=api_key)
        self.model = gemini_cfg["model"]
        self.prompt = load_prompt(config)

        # Unified mode state (vision + narration in one call)
        self.narration_prompt = load_narration_prompt(config)
        self.history = []
        narrator_cfg = config.get("narrator", {})
        self.max_history = narrator_cfg.get("max_history", 10)
        self.stale_timeout = narrator_cfg.get("stale_timeout", 10)
        self.last_spoken = ""
        self.last_spoken_time = 0.0
        self.introduced = False

        log.info(f"GeminiVision initialized: model={self.model}")

    def _call_gemini(self, parts):
        """Send parts to Gemini with rate-limit retry."""
        from google.genai import types

        response = self.client.models.generate_content(
            model=self.model,
            contents=[types.Content(parts=parts)],
        )
        return response

    def describe(self, jpeg_bytes: bytes) -> str:
        """Send a JPEG frame to Gemini and return its description."""
        from google.genai import types

        response = self._call_gemini([
            types.Part.from_bytes(data=jpeg_bytes, mime_type="image/jpeg"),
            types.Part.from_text(text=self.prompt),
        ])
        text = response.text.strip()
        log.info(f"Gemini response: {text[:80]}...")
        return text

    def _is_no_change(self, text: str) -> bool:
        """Check if the response indicates no change."""
        return "NOCHANGE" in text.upper().replace("_", "").replace(" ", "")

    def describe_and_narrate(self, jpeg_bytes: bytes, tone_preamble: str = "") -> str | None:
        """Single-call vision + narration with memory. Returns narration or None."""
        from google.genai import types

        # Determine mode
        seconds_since_speech = time.time() - self.last_spoken_time if self.last_spoken_time else float("inf")
        needs_introduction = not self.introduced
        force_describe = needs_introduction or seconds_since_speech >= self.stale_timeout

        if needs_introduction:
            mode_text = (
                "This is your FIRST report for this workstation. Describe who is present, "
                "what they appear to be doing, and provide an initial performance assessment. 8-15 words."
            )
        elif seconds_since_speech >= self.stale_timeout:
            mode_text = (
                "It has been a while since your last report. Provide a brief status update on current work activity, 4-8 words. "
                "Always provide a description even if nothing changed."
            )
        else:
            mode_text = (
                "If NOTHING meaningful changed since the last observation, respond with exactly: NO_CHANGE\n"
                "If something DID change in work behavior, respond with a 3-8 word performance update."
            )

        # Build history context
        history_text = "\n".join(f"[{i+1}] {d}" for i, d in enumerate(self.history))

        prompt = self.narration_prompt.format(
            history=history_text or "(no previous observations)",
            last_spoken=self.last_spoken or "(nothing yet)",
            count=len(self.history),
            mode=mode_text,
        )

        # Prepend tone modifier if provided
        if tone_preamble:
            prompt = tone_preamble + "\n" + prompt

        # Send image + prompt in one call
        response = self._call_gemini([
            types.Part.from_bytes(data=jpeg_bytes, mime_type="image/jpeg"),
            types.Part.from_text(text=prompt),
        ])
        result = response.text.strip()

        is_no_change = self._is_no_change(result)

        # Only store real observations in history (not NO_CHANGE)
        if not is_no_change:
            self.history.append(result)
            if len(self.history) > self.max_history:
                self.history.pop(0)

        tag = "  [intro]" if needs_introduction else ("  [stale]" if force_describe else "")
        log.info(f"Gemini unified: {result[:80]}{tag}")

        if is_no_change:
            log.debug(f"Gemini: NO_CHANGE (silent for {seconds_since_speech:.0f}s)")
            return None

        self.last_spoken = result
        self.last_spoken_time = time.time()
        if needs_introduction:
            self.introduced = True
        return result


def encode_frame(frame) -> bytes:
    """Encode an OpenCV frame as JPEG bytes."""
    _, jpeg = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 80])
    return jpeg.tobytes()
