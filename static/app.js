/* PANOPTICUM — Frontend controller (HuggingFace Spaces version) */

(function () {
    "use strict";

    // --- Room & mode from server-injected globals ---
    var ROOM = window.ROOM_CODE || "";
    var MODE = window.PAGE_MODE || "controller"; // "controller" or "exhibition"
    var API = "/room/" + ROOM + "/api";

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
    var cctvLyricsEl = document.getElementById("cctv-lyrics");

    var effectPills = document.querySelectorAll("#effect-pills .pill-btn");
    var tonePills = document.querySelectorAll("#tone-pills .pill-btn");

    // Overlay elements
    var overlayTop = document.querySelector(".overlay-top");
    var camLabel = document.querySelector(".cam-label");
    var scanlines = document.querySelector(".scanlines");
    var vignette = document.querySelector(".vignette");

    // Controller-specific elements
    var localVideo = document.getElementById("local-video");
    var captureCanvas = document.getElementById("capture-canvas");

    // Exhibition-specific elements
    var exhibitStream = document.getElementById("exhibit-stream");
    var audioPlayer = document.getElementById("audio-player");
    var audioRoboticPlayer = document.getElementById("audio-robotic-player");

    // --- State ---
    var isActive = false;
    var currentEffect = "natural";
    var currentTone = "0.5";
    var isSynced = true;
    var frameUploadInterval = null;
    var cameraStream = null;

    // --- CSS filter map for effects ---
    var EFFECT_FILTERS = {
        "insta": "sepia(0.4) brightness(1.1) saturate(1.2) contrast(1.05)",
        "natural": "none",
        "cctv": "grayscale(1) brightness(0.85) contrast(1.3)"
    };

    // --- Sync mapping ---
    var EFFECT_TO_TONE = { "insta": "0", "natural": "0.5", "cctv": "1" };
    var TONE_TO_EFFECT = { "0": "insta", "0.5": "natural", "1": "cctv" };

    // --- Message log ---
    var messageLog = [];
    var MAX_LOG_MESSAGES = 10;

    // --- Motivational messages ---
    var MOTIVATIONAL_MESSAGES = [
        "Take a breath.\nYou're exactly where you need to be.",
        "Progress is invisible\nuntil it isn't.",
        "Small steps.\nBig things.",
        "You don't have to be perfect.\nYou just have to begin.",
        "The work you're doing matters\nmore than you think.",
        "Stay curious.\nStay kind to yourself.",
        "One thing at a time.\nThat's enough.",
        "Rest is not the opposite of productivity.\nIt's the source of it.",
        "You are not your to-do list.",
        "Deep focus is a superpower.\nYou already have it.",
        "Trust the process.\nEven the slow days count.",
        "Your pace is valid.",
        "Breathe in purpose.\nBreathe out doubt.",
        "Not every hour needs to be optimized.\nSome just need to be lived.",
        "You showed up.\nThat's the hardest part.",
        "Clarity comes from action,\nnot from waiting.",
        "Be gentle with yourself.\nYou're doing a good job.",
        "The best ideas arrive\nwhen you stop forcing them.",
    ];
    var motivationalIndex = 0;
    var motivationalInterval = null;

    // =========================================================================
    // Camera (controller mode only)
    // =========================================================================
    function startCamera() {
        if (MODE !== "controller" || !localVideo) return;

        navigator.mediaDevices.getUserMedia({
            video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } },
            audio: false
        })
        .then(function (stream) {
            cameraStream = stream;
            localVideo.srcObject = stream;
            console.log("Camera started");
        })
        .catch(function (err) {
            console.error("Camera error:", err);
        });
    }

    function startFrameUpload() {
        if (frameUploadInterval) return;
        frameUploadInterval = setInterval(uploadFrame, 250); // ~4fps for smooth exhibition
    }

    function stopFrameUpload() {
        if (frameUploadInterval) {
            clearInterval(frameUploadInterval);
            frameUploadInterval = null;
        }
    }

    function uploadFrame() {
        if (!localVideo || !captureCanvas || !cameraStream) return;
        if (localVideo.videoWidth === 0) return; // not ready yet

        var ctx = captureCanvas.getContext("2d");
        captureCanvas.width = localVideo.videoWidth;
        captureCanvas.height = localVideo.videoHeight;
        ctx.drawImage(localVideo, 0, 0);

        var dataUrl = captureCanvas.toDataURL("image/jpeg", 0.5);

        fetch(API + "/frame", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ frame: dataUrl }),
        }).catch(function (err) {
            console.warn("Frame upload error:", err);
        });
    }

    // Apply CSS filter to video element
    function applyVideoFilter(effect) {
        var filter = EFFECT_FILTERS[effect] || "none";
        if (localVideo) localVideo.style.filter = filter;
        if (exhibitStream) exhibitStream.style.filter = filter;
    }

    // =========================================================================
    // Exhibition mode setup
    // =========================================================================
    function setupExhibition() {
        if (MODE !== "exhibition" || !exhibitStream) return;
        exhibitStream.src = "/room/" + ROOM + "/stream";
    }

    // Audio playback queue for exhibition
    var audioQueue = [];
    var isPlayingAudio = false;

    function playAudio(url) {
        if (!audioPlayer) return;
        audioQueue.push({ url: url, player: audioPlayer });
        processAudioQueue();
    }

    function playRoboticAudio(url) {
        if (!audioRoboticPlayer) return;
        audioQueue.push({ url: url, player: audioRoboticPlayer });
        processAudioQueue();
    }

    function processAudioQueue() {
        if (isPlayingAudio || audioQueue.length === 0) return;
        isPlayingAudio = true;

        var item = audioQueue.shift();
        var player = item.player;
        player.src = item.url;
        player.play().then(function () {
            // playing
        }).catch(function (err) {
            console.warn("Audio play error:", err);
            isPlayingAudio = false;
            processAudioQueue();
        });

        player.onended = function () {
            isPlayingAudio = false;
            processAudioQueue();
        };
        player.onerror = function () {
            isPlayingAudio = false;
            processAudioQueue();
        };
    }

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
            var newActive = !isActive;
            fetch(API + "/active", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ active: newActive }),
            });

            // Start/stop frame upload on controller
            if (MODE === "controller") {
                if (newActive) {
                    startFrameUpload();
                } else {
                    stopFrameUpload();
                }
            }
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
        var isInsta = effect === "insta";

        if (overlayTop) overlayTop.style.display = isCctv ? "flex" : "none";
        if (camLabel) camLabel.style.display = isCctv ? "block" : "none";
        if (scanlines) scanlines.style.display = isCctv ? "block" : "none";
        if (vignette) vignette.style.display = isInsta ? "block" : "none";
        if (cctvLyricsEl) cctvLyricsEl.style.display = isCctv ? "block" : "none";

        if (motivationalEl) {
            motivationalEl.style.display = isInsta ? "flex" : "none";
        }

        if (isInsta) {
            startMotivationalRotation();
        } else {
            stopMotivationalRotation();
        }

        // Apply CSS filter
        applyVideoFilter(effect);
    }

    // =========================================================================
    // Motivational message rotation
    // =========================================================================
    function showNextMotivational() {
        if (!motivationalEl) return;
        var textEl = document.getElementById("motivational-text");
        if (!textEl) return;
        textEl.classList.remove("visible");
        setTimeout(function () {
            textEl.textContent = MOTIVATIONAL_MESSAGES[motivationalIndex];
            motivationalIndex = (motivationalIndex + 1) % MOTIVATIONAL_MESSAGES.length;
            textEl.classList.add("visible");
        }, 1500);
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
        var textEl = document.getElementById("motivational-text");
        if (textEl) textEl.classList.remove("visible");
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
        fetch(API + "/effect", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ effect: effect }),
        });
        highlightEffectPill(effect);
        updateOverlayForEffect(effect);

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
        fetch(API + "/tone", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ value: parseFloat(toneValue) }),
        });
        highlightTonePill(toneValue);

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
            if (isSynced && EFFECT_TO_TONE[currentEffect] !== undefined) {
                setTone(EFFECT_TO_TONE[currentEffect], true);
            }
        });
    }

    // =========================================================================
    // Message log
    // =========================================================================
    function toneLabel(tone) {
        var v = parseFloat(tone);
        if (v <= 0.25) return '<span class="tone-tag tone-supportive">Supportive</span>';
        if (v <= 0.75) return '<span class="tone-tag tone-neutral">Neutral</span>';
        return '<span class="tone-tag tone-judgmental">Judgmental</span>';
    }

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
            html += '<span class="message-log-time">' + (msg.time || "") + ' ' + toneLabel(msg.tone) + '</span>';
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

    function addToMessageLog(text, tone) {
        var now = new Date();
        var h = String(now.getHours()).padStart(2, "0");
        var mi = String(now.getMinutes()).padStart(2, "0");
        var s = String(now.getSeconds()).padStart(2, "0");
        messageLog.unshift({ text: text, time: h + ":" + mi + ":" + s, tone: tone !== undefined ? tone : 0.5 });
        if (messageLog.length > MAX_LOG_MESSAGES) messageLog.pop();
        renderMessageLog();
    }

    // =========================================================================
    // SSE listeners
    // =========================================================================
    var evtSource = new EventSource("/room/" + ROOM + "/events");

    evtSource.addEventListener("active", function (e) {
        var data = JSON.parse(e.data);
        updateStartStopButton(data.active);

        // Auto-start/stop frame upload on controller
        if (MODE === "controller") {
            if (data.active) {
                startFrameUpload();
            } else {
                stopFrameUpload();
            }
        }
    });

    evtSource.addEventListener("description", function (e) {
        var data = JSON.parse(e.data);
        if (data.text) addToMessageLog(data.text, data.tone);
    });

    evtSource.addEventListener("effect", function (e) {
        var data = JSON.parse(e.data);
        highlightEffectPill(data.effect);
        updateOverlayForEffect(data.effect);
        currentEffect = data.effect;
    });

    evtSource.addEventListener("tone", function (e) {
        var data = JSON.parse(e.data);
        var v = parseFloat(data.value);
        var nearest = v <= 0.25 ? "0" : v <= 0.75 ? "0.5" : "1";
        highlightTonePill(nearest);
        currentTone = nearest;
    });

    // Audio events (exhibition mode)
    evtSource.addEventListener("audio", function (e) {
        if (MODE !== "exhibition") return;
        var data = JSON.parse(e.data);
        if (data.url) playAudio(data.url);
    });

    evtSource.addEventListener("audio_robotic", function (e) {
        if (MODE !== "exhibition") return;
        var data = JSON.parse(e.data);
        if (data.url) playRoboticAudio(data.url);
    });

    var lyricsTimeout = null;
    evtSource.addEventListener("lyrics", function (e) {
        var data = JSON.parse(e.data);
        if (!cctvLyricsEl || !data.text) return;
        if (lyricsTimeout) clearTimeout(lyricsTimeout);
        cctvLyricsEl.textContent = data.text;
        cctvLyricsEl.classList.add("visible");
        lyricsTimeout = setTimeout(function () {
            cctvLyricsEl.classList.remove("visible");
        }, 8000);
    });

    evtSource.onerror = function () {
        console.warn("SSE connection lost, reconnecting...");
    };

    // =========================================================================
    // Initial state
    // =========================================================================
    fetch(API + "/status")
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

            if (data.description) addToMessageLog(data.description, data.tone);

            // If already active, start frame upload
            if (data.active && MODE === "controller") {
                startFrameUpload();
            }
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

    // =========================================================================
    // Initialize
    // =========================================================================
    if (MODE === "controller") {
        startCamera();
    } else if (MODE === "exhibition") {
        setupExhibition();
    }
})();
