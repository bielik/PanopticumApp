"""
main.py — PANOPTICUM: Interactive Surveillance Art Installation

A camera watches a space. An AI describes what it sees.
A voice speaks the description out loud.
The cosy becomes clinical. The private becomes observed.

Usage:
    python main.py          # Run with config.yaml
    python main.py --help   # Show options

Press ESC to quit.
"""

import logging
import sys
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path

from dotenv import load_dotenv
load_dotenv()
from typing import Optional

import cv2
import numpy as np
import yaml

from narrator import Narrator
from overlay import create_no_signal_frame, draw_overlay
from tts import create_tts_backend
from vision import create_vision_backend, encode_frame

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("panopticum")


# ---------------------------------------------------------------------------
# Shared state between threads
# ---------------------------------------------------------------------------
@dataclass
class SharedState:
    """Thread-safe shared state for the three execution paths."""

    lock: threading.Lock = field(default_factory=threading.Lock)

    # Main thread writes, analysis thread reads
    latest_frame: Optional[np.ndarray] = None
    frame_ready: threading.Event = field(default_factory=threading.Event)

    # Analysis thread writes, main + TTS threads read
    latest_description: str = ""
    description_timestamp: float = 0.0

    # Control
    running: bool = True
    is_speaking: bool = False


# ---------------------------------------------------------------------------
# Analysis worker (runs in background thread)
# ---------------------------------------------------------------------------
def analysis_worker(config, state: SharedState):
    """Grab frames and send them to the vision model, then narrate."""
    # Create the vision backend
    try:
        vision = create_vision_backend(config)
    except Exception as e:
        log.error(f"Failed to initialize vision backend: {e}")
        log.info("Vision analysis disabled. Camera feed will continue.")
        return

    # Gemini handles narration internally — no separate narrator needed
    narrator_enabled = config.get("narrator", {}).get("enabled", False)
    use_unified = hasattr(vision, "describe_and_narrate") and narrator_enabled

    if use_unified:
        log.info("Using Gemini unified mode (vision + narration in one call)")
        narrator = None
    else:
        narrator = None
        if narrator_enabled:
            try:
                narrator = Narrator(config)
            except Exception as e:
                log.warning(f"Failed to initialize narrator: {e}")
                log.info("Narrator disabled. Raw vision descriptions will be used.")

    interval = config["timing"]["analysis_interval"]
    consecutive_failures = 0
    max_failures = 5

    while state.running:
        cycle_start = time.time()

        # Wait for a frame
        if not state.frame_ready.wait(timeout=2.0):
            continue
        state.frame_ready.clear()

        with state.lock:
            frame = state.latest_frame
        if frame is None:
            continue

        try:
            jpeg_bytes = encode_frame(frame)

            if use_unified:
                narration = vision.describe_and_narrate(jpeg_bytes)
            else:
                raw_description = vision.describe(jpeg_bytes)

                # Pass through narrator if enabled
                if narrator is not None:
                    try:
                        narration = narrator.narrate(raw_description)
                    except Exception as e:
                        log.warning(f"Narrator error: {e}")
                        narration = raw_description
                else:
                    narration = raw_description

            consecutive_failures = 0

            # Skip TTS/display if narrator says nothing changed
            if narration is not None:
                with state.lock:
                    state.latest_description = narration
                    state.description_timestamp = time.time()

                # Log to file if enabled
                if config["advanced"]["log_descriptions"]:
                    _log_description(config, narration)

                # Wait for TTS to pick up this narration and finish speaking it
                time.sleep(0.5)  # let TTS thread detect the new description
                while state.running:
                    with state.lock:
                        speaking = state.is_speaking
                    if not speaking:
                        break
                    time.sleep(0.2)

        except Exception as e:
            consecutive_failures += 1
            error_str = str(e)

            # Extract retry delay from rate limit errors (e.g. "retry in 29.1s")
            retry_match = _extract_retry_delay(error_str)
            if retry_match and consecutive_failures < max_failures:
                log.warning(f"Rate limited. Waiting {retry_match:.0f}s before retry ({consecutive_failures}/{max_failures})")
                time.sleep(retry_match)
                continue

            log.warning(f"Vision error ({consecutive_failures}/{max_failures}): {e}")

            if consecutive_failures >= max_failures:
                log.error("Too many vision failures. Attempting backend switch...")
                new_vision = _try_fallback_vision(config, vision)
                if new_vision is not vision:
                    vision = new_vision
                    # Re-evaluate unified mode after fallback
                    use_unified = hasattr(vision, "describe_and_narrate") and narrator_enabled
                    if not use_unified and narrator is None and narrator_enabled:
                        try:
                            narrator = Narrator(config)
                            log.info("Narrator initialized for Ollama fallback pipeline")
                        except Exception as ne:
                            log.warning(f"Failed to initialize narrator after fallback: {ne}")
                consecutive_failures = 0

        # Sleep only the remaining time to hit the target interval
        elapsed = time.time() - cycle_start
        remaining = interval - elapsed
        if remaining > 0:
            time.sleep(remaining)


def _extract_retry_delay(error_str: str) -> float | None:
    """Extract retry delay in seconds from a Gemini 429 error message."""
    import re
    # Matches patterns like "retry in 29.111965449s" or "retryDelay': '29s'"
    match = re.search(r"retry[_ ]?[iI]n[:\s'\"]*(\d+\.?\d*)\s*s", error_str, re.IGNORECASE)
    if match:
        return min(float(match.group(1)), 60.0)  # cap at 60s
    match = re.search(r"retryDelay['\"]?\s*:\s*['\"]?(\d+)", error_str, re.IGNORECASE)
    if match:
        return min(float(match.group(1)), 60.0)
    # If it looks like a rate limit error but no delay found, use default
    if "429" in error_str or "RESOURCE_EXHAUSTED" in error_str:
        return 30.0
    return None


def _try_fallback_vision(config, current_vision):
    """Try to switch to a fallback vision backend."""
    current_type = type(current_vision).__name__

    if current_type == "GeminiVision":
        # Gemini failed — fall back to Ollama (local)
        try:
            log.info("Gemini failing. Switching to Ollama fallback...")
            config_copy = dict(config)
            config_copy["vision"] = dict(config["vision"])
            config_copy["vision"]["backend"] = "ollama"
            from vision import OllamaVision
            return OllamaVision(config_copy)
        except Exception as e:
            log.error(f"Ollama fallback also failed: {e}")

    elif current_type == "OllamaVision":
        # Ollama failed — try Gemini if an API key is available
        api_key = config["vision"]["gemini"]["api_key"] or __import__("os").environ.get("GEMINI_API_KEY", "")
        if api_key:
            try:
                log.info("Ollama failing. Switching to Gemini fallback...")
                config_copy = dict(config)
                config_copy["vision"] = dict(config["vision"])
                config_copy["vision"]["backend"] = "gemini"
                from vision import GeminiVision
                return GeminiVision(config_copy)
            except Exception as e:
                log.error(f"Gemini fallback also failed: {e}")

    log.warning("No fallback available. Vision analysis paused.")
    return current_vision


def _log_description(config, description):
    """Append a description to the log file."""
    try:
        log_path = Path(config["advanced"]["log_file"])
        timestamp = time.strftime("%Y-%m-%d %H:%M:%S")
        with open(log_path, "a", encoding="utf-8") as f:
            f.write(f"[{timestamp}] {description}\n")
    except Exception as e:
        log.warning(f"Failed to write log: {e}")


# ---------------------------------------------------------------------------
# TTS worker (runs in background thread)
# ---------------------------------------------------------------------------
def tts_worker(config, state: SharedState):
    """Speak new descriptions as they arrive."""
    try:
        tts = create_tts_backend(config)
    except Exception as e:
        log.error(f"Failed to initialize TTS backend: {e}")
        # Try fallback
        try:
            log.info("Trying pyttsx3 fallback for TTS...")
            config_copy = dict(config)
            config_copy["tts"] = dict(config["tts"])
            config_copy["tts"]["backend"] = "pyttsx3"
            tts = create_tts_backend(config_copy)
        except Exception as e2:
            log.error(f"TTS fallback also failed: {e2}. Audio disabled.")
            return

    last_spoken = ""

    while state.running:
        with state.lock:
            description = state.latest_description

        if description and description != last_spoken:
            log.info(f"TTS: new description to speak ({len(description)} chars)")
            last_spoken = description

            with state.lock:
                state.is_speaking = True
            try:
                tts.speak(description)
            except Exception as e:
                log.warning(f"TTS speak error: {e}", exc_info=True)
            finally:
                with state.lock:
                    state.is_speaking = False

        time.sleep(0.2)


# ---------------------------------------------------------------------------
# Main loop (camera + display, runs on main thread)
# ---------------------------------------------------------------------------
def load_config(path: str = "config.yaml") -> dict:
    """Load configuration from YAML file."""
    config_path = Path(path)
    if not config_path.exists():
        log.error(f"Config file not found: {config_path}")
        sys.exit(1)

    with open(config_path, "r", encoding="utf-8") as f:
        config = yaml.safe_load(f)

    log.info(f"Config loaded from {config_path}")
    return config


def main():
    """Main entry point."""
    config = load_config()
    state = SharedState()

    # Start worker threads (daemon = auto-stop when main thread exits)
    analysis_t = threading.Thread(
        target=analysis_worker, args=(config, state), daemon=True, name="analysis"
    )
    tts_t = threading.Thread(
        target=tts_worker, args=(config, state), daemon=True, name="tts"
    )
    analysis_t.start()
    tts_t.start()

    # Open camera
    cam_cfg = config["camera"]
    cap = cv2.VideoCapture(cam_cfg["index"])
    cap.set(cv2.CAP_PROP_FRAME_WIDTH, cam_cfg["width"])
    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, cam_cfg["height"])

    if not cap.isOpened():
        log.error(f"Cannot open camera index {cam_cfg['index']}")
        sys.exit(1)

    log.info(f"Camera opened: index={cam_cfg['index']} ({cam_cfg['width']}x{cam_cfg['height']})")

    # Create display window
    window_name = "PANOPTICUM"
    cv2.namedWindow(window_name, cv2.WINDOW_NORMAL)
    if cam_cfg["fullscreen"]:
        cv2.setWindowProperty(window_name, cv2.WND_PROP_FULLSCREEN, cv2.WINDOW_FULLSCREEN)

    log.info("Running. Press ESC to quit.")

    try:
        while state.running:
            ret, frame = cap.read()

            if not ret or frame is None:
                # Camera disconnected — show static
                frame = create_no_signal_frame(cam_cfg["width"], cam_cfg["height"])
                # Try to reconnect
                cap.release()
                time.sleep(2)
                cap = cv2.VideoCapture(cam_cfg["index"])
                cap.set(cv2.CAP_PROP_FRAME_WIDTH, cam_cfg["width"])
                cap.set(cv2.CAP_PROP_FRAME_HEIGHT, cam_cfg["height"])
            else:
                if cam_cfg["mirror"]:
                    frame = cv2.flip(frame, 1)

                # Share frame with analysis thread
                with state.lock:
                    state.latest_frame = frame.copy()
                    state.frame_ready.set()

            # Draw overlay and display
            display_frame = draw_overlay(frame, state, config)
            cv2.imshow(window_name, display_frame)

            # Keyboard controls
            key = cv2.waitKey(1) & 0xFF
            if key == 27:  # ESC to quit
                log.info("ESC pressed. Shutting down...")
                state.running = False
            elif key == ord('f') or key == ord('F'):  # Toggle fullscreen
                prop = cv2.getWindowProperty(window_name, cv2.WND_PROP_FULLSCREEN)
                if prop == cv2.WINDOW_FULLSCREEN:
                    cv2.setWindowProperty(window_name, cv2.WND_PROP_FULLSCREEN, cv2.WINDOW_NORMAL)
                    log.info("Switched to windowed mode")
                else:
                    cv2.setWindowProperty(window_name, cv2.WND_PROP_FULLSCREEN, cv2.WINDOW_FULLSCREEN)
                    log.info("Switched to fullscreen mode")

    except KeyboardInterrupt:
        log.info("Ctrl+C pressed. Shutting down...")
        state.running = False
    finally:
        cap.release()
        cv2.destroyAllWindows()
        log.info("PANOPTICUM stopped.")


if __name__ == "__main__":
    main()
