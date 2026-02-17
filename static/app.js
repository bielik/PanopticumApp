/* PANOPTICUM — Frontend controller */

(function () {
    "use strict";

    // --- Elements ---
    var timestampEl = document.getElementById("timestamp");
    var recDot = document.getElementById("rec-dot");
    var startStopBtn = document.getElementById("start-stop-btn");
    var messageLogList = document.getElementById("message-log-list");
    var motivationalEl = document.getElementById("motivational-message");
    var syncCheckbox = document.getElementById("sync-checkbox");
    var messageLogPanel = document.getElementById("message-log");
    var logCollapseBtn = document.getElementById("log-collapse-btn");
    var logExpandBtn = document.getElementById("log-expand-btn");

    var effectPills = document.querySelectorAll("#effect-pills .pill-btn");
    var tonePills = document.querySelectorAll("#tone-pills .pill-btn");

    // Overlay elements
    var overlayTop = document.querySelector(".overlay-top");
    var camLabel = document.querySelector(".cam-label");
    var scanlines = document.querySelector(".scanlines");

    // --- State ---
    var isActive = false;
    var currentEffect = "natural";
    var currentTone = "0.5";
    var isSynced = true;

    // --- Sync mapping ---
    var EFFECT_TO_TONE = { "bright": "0", "natural": "0.5", "cctv": "1" };
    var TONE_TO_EFFECT = { "0": "bright", "0.5": "natural", "1": "cctv" };

    // --- Message log ---
    var messageLog = [];
    var MAX_LOG_MESSAGES = 10;

    // --- Motivational messages ---
    var MOTIVATIONAL_MESSAGES = [
        "PRODUCTIVITY LEVEL: TRANSCENDENT",
        "EMPLOYEE OF THE CENTURY DETECTED",
        "SYNERGY OUTPUT: MAXIMUM",
        "YOUR POTENTIAL: LITERALLY LIMITLESS",
        "PERFORMANCE METRICS: OFF THE CHARTS",
        "TEAMWORK EXCELLENCE: UNPRECEDENTED",
        "DEDICATION LEVELS: INSPIRING",
        "WORKFLOW OPTIMIZATION: PERFECTED",
        "LEADERSHIP POTENTIAL: CONFIRMED",
        "INNOVATION INDEX: STRATOSPHERIC",
        "EFFICIENCY RATING: BEYOND MEASURE",
        "PROFESSIONAL GROWTH: EXPONENTIAL",
        "WORKPLACE HARMONY: ACHIEVED",
        "COMMITMENT SCORE: LEGENDARY",
        "OUTPUT QUALITY: WORLD-CLASS",
        "FOCUS INTENSITY: SUPERHUMAN",
        "CAREER TRAJECTORY: VERTICAL",
        "COLLABORATION QUOTIENT: ELITE",
    ];
    var motivationalIndex = 0;
    var motivationalInterval = null;

    // =========================================================================
    // Start/Stop
    // =========================================================================
    function updateStartStopButton(active) {
        isActive = active;
        if (!startStopBtn) return;
        if (active) {
            startStopBtn.textContent = "STOP";
            startStopBtn.classList.remove("inactive");
            startStopBtn.classList.add("active");
        } else {
            startStopBtn.textContent = "START";
            startStopBtn.classList.remove("active");
            startStopBtn.classList.add("inactive");
        }
    }

    if (startStopBtn) {
        startStopBtn.addEventListener("click", function () {
            fetch("/api/active", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ active: !isActive }),
            });
        });
    }

    // =========================================================================
    // Timestamp clock
    // =========================================================================
    function updateTimestamp() {
        if (!timestampEl) return;
        var now = new Date();
        var y = now.getFullYear();
        var mo = String(now.getMonth() + 1).padStart(2, "0");
        var d = String(now.getDate()).padStart(2, "0");
        var h = String(now.getHours()).padStart(2, "0");
        var mi = String(now.getMinutes()).padStart(2, "0");
        var s = String(now.getSeconds()).padStart(2, "0");
        timestampEl.textContent = y + "-" + mo + "-" + d + "  " + h + ":" + mi + ":" + s;
    }
    setInterval(updateTimestamp, 1000);
    updateTimestamp();

    if (recDot) recDot.classList.add("blink");

    // =========================================================================
    // Effect overlay visibility
    // =========================================================================
    function updateOverlayForEffect(effect) {
        currentEffect = effect;
        var isCctv = effect === "cctv";
        var isBright = effect === "bright";

        if (overlayTop) overlayTop.style.display = isCctv ? "flex" : "none";
        if (camLabel) camLabel.style.display = isCctv ? "block" : "none";
        if (scanlines) scanlines.style.display = isCctv ? "block" : "none";

        if (motivationalEl) {
            motivationalEl.style.display = isBright ? "block" : "none";
        }

        if (isBright) {
            startMotivationalRotation();
        } else {
            stopMotivationalRotation();
        }
    }

    // =========================================================================
    // Motivational message rotation
    // =========================================================================
    function showNextMotivational() {
        if (!motivationalEl) return;
        motivationalEl.classList.remove("visible");
        setTimeout(function () {
            motivationalEl.textContent = MOTIVATIONAL_MESSAGES[motivationalIndex];
            motivationalIndex = (motivationalIndex + 1) % MOTIVATIONAL_MESSAGES.length;
            motivationalEl.classList.add("visible");
        }, 500);
    }

    function startMotivationalRotation() {
        if (motivationalInterval) return;
        showNextMotivational();
        motivationalInterval = setInterval(showNextMotivational, 60000);
    }

    function stopMotivationalRotation() {
        if (motivationalInterval) {
            clearInterval(motivationalInterval);
            motivationalInterval = null;
        }
        if (motivationalEl) motivationalEl.classList.remove("visible");
    }

    // =========================================================================
    // Pill highlighting
    // =========================================================================
    function highlightEffectPill(effectName) {
        effectPills.forEach(function (btn) {
            btn.classList.toggle("active", btn.dataset.effect === effectName);
        });
    }

    function highlightTonePill(toneValue) {
        var tv = String(toneValue);
        tonePills.forEach(function (btn) {
            btn.classList.toggle("active", btn.dataset.tone === tv);
        });
    }

    // =========================================================================
    // Effect selection
    // =========================================================================
    function setEffect(effect, fromSync) {
        currentEffect = effect;
        fetch("/api/effect", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ effect: effect }),
        });
        highlightEffectPill(effect);
        updateOverlayForEffect(effect);

        // Sync: effect change drives tone
        if (isSynced && !fromSync && EFFECT_TO_TONE[effect] !== undefined) {
            setTone(EFFECT_TO_TONE[effect], true);
        }
    }

    effectPills.forEach(function (btn) {
        btn.addEventListener("click", function () {
            setEffect(btn.dataset.effect, false);
        });
    });

    // =========================================================================
    // Tone selection
    // =========================================================================
    function setTone(toneValue, fromSync) {
        currentTone = String(toneValue);
        fetch("/api/tone", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ value: parseFloat(toneValue) }),
        });
        highlightTonePill(toneValue);

        // Sync: tone change drives effect
        if (isSynced && !fromSync && TONE_TO_EFFECT[currentTone] !== undefined) {
            setEffect(TONE_TO_EFFECT[currentTone], true);
        }
    }

    tonePills.forEach(function (btn) {
        btn.addEventListener("click", function () {
            setTone(btn.dataset.tone, false);
        });
    });

    // =========================================================================
    // Sync toggle
    // =========================================================================
    if (syncCheckbox) {
        isSynced = syncCheckbox.checked;
        syncCheckbox.addEventListener("change", function () {
            isSynced = syncCheckbox.checked;
            // If turning sync on, align tone to current effect
            if (isSynced && EFFECT_TO_TONE[currentEffect] !== undefined) {
                setTone(EFFECT_TO_TONE[currentEffect], true);
            }
        });
    }

    // =========================================================================
    // Message log
    // =========================================================================
    function renderMessageLog() {
        if (!messageLogList) return;
        if (messageLog.length === 0) {
            messageLogList.innerHTML = '<div class="message-log-empty">Waiting for observations...</div>';
            return;
        }
        var html = "";
        for (var i = 0; i < messageLog.length; i++) {
            var msg = messageLog[i];
            var cls = i === 0 ? "message-log-item latest" : "message-log-item";
            html += '<div class="' + cls + '">';
            html += '<span class="message-log-time">' + (msg.time || "") + '</span>';
            html += '<span class="message-log-text">' + escapeHtml(msg.text) + '</span>';
            html += '</div>';
        }
        messageLogList.innerHTML = html;
    }

    function escapeHtml(text) {
        var div = document.createElement("div");
        div.textContent = text;
        return div.innerHTML;
    }

    function addToMessageLog(text) {
        var now = new Date();
        var h = String(now.getHours()).padStart(2, "0");
        var mi = String(now.getMinutes()).padStart(2, "0");
        var s = String(now.getSeconds()).padStart(2, "0");
        messageLog.unshift({ text: text, time: h + ":" + mi + ":" + s });
        if (messageLog.length > MAX_LOG_MESSAGES) messageLog.pop();
        renderMessageLog();
    }

    // =========================================================================
    // SSE listeners
    // =========================================================================
    var evtSource = new EventSource("/events");

    evtSource.addEventListener("active", function (e) {
        var data = JSON.parse(e.data);
        updateStartStopButton(data.active);
    });

    evtSource.addEventListener("description", function (e) {
        var data = JSON.parse(e.data);
        if (data.text) addToMessageLog(data.text);
    });

    evtSource.addEventListener("effect", function (e) {
        var data = JSON.parse(e.data);
        highlightEffectPill(data.effect);
        updateOverlayForEffect(data.effect);
        currentEffect = data.effect;
    });

    evtSource.addEventListener("tone", function (e) {
        var data = JSON.parse(e.data);
        // Find nearest pill value
        var v = parseFloat(data.value);
        var nearest = v <= 0.25 ? "0" : v <= 0.75 ? "0.5" : "1";
        highlightTonePill(nearest);
        currentTone = nearest;
    });

    evtSource.onerror = function () {
        console.warn("SSE connection lost, reconnecting...");
    };

    // =========================================================================
    // Initial state
    // =========================================================================
    fetch("/api/status")
        .then(function (r) { return r.json(); })
        .then(function (data) {
            updateStartStopButton(data.active);
            highlightEffectPill(data.effect);
            updateOverlayForEffect(data.effect);
            currentEffect = data.effect;

            var v = parseFloat(data.tone);
            var nearest = v <= 0.25 ? "0" : v <= 0.75 ? "0.5" : "1";
            highlightTonePill(nearest);
            currentTone = nearest;

            if (data.description) addToMessageLog(data.description);
        })
        .catch(function (err) {
            console.warn("Failed to fetch initial status:", err);
        });

    // =========================================================================
    // Log panel collapse/expand
    // =========================================================================
    if (logCollapseBtn && messageLogPanel) {
        logCollapseBtn.addEventListener("click", function () {
            messageLogPanel.classList.add("collapsed");
            if (logExpandBtn) logExpandBtn.classList.add("visible");
        });
    }

    if (logExpandBtn && messageLogPanel) {
        logExpandBtn.addEventListener("click", function () {
            messageLogPanel.classList.remove("collapsed");
            logExpandBtn.classList.remove("visible");
        });
    }
})();
