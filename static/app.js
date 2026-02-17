/* PANOPTICUM — Frontend controller */

(function () {
    "use strict";

    // --- Elements ---
    const timestampEl = document.getElementById("timestamp");
    const recDot = document.getElementById("rec-dot");
    const descriptionBox = document.getElementById("description-box");
    const audioIndicator = document.getElementById("audio-indicator");
    const effectButtons = document.querySelectorAll(".effect-btn");
    const toneSlider = document.getElementById("tone-slider");
    const toneValueEl = document.getElementById("tone-value");

    // --- Timestamp clock ---
    function updateTimestamp() {
        if (!timestampEl) return;
        const now = new Date();
        const y = now.getFullYear();
        const mo = String(now.getMonth() + 1).padStart(2, "0");
        const d = String(now.getDate()).padStart(2, "0");
        const h = String(now.getHours()).padStart(2, "0");
        const mi = String(now.getMinutes()).padStart(2, "0");
        const s = String(now.getSeconds()).padStart(2, "0");
        timestampEl.textContent = `${y}-${mo}-${d}  ${h}:${mi}:${s}`;
    }
    setInterval(updateTimestamp, 1000);
    updateTimestamp();

    // --- REC dot blink ---
    if (recDot) {
        recDot.classList.add("blink");
    }

    // --- Description fade timing ---
    let descriptionTimer = null;
    const OVERLAY_DURATION = 8000; // ms
    const FADE_OUT_BEFORE = 1500;  // start fade-out 1.5s before end

    function showDescription(text) {
        if (!descriptionBox) return;
        descriptionBox.textContent = text;
        descriptionBox.classList.remove("fade-out");
        descriptionBox.classList.add("visible");

        if (descriptionTimer) clearTimeout(descriptionTimer);

        descriptionTimer = setTimeout(function () {
            descriptionBox.classList.add("fade-out");
            descriptionBox.classList.remove("visible");
        }, OVERLAY_DURATION - FADE_OUT_BEFORE);
    }

    // --- SSE listeners ---
    const evtSource = new EventSource("/events");

    evtSource.addEventListener("description", function (e) {
        const data = JSON.parse(e.data);
        if (data.text) {
            showDescription(data.text);
        }
    });

    evtSource.addEventListener("speaking", function (e) {
        const data = JSON.parse(e.data);
        if (audioIndicator) {
            if (data.speaking) {
                audioIndicator.classList.add("active");
            } else {
                audioIndicator.classList.remove("active");
            }
        }
    });

    evtSource.addEventListener("effect", function (e) {
        const data = JSON.parse(e.data);
        highlightEffect(data.effect);
    });

    evtSource.addEventListener("tone", function (e) {
        const data = JSON.parse(e.data);
        if (toneSlider && toneSlider.value !== String(data.value)) {
            toneSlider.value = data.value;
        }
        updateToneLabel(data.value);
    });

    evtSource.onerror = function () {
        console.warn("SSE connection lost, reconnecting...");
    };

    // --- Effect buttons ---
    function highlightEffect(effectName) {
        effectButtons.forEach(function (btn) {
            if (btn.dataset.effect === effectName) {
                btn.classList.add("active");
            } else {
                btn.classList.remove("active");
            }
        });
    }

    effectButtons.forEach(function (btn) {
        btn.addEventListener("click", function () {
            const effect = btn.dataset.effect;
            fetch("/api/effect", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ effect: effect }),
            });
            highlightEffect(effect);
        });
    });

    // --- Tone slider ---
    let toneDebounce = null;

    function updateToneLabel(value) {
        if (!toneValueEl) return;
        const v = parseFloat(value);
        if (v <= 0.25) {
            toneValueEl.textContent = "FLATTERING";
        } else if (v <= 0.75) {
            toneValueEl.textContent = "NEUTRAL";
        } else {
            toneValueEl.textContent = "JUDGMENTAL";
        }
    }

    if (toneSlider) {
        toneSlider.addEventListener("input", function () {
            updateToneLabel(toneSlider.value);

            if (toneDebounce) clearTimeout(toneDebounce);
            toneDebounce = setTimeout(function () {
                fetch("/api/tone", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ value: parseFloat(toneSlider.value) }),
                });
            }, 300);
        });
    }

    // --- Initial state fetch ---
    fetch("/api/status")
        .then(function (r) { return r.json(); })
        .then(function (data) {
            highlightEffect(data.effect);
            if (toneSlider) toneSlider.value = data.tone;
            updateToneLabel(data.tone);
            if (data.description) showDescription(data.description);
            if (data.speaking && audioIndicator) {
                audioIndicator.classList.add("active");
            }
        })
        .catch(function (err) {
            console.warn("Failed to fetch initial status:", err);
        });
})();
