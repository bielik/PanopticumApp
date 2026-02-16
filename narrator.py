"""
narrator.py — Two-stage narration pipeline.

Takes raw vision model descriptions and transforms them into
surveillance-style narration using a text LLM with rolling memory.

Change detection is done programmatically (keyword diffing).
The LLM is only called when a real change is detected.
"""

import logging
import re
from pathlib import Path

log = logging.getLogger("panopticum.narrator")

# Stop words + moondream noise (body parts, fillers, hallucinations)
IGNORE_WORDS = {
    # articles, prepositions, conjunctions
    "the", "a", "an", "in", "on", "at", "of", "with", "and", "is", "his",
    "her", "their", "to", "from", "by", "for", "it", "that", "this", "or",
    "be", "has", "have", "are", "was", "were", "been", "being", "which",
    "who", "whom", "into", "through", "during", "before", "after", "above",
    "below", "between", "but", "about", "against", "while", "may", "also",
    "he", "she", "they", "some", "just", "not", "no", "so", "up", "down",
    # moondream hallucinations
    "urn", "water", "ink",
    # moondream filler — these words change randomly between frames
    "suggesting", "appears", "visible", "behind", "background", "nearby",
    "looking", "wearing", "seated", "sitting", "man", "woman", "person",
    "people", "image", "photo", "picture", "scene", "indoor", "setting",
    "desk", "table", "chair", "screen", "keyboard", "computer", "monitor",
    "head", "hand", "hands", "face", "eyes", "finger", "fingers", "arm",
    "turned", "resting", "raised", "directed", "open", "closed",
    "left", "right", "back", "front", "side", "next",
    "white", "black", "gray", "grey", "blue", "door", "wall", "frame",
    "window", "floor", "ceiling", "room", "office", "inside",
    "sweatshirt", "shirt", "sweater", "clothes",
}


def _extract_keywords(text: str) -> set[str]:
    """Extract meaningful words from a description."""
    words = set(re.findall(r"[a-z]+", text.lower()))
    return words - IGNORE_WORDS


class Narrator:
    """Text LLM narrator with programmatic change detection."""

    def __init__(self, config):
        import ollama

        narrator_cfg = config["narrator"]
        self.client = ollama.Client(
            host=narrator_cfg["host"],
            timeout=narrator_cfg["timeout"],
        )
        self.model = narrator_cfg["model"]
        self.max_words = narrator_cfg["max_words"]
        self.history = []
        self.max_history = narrator_cfg["max_history"]
        self.warmup_rounds = narrator_cfg.get("warmup_rounds", 3)
        self.baseline_keywords = set()  # grows over time
        self.last_spoken = ""
        # Use narrator_prompt_file (Ollama-specific) if available, fall back to prompt_file
        prompt_file = narrator_cfg.get("narrator_prompt_file", narrator_cfg.get("prompt_file", "prompts/narrator_surveillance.txt"))
        self.prompt_template = self._load_prompt(prompt_file)
        log.info(f"Narrator initialized: model={self.model}, max_history={self.max_history}")

    def _load_prompt(self, prompt_file: str) -> str:
        """Load the narrator prompt template from file."""
        path = Path(prompt_file)
        if path.exists():
            template = path.read_text(encoding="utf-8").strip()
            log.info(f"Narrator prompt loaded from {path}")
            return template
        else:
            log.warning(f"Narrator prompt not found: {path}. Using built-in default.")
            return "New in scene: {new_words}. Describe in 2-5 words as surveillance report."

    def narrate(self, raw_description: str) -> str | None:
        """Process a raw vision description. Returns narration or None."""
        self.history.append(raw_description)
        if len(self.history) > self.max_history:
            self.history.pop(0)

        keywords = _extract_keywords(raw_description)

        # Warmup phase: build baseline, stay silent
        if len(self.history) <= self.warmup_rounds:
            self.baseline_keywords |= keywords
            log.info(f"Narrator: warmup {len(self.history)}/{self.warmup_rounds} (baseline: {len(self.baseline_keywords)} words)")
            return None

        # Detect change: only NEW keywords not in baseline
        new_keywords = keywords - self.baseline_keywords
        if not new_keywords:
            log.debug("Narrator: no new keywords")
            return None

        log.info(f"Narrator: new keywords detected: {new_keywords}")

        # Add to baseline so we don't re-report
        self.baseline_keywords |= new_keywords

        # Call LLM with explicit change info
        return self._call_llm(raw_description, new_keywords)

    def _call_llm(self, raw_description: str, new_keywords: set[str]) -> str | None:
        """Call the text LLM to generate a terse narration about the change."""
        new_words_str = ", ".join(sorted(new_keywords))
        prompt = self.prompt_template.format(
            history="\n".join(self.history[-5:]),
            latest=raw_description,
            count=len(self.history),
            max_words=self.max_words,
            last_spoken=self.last_spoken or "(nothing yet)",
            new_words=new_words_str,
        )

        response = self.client.chat(
            model=self.model,
            messages=[{"role": "user", "content": prompt}],
            options={"num_predict": 15},
        )
        narration = response.message.content.strip().strip('"').split("\n")[0]

        # Skip garbage
        normalized = narration.upper().replace("_", "").replace(" ", "")
        if "NOCHANGE" in normalized:
            return None

        self.last_spoken = narration
        log.info(f"Narrator: {narration}")
        return narration
