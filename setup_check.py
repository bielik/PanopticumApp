"""
setup_check.py — Pre-flight check for PANOPTICUM.

Run this before main.py to verify your setup is ready.
Usage: python setup_check.py
"""

import sys
import time


def check(label, fn):
    """Run a check function and print pass/fail."""
    try:
        result = fn()
        if result:
            print(f"  [OK]   {label}")
        else:
            print(f"  [FAIL] {label}")
        return result
    except Exception as e:
        print(f"  [FAIL] {label} — {e}")
        return False


def check_python():
    v = sys.version_info
    ok = v.major == 3 and v.minor >= 9
    if not ok:
        print(f"         Python 3.9+ required, you have {v.major}.{v.minor}.{v.micro}")
    return ok


def check_import(name):
    def _check():
        __import__(name)
        return True
    return _check


def check_camera():
    import cv2
    cap = cv2.VideoCapture(0)
    if not cap.isOpened():
        print("         Could not open camera index 0. Check your webcam connection.")
        return False
    ret, frame = cap.read()
    cap.release()
    if not ret:
        print("         Camera opened but could not read a frame.")
        return False
    h, w = frame.shape[:2]
    print(f"         Camera working: {w}x{h}")
    return True


def check_ollama():
    import urllib.request
    import json

    try:
        req = urllib.request.Request("http://localhost:11434/api/tags")
        with urllib.request.urlopen(req, timeout=5) as resp:
            data = json.loads(resp.read())
            models = [m["name"] for m in data.get("models", [])]
            if models:
                print(f"         Available models: {', '.join(models)}")
            return True
    except Exception:
        print("         Ollama is not running. Start it with: ollama serve")
        print("         Download from: https://ollama.com/download")
        return False


def check_ollama_model():
    import urllib.request
    import json

    try:
        req = urllib.request.Request("http://localhost:11434/api/tags")
        with urllib.request.urlopen(req, timeout=5) as resp:
            data = json.loads(resp.read())
            models = [m["name"] for m in data.get("models", [])]
            # Check for moondream (any tag)
            has_moondream = any("moondream" in m for m in models)
            if not has_moondream:
                print("         moondream not found. Pull it with: ollama pull moondream")
            return has_moondream
    except Exception:
        print("         Could not check models (Ollama not running)")
        return False


def check_narrator_model():
    import urllib.request
    import json

    try:
        req = urllib.request.Request("http://localhost:11434/api/tags")
        with urllib.request.urlopen(req, timeout=5) as resp:
            data = json.loads(resp.read())
            models = [m["name"] for m in data.get("models", [])]
            has_narrator = any("llama3.2:3b" in m for m in models)
            if not has_narrator:
                print("         llama3.2:3b not found. Pull it with: ollama pull llama3.2:3b")
            return has_narrator
    except Exception:
        print("         Could not check models (Ollama not running)")
        return False


def check_gemini_api_key():
    import os
    api_key = os.environ.get("GEMINI_API_KEY", "")
    if api_key:
        print(f"         GEMINI_API_KEY set ({len(api_key)} chars)")
        return True
    # Also check config
    try:
        import yaml
        with open("config.yaml", "r", encoding="utf-8") as f:
            config = yaml.safe_load(f)
        key = config.get("vision", {}).get("gemini", {}).get("api_key", "")
        if key:
            print(f"         API key found in config.yaml ({len(key)} chars)")
            return True
    except Exception:
        pass
    print("         No Gemini API key found. Set GEMINI_API_KEY env var or add to config.yaml")
    print("         Get a key at: https://aistudio.google.com/apikey")
    return False


def check_gemini_import():
    try:
        __import__("google.genai")
        return True
    except ImportError:
        print("         google-genai not installed. Install with: pip install google-genai")
        return False


def check_audio():
    import pygame
    try:
        pygame.mixer.init(frequency=24000)
        pygame.mixer.quit()
        return True
    except Exception as e:
        print(f"         Audio init failed: {e}")
        return False


def check_edge_tts():
    import asyncio
    import edge_tts
    import tempfile
    import os

    async def _test():
        temp = tempfile.NamedTemporaryFile(suffix=".mp3", delete=False)
        temp.close()
        try:
            c = edge_tts.Communicate("Test", "en-GB-RyanNeural")
            await c.save(temp.name)
            size = os.path.getsize(temp.name)
            return size > 0
        finally:
            os.unlink(temp.name)

    return asyncio.run(_test())


def main():
    print("=" * 50)
    print("  PANOPTICUM — Setup Check")
    print("=" * 50)
    print()

    results = []

    print("1. Python")
    results.append(check("Python version >= 3.9", check_python))
    print()

    print("2. Required packages")
    packages = ["cv2", "yaml", "edge_tts", "pygame"]
    for pkg in packages:
        results.append(check(f"import {pkg}", check_import(pkg)))
    print()

    print("3. Camera")
    results.append(check("Webcam accessible", check_camera))
    print()

    print("4. Gemini (primary backend)")
    results.append(check("google-genai package", check_gemini_import))
    results.append(check("Gemini API key configured", check_gemini_api_key))
    print()

    print("5. Ollama (offline fallback)")
    results.append(check("import ollama", check_import("ollama")))
    ollama_ok = check("Ollama server running", check_ollama)
    results.append(ollama_ok)
    if ollama_ok:
        results.append(check("moondream model available", check_ollama_model))
        results.append(check("llama3.2:3b narrator model available", check_narrator_model))
    else:
        print("         (skipping model checks — Ollama not running)")
    print()

    print("6. Audio")
    results.append(check("Audio output (pygame mixer)", check_audio))
    results.append(check("Edge TTS generation", check_edge_tts))
    print()

    # Summary
    passed = sum(results)
    total = len(results)
    print("=" * 50)
    if all(results):
        print(f"  ALL {total} CHECKS PASSED")
        print("  Ready to run:  python main.py")
    else:
        print(f"  {passed}/{total} checks passed. Fix the failures above.")
    print("=" * 50)


if __name__ == "__main__":
    main()
