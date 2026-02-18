"""
vision.py — Vision model interface.

Sends camera frames to an AI model and gets back scene descriptions.
Supports Google Gemini (primary, cloud deployment).
"""

import logging
import os
import time
from pathlib import Path

log = logging.getLogger("panopticum.vision")


def create_vision_backend(config):
    """Factory: return the right vision backend based on config."""
    return GeminiVision(config)


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
            "Last spoken report: {last_spoken}\n"
            "If NOTHING changed, respond: NO_CHANGE\n"
            "Otherwise respond with a 2-5 word surveillance status fragment."
        )


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
        narrator_cfg = config.get("narrator", {})
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

        prompt = self.narration_prompt.format(
            last_spoken=self.last_spoken or "(nothing yet)",
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

    def generate_action_request(self, jpeg_bytes: bytes, tone_preamble: str = "") -> str:
        """Generate a camera-verifiable physical action request based on current frame."""
        from google.genai import types

        prompt = (
            "You are an automated surveillance system issuing a physical directive to the person on camera.\n"
            "Look at what they are currently doing and pick a simple, camera-verifiable physical action "
            "that CONTRASTS with their current posture or activity.\n\n"
            "Action pool: stand up, sit down, raise your right hand, raise your left hand, wave at the camera, "
            "give a thumbs up, look directly at the camera, stretch your arms above your head, "
            "lean back in your chair, put both hands on the desk, cross your arms, touch your head.\n\n"
            "Rules:\n"
            "- Pick ONE action from the pool (or similar)\n"
            "- The action must be visually verifiable from a webcam\n"
            "- Phrase it as a direct command, 3-10 words\n"
            "- Do NOT add explanation or commentary — just the command\n"
        )

        if tone_preamble:
            prompt = tone_preamble + "\n" + prompt

        response = self._call_gemini([
            types.Part.from_bytes(data=jpeg_bytes, mime_type="image/jpeg"),
            types.Part.from_text(text=prompt),
        ])
        result = response.text.strip()
        log.info(f"Gemini action request: {result}")
        return result

    def verify_action(self, jpeg_bytes: bytes, action_text: str) -> bool:
        """Check if the requested action has been performed. Returns True if completed."""
        from google.genai import types

        prompt = (
            "You are verifying whether a person has performed a specific action.\n\n"
            f"Requested action: \"{action_text}\"\n\n"
            "Look at the image carefully. Is the person currently performing or has performed this action?\n\n"
            "Respond with EXACTLY one word:\n"
            "- COMPLETED — if the action is being performed or has been performed\n"
            "- NOT_YET — if the action has not been performed\n"
        )

        response = self._call_gemini([
            types.Part.from_bytes(data=jpeg_bytes, mime_type="image/jpeg"),
            types.Part.from_text(text=prompt),
        ])
        result = response.text.strip()
        completed = "COMPLETED" in result.upper()
        log.info(f"Gemini verify action '{action_text}': {result} -> {'completed' if completed else 'not yet'}")
        return completed

    def generate_action_response(self, jpeg_bytes: bytes, action_text: str, completed: bool, tone_preamble: str = "") -> str:
        """Generate a spoken response after action resolution."""
        from google.genai import types

        if completed:
            prompt = (
                "You are an automated surveillance system. The person on camera has just completed "
                f"the following action you requested: \"{action_text}\"\n\n"
                "Generate a brief spoken confirmation, 5-12 words.\n"
                "Match the tone specified below.\n"
                "Do NOT add explanation — just the spoken line.\n"
            )
            if tone_preamble:
                prompt = tone_preamble + "\n" + prompt
        else:
            # Non-compliance is always neutral regardless of tone
            prompt = (
                "You are an automated surveillance system. The person on camera did NOT complete "
                f"the following action you requested: \"{action_text}\"\n\n"
                "Generate a brief, neutral, factual acknowledgement of non-compliance, 5-12 words.\n"
                "Be matter-of-fact, not harsh, not supportive — just neutral.\n"
                "Do NOT add explanation — just the spoken line.\n"
            )

        response = self._call_gemini([
            types.Part.from_bytes(data=jpeg_bytes, mime_type="image/jpeg"),
            types.Part.from_text(text=prompt),
        ])
        result = response.text.strip()
        self.last_spoken = result
        self.last_spoken_time = time.time()
        log.info(f"Gemini action response ({'completed' if completed else 'non-compliance'}): {result}")
        return result
