/* PANOPTICUM — Frontend controller (HuggingFace Spaces version) */

(function () {
    "use strict";

    // --- Room & mode from server-injected globals ---
    var ROOM = window.ROOM_CODE || "";
    var MODE = window.PAGE_MODE || "controller"; // "controller" or "worker"
    var API = "/room/" + ROOM + "/api";

    // --- Client identity ---
    var CLIENT_ID = sessionStorage.getItem("panopticum_client_id");
    if (!CLIENT_ID) {
        CLIENT_ID = crypto.randomUUID();
        sessionStorage.setItem("panopticum_client_id", CLIENT_ID);
    }
    var CLIENT_LABEL = MODE.charAt(0).toUpperCase() + MODE.slice(1) + " (" + navigator.platform + ")";

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

    // Camera elements (both controller and worker)
    var localVideo = document.getElementById("local-video");
    var captureCanvas = document.getElementById("capture-canvas");

    // Worker-specific elements
    var workerStream = document.getElementById("worker-stream");
    var workerIdleMessage = document.getElementById("worker-idle-message");
    var audioPlayer = document.getElementById("audio-player");
    var audioRoboticPlayer = document.getElementById("audio-robotic-player");

    // Source controls (controller only)
    var sourceStatusEl = document.getElementById("source-status");
    var cameraSelectWrap = document.getElementById("camera-select-wrap");
    var cameraSelect = document.getElementById("camera-select");
    var clientListEl = document.getElementById("client-list");

    // --- State ---
    var isActive = false;
    var currentEffect = "natural";
    var currentTone = "0.5";
    var isSynced = true;
    var frameUploadInterval = null;
    var cameraStream = null;
    var isActiveSource = false;
    var heartbeatTimer = null;

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
    // Client registration & heartbeat
    // =========================================================================
    function registerClient() {
        fetch(API + "/register", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ client_id: CLIENT_ID, role: MODE, label: CLIENT_LABEL }),
        })
        .then(function (r) { return r.json(); })
        .then(function (data) {
            if (data.is_source) {
                handleSourceChange(true);
            } else {
                // Not the source — show MJPEG stream (deferred to avoid broken image flash)
                showMjpegStream();
            }
            if (data.clients) {
                renderClientList(data.clients);
            }
        })
        .catch(function (err) {
            console.warn("Registration error:", err);
        });
    }

    function showMjpegStream() {
        // Don't show stream on worker page when session is not active
        if (MODE === "worker" && !isActive) return;
        if (workerStream && !isActiveSource) {
            workerStream.src = "/room/" + ROOM + "/stream";
            workerStream.style.display = "";
        }
        if (localVideo) {
            localVideo.style.display = "none";
        }
    }

    function startHeartbeat() {
        if (heartbeatTimer) return;
        heartbeatTimer = setInterval(function () {
            fetch(API + "/heartbeat", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ client_id: CLIENT_ID }),
            }).catch(function () {});
        }, 10000);
    }

    function setupUnregister() {
        window.addEventListener("beforeunload", function () {
            var data = JSON.stringify({ client_id: CLIENT_ID });
            navigator.sendBeacon(API + "/unregister", new Blob([data], { type: "application/json" }));
        });
    }

    // =========================================================================
    // Camera (works on both controller and worker)
    // =========================================================================
    function startCamera(deviceId) {
        var constraints;
        if (deviceId) {
            constraints = {
                video: { deviceId: { exact: deviceId }, width: { ideal: 1280 }, height: { ideal: 720 } },
                audio: false
            };
        } else {
            constraints = {
                video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } },
                audio: false
            };
        }

        // Stop existing stream first
        stopCamera();

        navigator.mediaDevices.getUserMedia(constraints)
        .then(function (stream) {
            cameraStream = stream;
            if (localVideo) {
                localVideo.srcObject = stream;
                localVideo.style.display = "";
            }
            // Hide MJPEG stream when we're the source
            if (workerStream) {
                workerStream.style.display = "none";
            }
            console.log("Camera started");
            populateCameraSelector();
        })
        .catch(function (err) {
            console.error("Camera error:", err);
        });
    }

    function stopCamera() {
        if (cameraStream) {
            cameraStream.getTracks().forEach(function (t) { t.stop(); });
            cameraStream = null;
        }
        if (localVideo) {
            localVideo.srcObject = null;
        }
    }

    function startFrameUpload() {
        if (frameUploadInterval) return;
        frameUploadInterval = setInterval(uploadFrame, 250); // ~4fps for smooth worker display
    }

    function stopFrameUpload() {
        if (frameUploadInterval) {
            clearInterval(frameUploadInterval);
            frameUploadInterval = null;
        }
    }

    function uploadFrame() {
        if (!isActiveSource) return;
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
            body: JSON.stringify({ frame: dataUrl, client_id: CLIENT_ID }),
        }).catch(function (err) {
            console.warn("Frame upload error:", err);
        });
    }

    // Apply CSS filter to video element
    function applyVideoFilter(effect) {
        var filter = EFFECT_FILTERS[effect] || "none";
        if (localVideo) localVideo.style.filter = filter;
        if (workerStream) workerStream.style.filter = filter;
    }

    // =========================================================================
    // Source change handling
    // =========================================================================
    function handleSourceChange(amISource) {
        if (amISource === isActiveSource) return; // guard against duplicate calls
        var wasSource = isActiveSource;
        isActiveSource = amISource;

        updateSourceUI();

        if (amISource && !wasSource) {
            // I became the source — abort MJPEG, start camera
            if (workerStream) {
                workerStream.src = "";
                workerStream.style.display = "none";
            }
            startCamera();
            if (isActive) startFrameUpload();
        } else if (!amISource && wasSource) {
            // I lost source status — stop camera, show MJPEG stream
            stopFrameUpload();
            stopCamera();
            if (localVideo) localVideo.style.display = "none";
            if (workerStream) {
                workerStream.style.display = "";
                workerStream.src = "/room/" + ROOM + "/stream";
            }
        }
    }

    function updateSourceUI() {
        if (sourceStatusEl) {
            if (isActiveSource) {
                sourceStatusEl.textContent = "This device is the video source";
                sourceStatusEl.classList.add("is-source");
            } else {
                sourceStatusEl.textContent = "Another device is the video source";
                sourceStatusEl.classList.remove("is-source");
            }
        }
        if (cameraSelectWrap) {
            cameraSelectWrap.style.display = isActiveSource ? "" : "none";
        }
    }

    // =========================================================================
    // Camera device picker
    // =========================================================================
    function populateCameraSelector() {
        if (!cameraSelect) return;
        navigator.mediaDevices.enumerateDevices()
        .then(function (devices) {
            var videoDevices = devices.filter(function (d) { return d.kind === "videoinput"; });
            if (videoDevices.length <= 1) {
                // Only one camera, hide the picker
                if (cameraSelectWrap) cameraSelectWrap.style.display = "none";
                return;
            }
            if (!isActiveSource) return;

            // Get current track's device ID
            var currentDeviceId = "";
            if (cameraStream) {
                var tracks = cameraStream.getVideoTracks();
                if (tracks.length > 0 && tracks[0].getSettings) {
                    currentDeviceId = tracks[0].getSettings().deviceId || "";
                }
            }

            cameraSelect.innerHTML = "";
            videoDevices.forEach(function (dev, i) {
                var opt = document.createElement("option");
                opt.value = dev.deviceId;
                opt.textContent = dev.label || ("Camera " + (i + 1));
                if (dev.deviceId === currentDeviceId) opt.selected = true;
                cameraSelect.appendChild(opt);
            });

            if (cameraSelectWrap) cameraSelectWrap.style.display = "";
        })
        .catch(function () {});
    }

    if (cameraSelect) {
        cameraSelect.addEventListener("change", function () {
            if (cameraSelect.value) {
                startCamera(cameraSelect.value);
            }
        });
    }

    // =========================================================================
    // Client list rendering
    // =========================================================================
    function renderClientList(clients) {
        if (!clientListEl) return;

        if (!clients || clients.length === 0) {
            clientListEl.innerHTML = '<div class="client-list-empty">No connected devices</div>';
            return;
        }

        var html = "";
        for (var i = 0; i < clients.length; i++) {
            var c = clients[i];
            var isMe = c.id === CLIENT_ID;
            var cls = "client-item" + (c.is_source ? " active-source" : "");

            html += '<div class="' + cls + '">';
            html += '<span class="client-item-role">' + escapeHtml(c.role) + '</span>';
            html += '<span class="client-item-label">' + escapeHtml(c.label || c.id.slice(0, 8)) + '</span>';
            if (isMe) {
                html += '<span class="client-you-tag">You</span>';
            }
            if (c.is_source) {
                html += '<span class="client-source-badge">Source</span>';
            } else {
                html += '<button class="client-select-btn" data-client-id="' + escapeHtml(c.id) + '">Set Source</button>';
            }
            html += '</div>';
        }
        clientListEl.innerHTML = html;

        // Attach click handlers to "Set Source" buttons
        var btns = clientListEl.querySelectorAll(".client-select-btn");
        btns.forEach(function (btn) {
            btn.addEventListener("click", function () {
                var cid = btn.getAttribute("data-client-id");
                fetch(API + "/set-source", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ client_id: cid }),
                }).catch(function (err) {
                    console.warn("Set source error:", err);
                });
            });
        });
    }

    // =========================================================================
    // Worker mode setup
    // =========================================================================
    function setupWorker() {
        if (MODE !== "worker" || !workerStream) return;
        // Don't start the MJPEG stream — show idle message until session becomes active
    }

    // =========================================================================
    // Worker idle state
    // =========================================================================
    function updateWorkerIdleState(active) {
        if (MODE !== "worker") return;
        if (active) {
            // Session active — hide idle message, show video
            if (workerIdleMessage) workerIdleMessage.style.display = "none";
            if (isActiveSource) {
                if (localVideo) localVideo.style.display = "";
            } else {
                showMjpegStream();
            }
        } else {
            // Session stopped — show idle message, hide video
            if (workerIdleMessage) workerIdleMessage.style.display = "flex";
            if (workerStream) {
                workerStream.src = "";
                workerStream.style.display = "none";
            }
            if (localVideo) localVideo.style.display = "none";
        }
    }

    // Audio playback — "latest wins" strategy (no FIFO queue)
    var pendingAudio = null;       // only the latest waiting item
    var isPlayingAudio = false;

    function extractTimestampFromUrl(url) {
        // URL pattern: /room/{room_id}/audio/{timestamp}
        var parts = url.split("/");
        return parts[parts.length - 1];
    }

    function markLogEntryPlayed(audioTimestamp) {
        for (var i = 0; i < messageLog.length; i++) {
            if (messageLog[i].serverTimestamp === audioTimestamp) {
                messageLog[i].played = true;
                renderMessageLog();
                break;
            }
        }
    }

    function playAudio(url) {
        if (!audioPlayer) return;
        if (isPlayingAudio) {
            // Replace whatever was pending — latest wins
            pendingAudio = { url: url, player: audioPlayer };
        } else {
            // Nothing playing — start immediately
            startPlaying({ url: url, player: audioPlayer });
        }
    }

    function playRoboticAudio(url) {
        if (!audioRoboticPlayer) return;
        // Lyrics are best-effort — skip if narration is playing or pending
        if (isPlayingAudio || pendingAudio) return;
        startPlaying({ url: url, player: audioRoboticPlayer });
    }

    function startPlaying(item) {
        isPlayingAudio = true;
        var ts = extractTimestampFromUrl(item.url);
        markLogEntryPlayed(ts);
        item.player.src = item.url;
        item.player.play().catch(function (err) {
            console.warn("Audio play error:", err);
            isPlayingAudio = false;
            playNext();
        });
        item.player.onended = function () {
            isPlayingAudio = false;
            playNext();
        };
        item.player.onerror = function () {
            isPlayingAudio = false;
            playNext();
        };
    }

    function playNext() {
        if (pendingAudio) {
            var item = pendingAudio;
            pendingAudio = null;
            startPlaying(item);
        }
    }

    // =========================================================================
    // Start/Stop
    // =========================================================================
    function updateStartStopButton(active) {
        isActive = active;
        if (!startStopBtn) return;
        if (active) {
            startStopBtn.textContent = "STOP PANOPTICUM";
            startStopBtn.classList.remove("inactive");
            startStopBtn.classList.add("active");
        } else {
            startStopBtn.textContent = "START PANOPTICUM";
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

            // Start/stop frame upload if we're the source
            if (isActiveSource) {
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
            var cls = "message-log-item";
            if (i === 0) {
                cls += " latest";
            } else if (!msg.played && msg.serverTimestamp) {
                cls += " skipped";
            }
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

    function addToMessageLog(text, tone, serverTimestamp) {
        var now = new Date();
        var h = String(now.getHours()).padStart(2, "0");
        var mi = String(now.getMinutes()).padStart(2, "0");
        var s = String(now.getSeconds()).padStart(2, "0");
        messageLog.unshift({
            text: text,
            time: h + ":" + mi + ":" + s,
            tone: tone !== undefined ? tone : 0.5,
            serverTimestamp: serverTimestamp || null,
            played: false,
        });
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
        updateWorkerIdleState(data.active);

        // Auto-start/stop frame upload if we're the source
        if (isActiveSource) {
            if (data.active) {
                startFrameUpload();
            } else {
                stopFrameUpload();
            }
        }
    });

    evtSource.addEventListener("description", function (e) {
        var data = JSON.parse(e.data);
        if (data.text) addToMessageLog(data.text, data.tone, data.timestamp ? String(data.timestamp) : null);
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

    evtSource.addEventListener("clients", function (e) {
        var data = JSON.parse(e.data);
        var amISource = data.active_source === CLIENT_ID;
        if (amISource !== isActiveSource) {
            handleSourceChange(amISource);
        }
        renderClientList(data.clients || []);
    });

    // Audio events (worker mode)
    evtSource.addEventListener("audio", function (e) {
        if (MODE !== "worker") return;
        var data = JSON.parse(e.data);
        if (data.url) playAudio(data.url);
    });

    evtSource.addEventListener("audio_robotic", function (e) {
        if (MODE !== "worker") return;
        var data = JSON.parse(e.data);
        if (data.url) playRoboticAudio(data.url);
    });

    var lyricsTimeout = null;
    evtSource.addEventListener("lyrics", function (e) {
        var data = JSON.parse(e.data);
        if (!cctvLyricsEl || !data.text) return;
        if (lyricsTimeout) clearTimeout(lyricsTimeout);
        cctvLyricsEl.textContent = data.text;
        // Ensure lyrics element is visible when in CCTV mode
        cctvLyricsEl.style.display = "block";
        cctvLyricsEl.classList.remove("visible");
        void cctvLyricsEl.offsetWidth; // force reflow for CSS transition
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
            updateWorkerIdleState(data.active);
            highlightEffectPill(data.effect);
            updateOverlayForEffect(data.effect);
            currentEffect = data.effect;

            var v = parseFloat(data.tone);
            var nearest = v <= 0.25 ? "0" : v <= 0.75 ? "0.5" : "1";
            highlightTonePill(nearest);
            currentTone = nearest;

            if (data.description) addToMessageLog(data.description, data.tone);

            // If already active and we're the source, start frame upload
            if (data.active && isActiveSource) {
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
    registerClient();
    startHeartbeat();
    setupUnregister();

    if (MODE === "controller") {
        // Hide video; MJPEG stream starts after registration confirms source status
        if (localVideo) {
            localVideo.style.display = "none";
        }
    } else if (MODE === "worker") {
        setupWorker();
    }
})();
