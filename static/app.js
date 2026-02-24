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
    var STORED_WORKER_ID = sessionStorage.getItem("panopticum_worker_id");
    var CLIENT_LABEL = STORED_WORKER_ID || (MODE.charAt(0).toUpperCase() + MODE.slice(1) + " (" + navigator.platform + ")");

    // --- Loading screen ---
    function showLoadingScreen(duration, callback) {
        var el = document.getElementById("loading-screen");
        if (!el) { if (callback) callback(); return; }

        el.classList.remove("revealing", "revealed");
        el.style.display = "flex";

        setTimeout(function () {
            if (window._loadingDrops) clearInterval(window._loadingDrops);
            try { if (window.jQuery) $('#loading-screen').ripples('destroy'); } catch (e) {}

            document.body.classList.add("content-blurred");
            el.style.display = "none";

            requestAnimationFrame(function () {
                requestAnimationFrame(function () {
                    document.body.classList.add("content-revealing");
                });
            });

            setTimeout(function () {
                document.body.classList.remove("content-blurred", "content-revealing");
                if (callback) callback();
            }, 4500);
        }, duration);
    }

    function hideLoadingScreen() {
        var el = document.getElementById("loading-screen");
        if (!el) return;
        if (window._loadingDrops) clearInterval(window._loadingDrops);
        try { if (window.jQuery) $('#loading-screen').ripples('destroy'); } catch (e) {}
        el.style.display = "none";
        document.body.classList.remove("content-blurred", "content-revealing");
    }

    // Skip loading screen — hide immediately
    hideLoadingScreen();

    // --- Elements ---
    var startStopBtn = document.getElementById("start-stop-btn");
    var messageLogList = document.getElementById("message-log-list");
    var messageLogPanel = document.getElementById("message-log");
    var logCollapseBtn = document.getElementById("log-collapse-btn");
    var logExpandBtn = document.getElementById("log-expand-btn");

    var tonePills = document.querySelectorAll("#tone-pills .ctrl-option");

    // Slider elements
    var frequencySlider = document.getElementById("frequency-slider");
    var frequencyValue = document.getElementById("frequency-value");
    var commentLengthSlider = document.getElementById("comment-length-slider");
    var commentLengthValue = document.getElementById("comment-length-value");
    var heatStrengthSlider = document.getElementById("heat-strength-slider");
    var heatStrengthValue = document.getElementById("heat-strength-value");
    var freezeTimeSlider = document.getElementById("freeze-time-slider");
    var freezeTimeValue = document.getElementById("freeze-time-value");
    var heatRadiusSlider = document.getElementById("heat-radius-slider");
    var heatRadiusValue = document.getElementById("heat-radius-value");

    // Camera elements (worker only — controller no longer captures video)
    var localVideo = document.getElementById("local-video");
    var captureCanvas = document.getElementById("capture-canvas");

    // Video display
    var workerStream = document.getElementById("worker-stream") || document.getElementById("worker-stream-canvas");
    var _streamCanvas = document.getElementById("worker-stream-canvas");
    var _streamCtx = _streamCanvas ? _streamCanvas.getContext("2d") : null;
    var _pixelCanvas = null;  // tiny offscreen canvas for pixelation
    var _pixelCtx = null;
    var PIXEL_SIZE = 80;      // render at 80x80 then upscale → visible but recognizable pixels
    var POSTERIZE_LEVELS = 8; // number of brightness levels
    var workerIdleMessage = document.getElementById("worker-idle-message");
    var workerActiveScreen = document.getElementById("worker-active-screen");
    var audioPlayer = document.getElementById("audio-player");
    var audioRoboticPlayer = document.getElementById("audio-robotic-player");
    var idleClockEl = document.getElementById("worker-clock");
    var workerInfoEl = document.getElementById("worker-info");
    var idleRoomCodeEl = document.getElementById("idle-room-code");
    var workerIdInput = document.getElementById("worker-id-input");
    var workerIdBtn = document.getElementById("worker-id-btn");

    var clientListEl = document.getElementById("client-list");

    // Action mode elements
    var actionSettingPills = document.querySelectorAll("#action-setting-pills .ctrl-option");
    var actionPhaseLabel = document.getElementById("action-phase-label");
    var actionRequestedText = document.getElementById("action-requested-text");
    var actionTriggerBtn = document.getElementById("action-trigger-btn");

    // Work mode elements
    var workBtn = document.getElementById("work-btn");
    var workScoreContainer = document.getElementById("work-score-container");
    var workScoreCanvas = document.getElementById("work-score-canvas");
    var workScoreLabel = document.getElementById("work-score-label");

    // --- State ---
    var isActive = false;
    var isWorkActive = false;
    var currentTone = "0.5";
    var frameUploadInterval = null;
    var cameraStream = null;
    var isActiveSource = false;
    var heartbeatTimer = null;
    var currentActionSetting = "manual";
    var currentActionPhase = "commenting";
    var currentFrequency = 8;
    var currentCommentLength = 10;
    var _mjpegRetryTimer = null;

    // --- Iris wipe transition ---
    var _irisAnimating = false;
    var _irisPendingState = null;

    // --- Message log ---
    var messageLog = [];
    var MAX_LOG_MESSAGES = 10;

    // =========================================================================
    // Client registration & heartbeat
    // =========================================================================
    function registerClient() {
        fetch(API + "/register", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ client_id: CLIENT_ID, role: MODE, label: CLIENT_LABEL }),
        })
        .then(function (r) {
            if (r.status === 409) {
                // Room occupied — worker rejected
                handleWorkerRejection();
                return null;
            }
            return r.json();
        })
        .then(function (data) {
            if (!data) return;
            if (MODE === "worker") {
                // Worker is always the video source
                isActiveSource = true;
            }
            if (data.clients) {
                renderClientList(data.clients);
            }
        })
        .catch(function (err) {
            console.warn("Registration error:", err);
        });
    }

    function processAndDrawFrame(img) {
        if (!_streamCanvas || !_streamCtx || !isActive) return;

        // Lazy-init tiny offscreen canvas
        if (!_pixelCanvas) {
            _pixelCanvas = document.createElement("canvas");
            _pixelCanvas.width = PIXEL_SIZE;
            _pixelCanvas.height = PIXEL_SIZE;
            _pixelCtx = _pixelCanvas.getContext("2d");
        }

        // Center-crop source to square, then draw into tiny canvas (downscale → pixelation)
        var sw = img.naturalWidth;
        var sh = img.naturalHeight;
        var side = Math.min(sw, sh);
        var sx = (sw - side) / 2;
        var sy = (sh - side) / 2;
        _pixelCtx.drawImage(img, sx, sy, side, side, 0, 0, PIXEL_SIZE, PIXEL_SIZE);

        // Grayscale + posterize on the tiny canvas (few pixels = fast)
        var imageData = _pixelCtx.getImageData(0, 0, PIXEL_SIZE, PIXEL_SIZE);
        var d = imageData.data;
        var step = 255 / (POSTERIZE_LEVELS - 1);
        for (var i = 0; i < d.length; i += 4) {
            var gray = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
            gray = Math.round(gray / step) * step;
            d[i] = gray;
            d[i + 1] = gray;
            d[i + 2] = gray;
        }
        _pixelCtx.putImageData(imageData, 0, 0);

        // Draw tiny canvas to display canvas (upscale with no smoothing → crisp pixels)
        _streamCtx.imageSmoothingEnabled = false;
        _streamCtx.drawImage(_pixelCanvas, 0, 0, _streamCanvas.width, _streamCanvas.height);
        _streamCanvas.style.display = "";
    }

    function startSnapshotPolling() {
        stopSnapshotPolling();
        _mjpegRetryTimer = setInterval(function () {
            if (!_streamCanvas || !isActive) return;
            var img = new Image();
            img.onload = function () {
                processAndDrawFrame(img);
            };
            img.src = "/room/" + ROOM + "/stream/snapshot?t=" + Date.now();
        }, 500);
    }

    function stopSnapshotPolling() {
        if (_mjpegRetryTimer) {
            clearInterval(_mjpegRetryTimer);
            _mjpegRetryTimer = null;
        }
    }

    function startCtrlRipples() {
        stopCtrlRipples();
        if (!window.jQuery) return;
        var el = document.getElementById("ctrl-screen");
        if (!el) return;
        window._ctrlRipplesDrop = setInterval(function () {
            if (!el.clientWidth) return;
            var cx = el.clientWidth / 2;
            var cy = el.clientHeight / 2;
            $("#ctrl-screen").ripples("drop", cx, cy, 40, 0.6);
        }, 2000);
    }

    function stopCtrlRipples() {
        if (window._ctrlRipplesDrop) {
            clearInterval(window._ctrlRipplesDrop);
            window._ctrlRipplesDrop = null;
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
    // Camera (worker only)
    // =========================================================================
    function startCamera() {
        var constraints = {
            video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } },
            audio: false
        };

        // Stop existing stream first
        stopCamera();

        navigator.mediaDevices.getUserMedia(constraints)
        .then(function (stream) {
            cameraStream = stream;
            if (localVideo) {
                localVideo.srcObject = stream;
                localVideo.play().catch(function () {});
            }
            console.log("Camera started");
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

    var UPLOAD_MAX_WIDTH = 640;

    function uploadFrame() {
        if (!isActiveSource) return;
        if (!localVideo || !captureCanvas || !cameraStream) return;
        if (localVideo.videoWidth === 0) return; // not ready yet

        var ctx = captureCanvas.getContext("2d");
        var w = localVideo.videoWidth;
        var h = localVideo.videoHeight;
        if (w > UPLOAD_MAX_WIDTH) {
            h = Math.round(h * UPLOAD_MAX_WIDTH / w);
            w = UPLOAD_MAX_WIDTH;
        }
        captureCanvas.width = w;
        captureCanvas.height = h;
        ctx.drawImage(localVideo, 0, 0, w, h);

        var dataUrl = captureCanvas.toDataURL("image/jpeg", 0.5);

        fetch(API + "/frame", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ frame: dataUrl, client_id: CLIENT_ID }),
        }).catch(function (err) {
            console.warn("Frame upload error:", err);
        });
    }

    // =========================================================================
    // Worker rejection handling (room occupied)
    // =========================================================================
    function handleWorkerRejection() {
        // Cancel any in-progress iris transition
        _irisAnimating = false;
        _irisPendingState = null;
        var idleContent = document.getElementById("worker-idle-content");
        var activeContent = document.getElementById("worker-active-content");
        if (idleContent) idleContent.style.clipPath = "";
        if (activeContent) activeContent.style.clipPath = "";

        // Show idle screen with rejection message
        if (workerIdleMessage) workerIdleMessage.style.display = "flex";
        if (workerActiveScreen) workerActiveScreen.style.display = "none";

        var sloganEl = document.getElementById("worker-idle-slogan");
        if (sloganEl) {
            sloganEl.textContent = "";
            _sloganTyped = true; // prevent normal typewriter
            var lines = ["This workstation is occupied.", "Pursue productivity elsewhere."];
            var lineIdx = 0;
            var charIdx = 0;
            function typeNext() {
                if (lineIdx >= lines.length) return;
                if (charIdx < lines[lineIdx].length) {
                    sloganEl.appendChild(document.createTextNode(lines[lineIdx][charIdx]));
                    charIdx++;
                    setTimeout(typeNext, 80);
                } else {
                    lineIdx++;
                    charIdx = 0;
                    if (lineIdx < lines.length) {
                        sloganEl.appendChild(document.createElement("br"));
                        setTimeout(typeNext, 400);
                    }
                }
            }
            setTimeout(typeNext, 500);
        }

        // Hide ID input and status
        var idBox = document.querySelector(".worker-idle-id");
        if (idBox) idBox.style.display = "none";
        var statusEl = document.querySelector(".worker-idle-status");
        if (statusEl) statusEl.style.display = "none";

        // Don't start heartbeat or SSE — disconnect
        if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
        if (evtSource) { evtSource.close(); }
    }

    // =========================================================================
    // Client list rendering
    // =========================================================================
    function renderClientList(clients) {
        // Update worker label and registration state
        _workerLabel = null;
        _workerRegistered = false;
        if (clients) {
            for (var w = 0; w < clients.length; w++) {
                if (clients[w].role === "worker") {
                    var lbl = clients[w].label || "";
                    // Default labels like "Worker (Win32)" mean no Employee ID registered
                    if (lbl && !/^Worker\s*\(/.test(lbl)) {
                        _workerLabel = lbl;
                        _workerRegistered = true;
                    } else {
                        _workerLabel = "NOT REGISTERED";
                    }
                    break;
                }
            }
        }
        updateWorkerInfo();
        updateStartButtonState();

        if (!clientListEl) return;

        if (!clients || clients.length === 0) {
            clientListEl.innerHTML = '<div class="client-list-empty">No connected devices</div>';
            return;
        }

        var html = "";
        for (var i = 0; i < clients.length; i++) {
            var c = clients[i];
            var isMe = c.id === CLIENT_ID;
            var cls = "client-item";
            var displayLabel;
            if (c.role === "worker") {
                if (!c.label || /^Worker\s*\(/.test(c.label)) {
                    displayLabel = "Worker (not registered)";
                } else {
                    displayLabel = "Worker (" + c.label + ")";
                }
            } else {
                displayLabel = c.label || c.id.slice(0, 8);
            }

            html += '<div class="' + cls + '">';
            html += '<span class="client-item-label">' + escapeHtml(displayLabel) + '</span>';
            if (isMe) {
                html += '<span class="client-you-tag">You</span>';
            }
            html += '</div>';
        }
        clientListEl.innerHTML = html;
    }

    // =========================================================================
    // Worker mode setup
    // =========================================================================
    function setupWorker() {
        if (MODE !== "worker") return;
        // Idle message is shown by default; active screen shown when SSE active event fires
    }

    // =========================================================================
    // Worker idle clock
    // =========================================================================
    function updateIdleClock() {
        if (!idleClockEl) return;
        var now = new Date();
        var y = now.getFullYear();
        var mo = String(now.getMonth() + 1).padStart(2, "0");
        var d = String(now.getDate()).padStart(2, "0");
        var h = String(now.getHours()).padStart(2, "0");
        var mi = String(now.getMinutes()).padStart(2, "0");
        var s = String(now.getSeconds()).padStart(2, "0");
        idleClockEl.textContent = y + "-" + mo + "-" + d + "  " + h + ":" + mi + ":" + s;
    }
    setInterval(updateIdleClock, 1000);
    updateIdleClock();

    var _workerLabel = null;
    var _workerRegistered = false;

    function updateWorkerInfo() {
        if (!workerInfoEl) return;
        var parts = [];
        if (ROOM) parts.push('<a href="/" class="room-link">ROOM:</a> <span class="room-code-copy clickable">' + escapeHtml(ROOM) + '</span>');
        if (MODE === "controller") {
            parts.push("WORKER: " + escapeHtml(_workerLabel || "NOT CONNECTED"));
        } else {
            if (STORED_WORKER_ID) {
                parts.push('ID: <span class="worker-id-edit clickable">' + escapeHtml(STORED_WORKER_ID) + '</span>');
            } else {
                parts.push("ID: NOT REGISTERED");
            }
        }
        workerInfoEl.innerHTML = parts.join("  /  ");
    }
    updateWorkerInfo();

    // Click-to-copy room code
    if (workerInfoEl) {
        workerInfoEl.addEventListener("click", function (e) {
            var target = e.target;
            if (target.classList.contains("worker-id-edit")) {
                if (workerIdleMessage && workerIdleMessage.style.display !== "none") {
                    var idBox = document.querySelector(".worker-idle-id");
                    if (idBox) {
                        idBox.classList.add("visible");
                        if (workerIdInput && STORED_WORKER_ID) {
                            workerIdInput.value = STORED_WORKER_ID;
                            workerIdInput.focus();
                        }
                        if (workerIdBtn) workerIdBtn.textContent = "REGISTER";
                    }
                }
                return;
            }
            if (!target.classList.contains("room-code-copy")) return;
            navigator.clipboard.writeText(ROOM).then(function () {
                var tip = document.createElement("span");
                tip.className = "copy-tooltip";
                tip.textContent = "Copied!";
                tip.style.left = (e.clientX + 10) + "px";
                tip.style.top = (e.clientY + 15) + "px";
                document.body.appendChild(tip);
                setTimeout(function () { tip.remove(); }, 1500);
            });
        });
    }

    // Populate room code on idle screen
    if (idleRoomCodeEl && ROOM) {
        idleRoomCodeEl.textContent = "Room: " + ROOM;
    }

    // =========================================================================
    // Worker idle slogan typewriter
    // =========================================================================
    var _sloganTyped = false;

    function startSloganTypewriter() {
        var sloganEl = document.getElementById("worker-idle-slogan");
        if (!sloganEl) return;
        if (_sloganTyped) return;
        _sloganTyped = true;
        sloganEl.textContent = "";
        sloganEl.classList.add("typing");
        var lines = ["Your productivity", "is our priority."];
        var lineIdx = 0;
        var charIdx = 0;

        function typeNext() {
            if (lineIdx >= lines.length) {
                sloganEl.classList.remove("typing");
                sloganEl.classList.add("typed");
                var idBox = document.querySelector(".worker-idle-id");
                if (idBox && !STORED_WORKER_ID) idBox.classList.add("visible");
                var statusText = document.getElementById("worker-idle-status-text");
                if (statusText) {
                    statusText.style.display = "";
                    statusText.classList.add("visible");
                }
                return;
            }
            if (charIdx < lines[lineIdx].length) {
                sloganEl.appendChild(document.createTextNode(lines[lineIdx][charIdx]));
                charIdx++;
                setTimeout(typeNext, 80);
            } else {
                lineIdx++;
                charIdx = 0;
                if (lineIdx < lines.length) {
                    sloganEl.appendChild(document.createElement("br"));
                    setTimeout(typeNext, 400);
                } else {
                    typeNext();
                }
            }
        }
        setTimeout(typeNext, 500);
    }

    // =========================================================================
    // Worker ID registration
    // =========================================================================
    function registerWorkerId() {
        if (!workerIdInput) return;
        var val = workerIdInput.value.trim();
        if (!val) return;
        CLIENT_LABEL = val;
        STORED_WORKER_ID = val;
        sessionStorage.setItem("panopticum_worker_id", val);
        updateWorkerInfo();
        fetch(API + "/register", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ client_id: CLIENT_ID, role: MODE, label: val }),
        }).then(function () {
            if (workerIdBtn) {
                workerIdBtn.textContent = "REGISTERED";
            }
            var idBox = document.querySelector(".worker-idle-id");
            if (idBox) {
                setTimeout(function () { idBox.classList.remove("visible"); }, 800);
            }
        }).catch(function (err) {
            console.warn("Worker ID registration error:", err);
        });
    }

    if (workerIdBtn) {
        workerIdBtn.addEventListener("click", registerWorkerId);
    }
    if (workerIdInput) {
        workerIdInput.addEventListener("keydown", function (e) {
            if (e.key === "Enter") registerWorkerId();
        });
        // Restore saved ID
        if (STORED_WORKER_ID) {
            workerIdInput.value = STORED_WORKER_ID;
        }
    }

    // =========================================================================
    // Worker idle state + iris wipe transition
    // =========================================================================
    function irisFullRadius() {
        var vw = window.innerWidth;
        var vh = window.innerHeight;
        return Math.sqrt(vw * vw + vh * vh) / 2;
    }

    function irisTransition(toActive, onSwap, onComplete) {
        var CLOSE_DURATION = 3000;
        var PAUSE_DURATION = 1000;
        var OPEN_DURATION = 3000;

        var outgoingContainer = toActive ? workerIdleMessage : workerActiveScreen;
        var incomingContainer = toActive ? workerActiveScreen : workerIdleMessage;
        if (!outgoingContainer || !incomingContainer) return;

        // Clip the content wrappers, not the containers (preserves ripple backgrounds)
        var outgoingContent = document.getElementById(toActive ? "worker-idle-content" : "worker-active-content");
        var incomingContent = document.getElementById(toActive ? "worker-active-content" : "worker-idle-content");
        if (!outgoingContent || !incomingContent) return;

        var maxR = irisFullRadius();
        var cx = window.innerWidth / 2;
        var cy = window.innerHeight / 2;

        _irisAnimating = true;

        // Debug ring overlay
        var ring = document.getElementById("iris-debug-ring");
        if (!ring) {
            ring = document.createElement("div");
            ring.id = "iris-debug-ring";
            ring.style.cssText = "position:fixed;top:0;left:0;width:100vw;height:100vh;z-index:99999;pointer-events:none";
            ring.innerHTML = '<svg width="100%" height="100%" style="position:absolute;top:0;left:0"><circle id="iris-debug-circle" cx="0" cy="0" r="0" fill="none" stroke="white" stroke-width="1"/></svg>';
            document.body.appendChild(ring);
        }
        var debugCircle = document.getElementById("iris-debug-circle");
        function updateDebugRing(r, opacity) {
            if (debugCircle) {
                debugCircle.setAttribute("cx", cx);
                debugCircle.setAttribute("cy", cy);
                debugCircle.setAttribute("r", Math.max(0, r));
                debugCircle.setAttribute("stroke-opacity", opacity !== undefined ? opacity : 1);
            }
        }
        function hideDebugRing() {
            if (debugCircle) {
                debugCircle.setAttribute("r", "0");
                debugCircle.setAttribute("stroke-opacity", "0");
            }
        }

        var startTime = null;
        function animateClose(timestamp) {
            if (!_irisAnimating) { hideDebugRing(); return; }
            if (!startTime) startTime = timestamp;
            var elapsed = timestamp - startTime;
            var progress = Math.min(elapsed / CLOSE_DURATION, 1);
            var eased = progress * progress;
            var radius = maxR * (1 - eased);

            outgoingContent.style.clipPath = "circle(" + radius + "px at " + cx + "px " + cy + "px)";
            var ringOpacity = progress < 0.4 ? 0 : (progress - 0.4) / 0.6;
            updateDebugRing(radius, ringOpacity);

            if (progress < 1) {
                requestAnimationFrame(animateClose);
            } else {
                outgoingContent.style.clipPath = "circle(0px at " + cx + "px " + cy + "px)";
                updateDebugRing(0);

                setTimeout(function () {
                    if (!_irisAnimating) { hideDebugRing(); return; }

                    outgoingContent.style.clipPath = "";
                    outgoingContainer.style.display = "none";

                    if (onSwap) onSwap();

                    incomingContainer.style.display = "flex";
                    incomingContent.style.clipPath = "circle(0px at " + cx + "px " + cy + "px)";
                    // Force reflow so clip-path is applied before first paint
                    void incomingContent.offsetHeight;

                    var openStart = null;
                    function animateOpen(timestamp) {
                        if (!_irisAnimating) {
                            incomingContent.style.clipPath = "";
                            hideDebugRing();
                            return;
                        }
                        if (!openStart) openStart = timestamp;
                        var elapsed = timestamp - openStart;
                        var progress = Math.min(elapsed / OPEN_DURATION, 1);
                        var eased = 1 - (1 - progress) * (1 - progress);
                        var radius = maxR * eased;

                        incomingContent.style.clipPath = "circle(" + radius + "px at " + cx + "px " + cy + "px)";
                        var ringOpacity = progress > 0.6 ? 0 : 1 - (progress / 0.6);
                        updateDebugRing(radius, ringOpacity);

                        if (progress < 1) {
                            requestAnimationFrame(animateOpen);
                        } else {
                            incomingContent.style.clipPath = "";
                            hideDebugRing();
                            _irisAnimating = false;

                            if (onComplete) onComplete();

                            if (_irisPendingState !== null) {
                                var pending = _irisPendingState;
                                _irisPendingState = null;
                                updateWorkerIdleState(pending);
                            }
                        }
                    }
                    requestAnimationFrame(animateOpen);
                }, PAUSE_DURATION);
            }
        }
        requestAnimationFrame(animateClose);
    }

    function updateWorkerIdleState(active) {
        if (MODE !== "worker") return;

        if (_irisAnimating) {
            _irisPendingState = active;
            return;
        }

        var idleVisible = workerIdleMessage && workerIdleMessage.style.display !== "none";
        var activeVisible = workerActiveScreen && workerActiveScreen.style.display !== "none";

        if (active && activeVisible) return;
        if (!active && idleVisible) return;

        // First call on page load — neither screen visible, no animation
        if (!idleVisible && !activeVisible) {
            if (active) {
                hideLoadingScreen();
                if (workerActiveScreen) {
                    workerActiveScreen.style.display = "flex";
                    initActiveScreenRipples();
                }
            } else {
                if (workerIdleMessage) {
                    workerIdleMessage.style.display = "flex";
                    startSloganTypewriter();
                }
            }
            if (workerStream) { workerStream.src = ""; workerStream.style.display = "none"; }
            return;
        }

        // Animated iris wipe transition
        if (active) {
            hideLoadingScreen();
            irisTransition(true,
                function onSwap() {
                    initActiveScreenRipples();
                },
                function onComplete() {
                    if (workerStream) { workerStream.src = ""; workerStream.style.display = "none"; }
                }
            );
        } else {
            irisTransition(false,
                function onSwap() {
                    destroyActiveScreenRipples();
                    destroyFrostGame();
                    clearActiveText();
                    _sloganTyped = false;
                    var sloganEl = document.getElementById("worker-idle-slogan");
                    if (sloganEl) {
                        sloganEl.textContent = "";
                        sloganEl.classList.remove("typing", "typed");
                    }
                    var idBox = document.querySelector(".worker-idle-id");
                    if (idBox) idBox.classList.remove("visible");
                    var statusText = document.getElementById("worker-idle-status-text");
                    if (statusText) { statusText.classList.remove("visible"); statusText.style.display = "none"; }
                    startSloganTypewriter();
                },
                function onComplete() {
                    if (workerStream) { workerStream.src = ""; workerStream.style.display = "none"; }
                }
            );
        }
    }

    function updateFrostGameState(active) {
        if (MODE !== "worker") return;
        if (active) {
            initFrostGame();
        } else {
            destroyFrostGame();
            if (_workScoreUploadTimer) {
                clearTimeout(_workScoreUploadTimer);
                _workScoreUploadTimer = null;
            }
            _lastUploadedScore = -1;
            clearActiveText();
            var activeCircle = document.getElementById("active-circle");
            if (activeCircle) activeCircle.style.background = "";
        }
    }

    // =========================================================================
    // Active commentary screen — ripples & typewriter
    // =========================================================================
    // Ripple is now on the persistent #worker-ripple-bg element (always visible).
    // These are kept as no-ops for any remaining call sites.
    function initActiveScreenRipples() {}
    function destroyActiveScreenRipples() {}

    var _activeWordTimer = null;

    function updateActiveText(text) {
        var el = document.getElementById("active-text");
        if (!el) return;
        if (_activeWordTimer) { clearTimeout(_activeWordTimer); _activeWordTimer = null; }

        el.textContent = "";
        el.classList.add("typing");

        var words = text.split(/\s+/).filter(function (w) { return w.length > 0; });
        var wi = 0;

        function typeWord() {
            if (wi >= words.length) {
                el.classList.remove("typing");
                return;
            }
            var word = words[wi];
            var ci = 0;
            el.textContent = "";

            function typeChar() {
                if (ci < word.length) {
                    el.textContent += word[ci];
                    ci++;
                    _activeWordTimer = setTimeout(typeChar, 60);
                } else {
                    wi++;
                    if (wi < words.length) {
                        _activeWordTimer = setTimeout(function () {
                            typeWord();
                        }, 500);
                    } else {
                        // Last word — keep visible, stop cursor blink
                        el.classList.remove("typing");
                    }
                }
            }
            typeChar();
        }
        typeWord();
    }

    function clearActiveText() {
        if (_activeWordTimer) { clearTimeout(_activeWordTimer); _activeWordTimer = null; }
        var el = document.getElementById("active-text");
        if (el) {
            el.textContent = "";
            el.classList.remove("typing", "score");
        }
    }

    // =========================================================================
    // Frost tile game (worker active screen)
    // =========================================================================
    var FROST_TARGET_TILE_PX = 80;  // ideal tile size in CSS pixels
    var FROST_TIMEOUT = 20000;
    var _frostHeatStrength = 0.7;
    var _frostHeatRadius = 150;

    var _frostCols = 0;
    var _frostRows = 0;
    var _frostTiles = null;    // Float64Array — last-hover timestamp per tile
    var _frostFrozen = null;   // Uint8Array — 0=warm, 1=frozen
    var _frostCanvas = null;
    var _frostCtx = null;
    var _frostScoreEl = null;
    var _frostAnimFrame = null;
    var _frostActive = false;
    var _frostMoveHandler = null;
    var _frostResizeHandler = null;
    var _frostMouseX = -9999;
    var _frostMouseY = -9999;
    var _frostLastFrame = 0;
    var _frostDebug = false;  // toggle: window._frostDebug = true in console
    var _workScoreUploadTimer = null;
    var _lastUploadedScore = -1;

    function frostComputeGrid(width, height) {
        var cols = Math.round(width / FROST_TARGET_TILE_PX);
        var rows = Math.round(height / FROST_TARGET_TILE_PX);
        // Round to nearest even, minimum 2
        cols = Math.max(2, Math.round(cols / 2) * 2);
        rows = Math.max(2, Math.round(rows / 2) * 2);
        return { cols: cols, rows: rows };
    }

    function frostGridGeometry() {
        if (!_frostCanvas || !_frostCols) return { tileW: 0, tileH: 0 };
        return {
            tileW: _frostCanvas.width / _frostCols,
            tileH: _frostCanvas.height / _frostRows
        };
    }

    function frostTileFromMouse(clientX, clientY) {
        if (!_frostCanvas || !_frostCols) return -1;
        var rect = _frostCanvas.getBoundingClientRect();
        var x = (clientX - rect.left) * (_frostCanvas.width / rect.width);
        var y = (clientY - rect.top) * (_frostCanvas.height / rect.height);
        if (x < 0 || y < 0 || x >= _frostCanvas.width || y >= _frostCanvas.height) return -1;
        var col = Math.floor(x / (_frostCanvas.width / _frostCols));
        var row = Math.floor(y / (_frostCanvas.height / _frostRows));
        if (col < 0 || col >= _frostCols || row < 0 || row >= _frostRows) return -1;
        return row * _frostCols + col;
    }

    function frostOnMouseMove(e) {
        if (!_frostActive) return;
        if (!_frostCanvas) return;
        var rect = _frostCanvas.getBoundingClientRect();
        _frostMouseX = e.clientX - rect.left;
        _frostMouseY = e.clientY - rect.top;
    }

    function frostOnMouseLeave() {
        _frostMouseX = -9999;
        _frostMouseY = -9999;
    }

    function frostRenderLoop() {
        if (!_frostActive) return;
        var now = Date.now();
        var total = _frostCols * _frostRows;
        var geo = frostGridGeometry();
        var tw = geo.tileW;
        var th = geo.tileH;

        _frostCtx.clearRect(0, 0, _frostCanvas.width, _frostCanvas.height);

        // Apply heat: push timestamps forward (kills dead zone) + cap age (holds frost level)
        var dt = _frostLastFrame > 0 ? now - _frostLastFrame : 0;
        _frostLastFrame = now;
        var dbg = window._frostDebug;
        var heatMap = dbg ? new Float32Array(total) : null;

        if (_frostMouseX > -9000) {
            var rect = _frostCanvas.getBoundingClientRect();
            var tileCssW = rect.width / _frostCols;
            var tileCssH = rect.height / _frostRows;
            var heatRadius = _frostHeatRadius;
            for (var i = 0; i < total; i++) {
                var col = i % _frostCols;
                var row = Math.floor(i / _frostCols);
                var cx = (col + 0.5) * tileCssW;
                var cy = (row + 0.5) * tileCssH;
                var dist = Math.sqrt((_frostMouseX - cx) * (_frostMouseX - cx) + (_frostMouseY - cy) * (_frostMouseY - cy));
                if (dist >= heatRadius) continue;
                var heat = (1 - dist / heatRadius) * _frostHeatStrength;
                if (heatMap) heatMap[i] = heat;
                // Push timestamp forward to slow aging (works from frame 1)
                _frostTiles[i] = Math.min(now, _frostTiles[i] + heat * dt);
                // Cap: tile can't age past maxAge while under heat
                var maxAge = FROST_TIMEOUT * (1 - heat);
                var minTs = now - maxAge;
                if (_frostTiles[i] < minTs) _frostTiles[i] = minTs;
                if (now - _frostTiles[i] < FROST_TIMEOUT) _frostFrozen[i] = 0;
            }
        }

        var frozenCount = 0;

        for (var i = 0; i < total; i++) {
            var age = now - _frostTiles[i];
            if (age <= 0) continue; // fully warm — draw nothing
            var col = i % _frostCols;
            var row = Math.floor(i / _frostCols);
            var x = col * tw;
            var y = row * th;

            if (age >= FROST_TIMEOUT) {
                _frostFrozen[i] = 1;
                frozenCount++;
            }

            // Smooth linear ramp: 0 → 0.8 over the full FROST_TIMEOUT
            var progress = Math.min(age / FROST_TIMEOUT, 1);
            var fillAlpha = progress * 0.6;
            var strokeAlpha = Math.min(fillAlpha + 0.2, 1);
            _frostCtx.fillStyle = "rgba(255, 255, 255, " + fillAlpha.toFixed(3) + ")";
            _frostCtx.fillRect(x, y, tw, th);
            _frostCtx.strokeStyle = "rgba(255, 255, 255, " + strokeAlpha.toFixed(3) + ")";
            _frostCtx.lineWidth = 0.5;
            _frostCtx.strokeRect(x + 0.25, y + 0.25, tw - 0.5, th - 0.5);

            // Diagonal cross on fully frozen cells
            if (_frostFrozen[i]) {
                _frostCtx.beginPath();
                _frostCtx.moveTo(x, y);
                _frostCtx.lineTo(x + tw, y + th);
                _frostCtx.moveTo(x + tw, y);
                _frostCtx.lineTo(x, y + th);
                _frostCtx.stroke();
            }

            // Debug overlay: per-tile age and heat
            if (dbg) {
                var ageS = _frostFrozen[i] ? "F" : (age / 1000).toFixed(1) + "s";
                var heatVal = heatMap ? heatMap[i] : 0;
                _frostCtx.font = "9px monospace";
                _frostCtx.fillStyle = "rgba(0, 0, 0, 0.7)";
                _frostCtx.fillText(ageS, x + 2, y + 10);
                if (heatVal > 0) {
                    _frostCtx.fillText("h:" + heatVal.toFixed(1), x + 2, y + 20);
                }
            }
        }

        frostUpdateScore(total - frozenCount);

        // Turn circle red when all tiles are frozen
        var activeCircle = document.getElementById("active-circle");
        if (activeCircle) {
            if (frozenCount >= total) {
                activeCircle.style.background = "#ac1a4e";
            } else {
                activeCircle.style.background = "";
            }
        }

        _frostAnimFrame = requestAnimationFrame(frostRenderLoop);
    }

    function frostBuildTileSnapshot() {
        var total = _frostCols * _frostRows;
        var arr = new Uint8Array(total);
        var now = Date.now();
        for (var i = 0; i < total; i++) {
            var age = now - _frostTiles[i];
            var progress = Math.max(0, Math.min(age / FROST_TIMEOUT, 1));
            arr[i] = Math.round(progress * 255);
        }
        var binary = "";
        for (var i = 0; i < arr.length; i++) binary += String.fromCharCode(arr[i]);
        return btoa(binary);
    }

    function frostUploadScore(unfrozen) {
        var total = _frostCols * _frostRows;
        fetch(API + "/work-score", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                unfrozen: unfrozen,
                total: total,
                cols: _frostCols,
                rows: _frostRows,
                tiles: frostBuildTileSnapshot()
            }),
        }).catch(function (err) { console.warn("Work score upload error:", err); });
    }

    function frostUpdateScore(unfrozen) {
        if (!_frostScoreEl) return;
        var total = _frostCols * _frostRows;
        var heatPct = Math.round(_frostHeatStrength * 100);
        var freezeSec = Math.round(FROST_TIMEOUT / 1000);
        _frostScoreEl.textContent = "heat:" + heatPct + "%  freeze:" + freezeSec + "s  radius:" + Math.round(_frostHeatRadius) + "px";

        // Show score in circle when work is active
        if (isWorkActive) {
            var circleText = document.getElementById("active-text");
            if (circleText) {
                if (_activeWordTimer) { clearTimeout(_activeWordTimer); _activeWordTimer = null; }
                circleText.classList.remove("typing");
                circleText.classList.add("score");
                circleText.textContent = Math.round((unfrozen / total) * 100) + "%";
            }
        }

        // Throttled upload to server (every 2s)
        if (unfrozen !== _lastUploadedScore && !_workScoreUploadTimer) {
            _workScoreUploadTimer = setTimeout(function () {
                _workScoreUploadTimer = null;
                _lastUploadedScore = unfrozen;
                frostUploadScore(unfrozen);
            }, 2000);
        }
    }


    function frostResizeAndRemap() {
        if (!_frostCanvas) return;
        var rect = _frostCanvas.getBoundingClientRect();
        _frostCanvas.width = rect.width;
        _frostCanvas.height = rect.height;

        var grid = frostComputeGrid(rect.width, rect.height);
        if (grid.cols === _frostCols && grid.rows === _frostRows) return;

        // Remap old tile state to new grid via nearest-neighbor spatial mapping
        var oldCols = _frostCols;
        var oldRows = _frostRows;
        var oldTiles = _frostTiles;
        var oldFrozen = _frostFrozen;
        var newCols = grid.cols;
        var newRows = grid.rows;
        var newTotal = newCols * newRows;
        var newTiles = new Float64Array(newTotal);
        var newFrozen = new Uint8Array(newTotal);
        var now = Date.now();

        for (var i = 0; i < newTotal; i++) {
            if (!oldTiles || !oldCols || !oldRows) {
                // No old state — initialize as warm
                newTiles[i] = now;
                newFrozen[i] = 0;
            } else {
                var nc = i % newCols;
                var nr = Math.floor(i / newCols);
                // Normalized center of the new tile
                var nx = (nc + 0.5) / newCols;
                var ny = (nr + 0.5) / newRows;
                // Find nearest old tile
                var oc = Math.min(Math.floor(nx * oldCols), oldCols - 1);
                var or_ = Math.min(Math.floor(ny * oldRows), oldRows - 1);
                var oldIdx = or_ * oldCols + oc;
                newTiles[i] = oldTiles[oldIdx];
                newFrozen[i] = oldFrozen[oldIdx];
            }
        }

        _frostCols = newCols;
        _frostRows = newRows;
        _frostTiles = newTiles;
        _frostFrozen = newFrozen;

        // Recount frozen tiles and update score/circle/server after grid change
        var frozenCount = 0;
        for (var i = 0; i < newTotal; i++) {
            if (newFrozen[i]) frozenCount++;
        }
        var unfrozen = newTotal - frozenCount;

        // Update circle text
        if (isWorkActive) {
            var circleText = document.getElementById("active-text");
            if (circleText) {
                if (_activeWordTimer) { clearTimeout(_activeWordTimer); _activeWordTimer = null; }
                circleText.classList.remove("typing");
                circleText.classList.add("score");
                circleText.textContent = Math.round((unfrozen / newTotal) * 100) + "%";
            }
        }

        // Force immediate upload to server
        _lastUploadedScore = -1;
        frostUploadScore(unfrozen);
    }

    function initFrostGame() {
        _frostCanvas = document.getElementById("frost-canvas");
        _frostScoreEl = document.getElementById("frost-score");
        if (!_frostCanvas) return;
        _frostCtx = _frostCanvas.getContext("2d");

        var rect = _frostCanvas.getBoundingClientRect();
        _frostCanvas.width = rect.width;
        _frostCanvas.height = rect.height;

        var grid = frostComputeGrid(rect.width, rect.height);
        _frostCols = grid.cols;
        _frostRows = grid.rows;
        var total = _frostCols * _frostRows;

        var now = Date.now();
        _frostTiles = new Float64Array(total);
        _frostFrozen = new Uint8Array(total);
        for (var i = 0; i < total; i++) {
            _frostTiles[i] = now;
            _frostFrozen[i] = 0;
        }

        _frostActive = true;
        if (_frostScoreEl) {
            _frostScoreEl.style.color = "#fff";
            _frostScoreEl.textContent = total + " / " + total;
        }

        _frostMoveHandler = frostOnMouseMove;
        var screen = document.getElementById("worker-active-screen");
        if (screen) {
            screen.addEventListener("mousemove", _frostMoveHandler);
            screen.addEventListener("mouseleave", frostOnMouseLeave);
        }

        _frostResizeHandler = frostResizeAndRemap;
        window.addEventListener("resize", _frostResizeHandler);

        _frostAnimFrame = requestAnimationFrame(frostRenderLoop);
    }

    function destroyFrostGame() {
        _frostActive = false;
        if (_frostAnimFrame) {
            cancelAnimationFrame(_frostAnimFrame);
            _frostAnimFrame = null;
        }
        if (_frostMoveHandler) {
            var screen = document.getElementById("worker-active-screen");
            if (screen) {
                screen.removeEventListener("mousemove", _frostMoveHandler);
                screen.removeEventListener("mouseleave", frostOnMouseLeave);
            }
            _frostMoveHandler = null;
        }
        if (_frostResizeHandler) {
            window.removeEventListener("resize", _frostResizeHandler);
            _frostResizeHandler = null;
        }
        if (_frostCanvas && _frostCtx) {
            _frostCtx.clearRect(0, 0, _frostCanvas.width, _frostCanvas.height);
        }
        _frostCanvas = null;
        _frostCtx = null;
        _frostScoreEl = null;
        _frostCols = 0;
        _frostRows = 0;
        _frostTiles = null;
        _frostFrozen = null;
        _frostMouseX = -9999;
        _frostMouseY = -9999;
        _frostLastFrame = 0;
    }

    // Audio playback — "latest wins" strategy (no FIFO queue)
    var pendingAudio = null;       // only the latest waiting item
    var isPlayingAudio = false;

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
    function updateStartButtonState() {
        if (!startStopBtn || isActive) return;
        startStopBtn.disabled = !_workerRegistered;
    }

    function updateStartStopButton(active) {
        isActive = active;
        if (!startStopBtn) return;
        if (active) {
            startStopBtn.textContent = "STOP PANOPTICUM";
            startStopBtn.classList.remove("inactive");
            startStopBtn.classList.add("active");
            startStopBtn.disabled = false;
        } else {
            startStopBtn.textContent = "START PANOPTICUM";
            startStopBtn.classList.remove("active");
            startStopBtn.classList.add("inactive");
            startStopBtn.disabled = !_workerRegistered;
        }
    }

    function updateWorkButton(active) {
        isWorkActive = active;
        if (!workBtn) return;
        if (active) {
            workBtn.textContent = "STOP WORK";
            workBtn.classList.remove("inactive");
            workBtn.classList.add("active");
            workBtn.disabled = false;
        } else {
            workBtn.textContent = "START WORK";
            workBtn.classList.remove("active");
            workBtn.classList.add("inactive");
            workBtn.disabled = !isActive;
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
        });
    }

    if (workBtn) {
        workBtn.addEventListener("click", function () {
            var newWork = !isWorkActive;
            fetch(API + "/work", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ active: newWork }),
            });
        });
    }

    // =========================================================================
    // Pill highlighting
    // =========================================================================
    function highlightTonePill(toneValue) {
        var tv = String(toneValue);
        tonePills.forEach(function (btn) {
            btn.classList.toggle("active", btn.dataset.tone === tv);
        });
    }

    // =========================================================================
    // Tone selection
    // =========================================================================
    function setTone(toneValue) {
        currentTone = String(toneValue);
        fetch(API + "/tone", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ value: parseFloat(toneValue) }),
        });
        highlightTonePill(toneValue);
    }

    tonePills.forEach(function (btn) {
        btn.addEventListener("click", function () {
            setTone(btn.dataset.tone);
        });
    });

    // =========================================================================
    // Frequency slider (logarithmic: 3s – 600s)
    // =========================================================================
    function sliderToFrequency(v) {
        return Math.round(3 * Math.pow(200, v / 100));
    }

    function frequencyToSlider(f) {
        return Math.round(100 * Math.log(f / 3) / Math.log(200));
    }

    function formatFrequency(secs) {
        if (secs < 60) return secs + "s";
        var m = Math.floor(secs / 60);
        var s = secs % 60;
        return s > 0 ? m + "m " + s + "s" : m + "m";
    }

    function updateFrequencyLabel(secs) {
        currentFrequency = secs;
        if (frequencyValue) frequencyValue.textContent = formatFrequency(secs);
    }

    if (frequencySlider) {
        frequencySlider.addEventListener("input", function () {
            var secs = sliderToFrequency(parseInt(frequencySlider.value, 10));
            updateFrequencyLabel(secs);
        });
        frequencySlider.addEventListener("change", function () {
            var secs = sliderToFrequency(parseInt(frequencySlider.value, 10));
            fetch(API + "/frequency", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ value: secs }),
            }).catch(function (err) { console.warn("Frequency error:", err); });
        });
    }

    // =========================================================================
    // Comment length slider (linear: 3 – 50 words)
    // =========================================================================
    function updateCommentLengthLabel(words) {
        currentCommentLength = words;
        if (commentLengthValue) commentLengthValue.textContent = words + " words";
    }

    if (commentLengthSlider) {
        commentLengthSlider.addEventListener("input", function () {
            updateCommentLengthLabel(parseInt(commentLengthSlider.value, 10));
        });
        commentLengthSlider.addEventListener("change", function () {
            var words = parseInt(commentLengthSlider.value, 10);
            fetch(API + "/comment-length", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ value: words }),
            }).catch(function (err) { console.warn("Comment length error:", err); });
        });
    }

    // =========================================================================
    // Bar slider interaction
    // =========================================================================
    function updateBarFill(slider, fillEl) {
        if (!slider || !fillEl) return;
        var min = parseFloat(slider.min);
        var max = parseFloat(slider.max);
        var val = parseFloat(slider.value);
        var pct = ((val - min) / (max - min)) * 100;
        fillEl.style.width = pct + "%";
    }

    function initBarSlider(barEl, slider) {
        if (!barEl || !slider) return;
        var fillEl = barEl.querySelector(".ctrl-bar-fill");

        function setFromX(clientX) {
            var rect = barEl.getBoundingClientRect();
            var pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
            var min = parseFloat(slider.min);
            var max = parseFloat(slider.max);
            var step = parseFloat(slider.step) || 1;
            var val = Math.round((min + pct * (max - min)) / step) * step;
            val = Math.max(min, Math.min(max, val));
            slider.value = val;
            slider.dispatchEvent(new Event("input"));
            updateBarFill(slider, fillEl);
        }

        barEl.addEventListener("mousedown", function (e) {
            setFromX(e.clientX);
            function onMove(ev) { setFromX(ev.clientX); }
            function onUp() {
                document.removeEventListener("mousemove", onMove);
                document.removeEventListener("mouseup", onUp);
                slider.dispatchEvent(new Event("change"));
            }
            document.addEventListener("mousemove", onMove);
            document.addEventListener("mouseup", onUp);
        });

        // Sync fill on input events (from SSE updates)
        slider.addEventListener("input", function () {
            updateBarFill(slider, fillEl);
        });

        // Initial fill
        updateBarFill(slider, fillEl);
    }

    initBarSlider(document.getElementById("frequency-bar"), frequencySlider);
    initBarSlider(document.getElementById("comment-length-bar"), commentLengthSlider);

    // Heat strength slider
    function updateHeatStrengthLabel(pct) {
        if (heatStrengthValue) heatStrengthValue.textContent = pct + "%";
    }
    if (heatStrengthSlider) {
        heatStrengthSlider.addEventListener("input", function () {
            updateHeatStrengthLabel(parseInt(heatStrengthSlider.value, 10));
        });
        heatStrengthSlider.addEventListener("change", function () {
            var pct = parseInt(heatStrengthSlider.value, 10);
            fetch(API + "/heat-strength", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ value: pct / 100 }),
            }).catch(function (err) { console.warn("Heat strength error:", err); });
        });
    }
    initBarSlider(document.getElementById("heat-strength-bar"), heatStrengthSlider);

    // Freeze time slider
    function updateFreezeTimeLabel(secs) {
        if (freezeTimeValue) freezeTimeValue.textContent = secs + "s";
    }
    if (freezeTimeSlider) {
        freezeTimeSlider.addEventListener("input", function () {
            updateFreezeTimeLabel(parseInt(freezeTimeSlider.value, 10));
        });
        freezeTimeSlider.addEventListener("change", function () {
            var secs = parseInt(freezeTimeSlider.value, 10);
            fetch(API + "/freeze-time", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ value: secs }),
            }).catch(function (err) { console.warn("Freeze time error:", err); });
        });
    }
    initBarSlider(document.getElementById("freeze-time-bar"), freezeTimeSlider);

    // Heat radius slider
    function updateHeatRadiusLabel(px) {
        if (heatRadiusValue) heatRadiusValue.textContent = px + "px";
    }
    if (heatRadiusSlider) {
        heatRadiusSlider.addEventListener("input", function () {
            updateHeatRadiusLabel(parseInt(heatRadiusSlider.value, 10));
        });
        heatRadiusSlider.addEventListener("change", function () {
            var px = parseInt(heatRadiusSlider.value, 10);
            fetch(API + "/heat-radius", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ value: px }),
            }).catch(function (err) { console.warn("Heat radius error:", err); });
        });
    }
    initBarSlider(document.getElementById("heat-radius-bar"), heatRadiusSlider);

    // =========================================================================
    // Message log
    // =========================================================================
    function toneLabel(tone) {
        var v = parseFloat(tone);
        if (v <= 0.25) return '<span class="tone-tag tone-supportive">Supportive</span>';
        if (v <= 0.75) return '<span class="tone-tag tone-neutral">Neutral</span>';
        return '<span class="tone-tag tone-judgmental">Judgmental</span>';
    }

    function actionTag(descType) {
        if (descType === "action_request") return ' <span class="tone-tag action-tag action-request">Action</span>';
        if (descType === "action_completed") return ' <span class="tone-tag action-tag action-completed">Completed</span>';
        if (descType === "action_timeout") return ' <span class="tone-tag action-tag action-timeout">Timeout</span>';
        return "";
    }

    var _logTypeTimer = null;

    function renderMessageLog(animate) {
        if (!messageLogList) return;
        if (_logTypeTimer) { clearTimeout(_logTypeTimer); _logTypeTimer = null; }
        if (messageLog.length === 0) {
            messageLogList.innerHTML = '<div class="message-log-empty">Waiting for observations...</div>';
            return;
        }
        var html = "";
        for (var i = 0; i < messageLog.length; i++) {
            var msg = messageLog[i];
            var cls = "message-log-item";
            if (msg.descType && msg.descType !== "commentary") cls += " action-entry";
            if (i === 0) {
                cls += " latest";
            } else if (!msg.played && msg.serverTimestamp) {
                cls += " skipped";
            }
            html += '<div class="' + cls + '">';
            html += '<span class="message-log-time">' + (msg.time || "") + ' ' + toneLabel(msg.tone) + actionTag(msg.descType) + '</span>';
            html += '<span class="message-log-text">' + (i === 0 && animate ? '' : escapeHtml(msg.text)) + '</span>';
            html += '</div>';
        }
        messageLogList.innerHTML = html;
        if (animate && messageLog.length > 0) {
            typeLogEntry(messageLog[0].text);
        }
    }

    function typeLogEntry(text) {
        var el = messageLogList.querySelector(".message-log-item.latest .message-log-text");
        if (!el) return;
        var chars = text.split("");
        var ci = 0;
        el.classList.add("typing");
        function typeNext() {
            if (ci < chars.length) {
                el.textContent += chars[ci];
                ci++;
                _logTypeTimer = setTimeout(typeNext, 40);
            } else {
                el.classList.remove("typing");
            }
        }
        typeNext();
    }

    function escapeHtml(text) {
        var div = document.createElement("div");
        div.textContent = text;
        return div.innerHTML;
    }

    function addToMessageLog(text, tone, serverTimestamp, descType) {
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
            descType: descType || "commentary",
        });
        if (messageLog.length > MAX_LOG_MESSAGES) messageLog.pop();
        renderMessageLog(true);
    }

    // =========================================================================
    // Action mode
    // =========================================================================
    function setActionSetting(setting) {
        currentActionSetting = setting;
        fetch(API + "/action-setting", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ setting: setting }),
        }).catch(function (err) {
            console.warn("Action setting error:", err);
        });
        highlightActionSettingPill(setting);
    }

    function highlightActionSettingPill(setting) {
        actionSettingPills.forEach(function (btn) {
            btn.classList.toggle("active", btn.getAttribute("data-action-setting") === setting);
        });
    }

    function updateActionPhaseUI(phase, action) {
        currentActionPhase = phase;
        if (actionPhaseLabel) {
            var labels = { "commenting": "Commenting", "action_requesting": "Requesting", "action_verifying": "Verifying" };
            actionPhaseLabel.textContent = labels[phase] || phase;
            actionPhaseLabel.className = "action-phase-label";
            if (phase === "action_requesting") actionPhaseLabel.classList.add("phase-requesting");
            if (phase === "action_verifying") actionPhaseLabel.classList.add("phase-verifying");
        }
        if (actionRequestedText) {
            actionRequestedText.textContent = action || "";
        }
        if (actionTriggerBtn) {
            actionTriggerBtn.disabled = !isActive || phase !== "commenting";
        }
    }

    function updateWorkScoreDisplay(data) {
        if (!workScoreContainer) return;
        if (!data || !data.total || !data.cols || !data.tiles) {
            workScoreContainer.style.display = "none";
            return;
        }
        // Decode base64 tiles to Uint8Array
        var binary = atob(data.tiles);
        var arr = new Uint8Array(binary.length);
        for (var i = 0; i < binary.length; i++) arr[i] = binary.charCodeAt(i);

        // Render grid cells matching worker frost style (white fill + white outlines)
        // Fixed 450x450 canvas — cells stretch to fill
        if (workScoreCanvas) {
            var GRID_W = 450;
            var GRID_H = 450;
            var cellW = GRID_W / data.cols;
            var cellH = GRID_H / data.rows;
            workScoreCanvas.width = GRID_W;
            workScoreCanvas.height = GRID_H;
            workScoreCanvas.style.width = GRID_W + "px";
            workScoreCanvas.style.height = GRID_H + "px";

            var ctx = workScoreCanvas.getContext("2d");
            ctx.clearRect(0, 0, GRID_W, GRID_H);

            for (var i = 0; i < arr.length; i++) {
                var col = i % data.cols;
                var row = Math.floor(i / data.cols);
                var x = col * cellW;
                var y = row * cellH;
                var progress = arr[i] / 255;
                if (progress <= 0) continue;

                var fillAlpha = progress * 0.6;
                var strokeAlpha = Math.min(fillAlpha + 0.2, 1);
                ctx.fillStyle = "rgba(255, 255, 255, " + fillAlpha.toFixed(3) + ")";
                ctx.fillRect(x, y, cellW, cellH);
                ctx.strokeStyle = "rgba(255, 255, 255, " + strokeAlpha.toFixed(3) + ")";
                ctx.lineWidth = 0.5;
                ctx.strokeRect(x + 0.25, y + 0.25, cellW - 0.5, cellH - 0.5);

                // Diagonal cross on fully frozen cells
                if (arr[i] >= 255) {
                    ctx.beginPath();
                    ctx.moveTo(x, y);
                    ctx.lineTo(x + cellW, y + cellH);
                    ctx.moveTo(x + cellW, y);
                    ctx.lineTo(x, y + cellH);
                    ctx.stroke();
                }
            }
        }

        // Update score label
        if (workScoreLabel) {
            var pct = Math.round((data.unfrozen / data.total) * 100);
            workScoreLabel.textContent = pct + "%";
        }
        workScoreContainer.style.display = "";
    }

    actionSettingPills.forEach(function (btn) {
        btn.addEventListener("click", function () {
            setActionSetting(btn.getAttribute("data-action-setting"));
        });
    });

    if (actionTriggerBtn) {
        actionTriggerBtn.addEventListener("click", function () {
            if (!isActive || currentActionPhase !== "commenting") return;
            fetch(API + "/trigger-action", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({}),
            }).catch(function (err) {
                console.warn("Trigger action error:", err);
            });
        });
    }

    // =========================================================================
    // SSE listeners
    // =========================================================================
    var evtSource = new EventSource("/room/" + ROOM + "/events");

    evtSource.addEventListener("active", function (e) {
        var data = JSON.parse(e.data);
        var wasActive = isActive;
        updateStartStopButton(data.active);

        // Update work button: disabled when pipeline off, enabled when on (unless work already active)
        if (workBtn) {
            if (!data.active) {
                workBtn.disabled = true;
            } else if (!isWorkActive) {
                workBtn.disabled = false;
            }
        }
        // Update action trigger disabled state
        if (actionTriggerBtn) {
            actionTriggerBtn.disabled = !data.active || currentActionPhase !== "commenting";
        }

        if (MODE === "controller") {
            var circle = document.getElementById("ctrl-circle");
            if (data.active) {
                // Phase 1: hide slogan, shrink with passive styling
                if (circle) circle.classList.add("shrinking");
                // Phase 2: after shrink completes, apply active styling + start video
                _ctrlActivateTimer = setTimeout(function () {
                    _ctrlActivateTimer = null;
                    if (!isActive) return; // guard: user may have stopped during shrink
                    if (circle) {
                        circle.classList.remove("shrinking");
                        circle.classList.add("active");
                    }
                    startSnapshotPolling();
                    startCtrlRipples();
                }, 600); // matches CSS transition duration
            } else {
                // Cancel phased activation if stop happens mid-shrink
                if (_ctrlActivateTimer) {
                    clearTimeout(_ctrlActivateTimer);
                    _ctrlActivateTimer = null;
                }
                stopSnapshotPolling();
                stopCtrlRipples();
                if (circle) {
                    circle.classList.remove("shrinking");
                    circle.classList.remove("active");
                }
                if (_streamCanvas && _streamCtx) {
                    _streamCtx.clearRect(0, 0, _streamCanvas.width, _streamCanvas.height);
                    _streamCanvas.style.display = "none";
                }
                // Retype slogan after circle finishes resizing (only on actual deactivation)
                if (wasActive) {
                    var statusEl = document.getElementById("ctrl-circle-status");
                    if (statusEl) statusEl.textContent = "";
                    setTimeout(typeCtrlSlogan, 650);
                }
            }
        }

        // Worker starts/stops camera + frame upload on active change
        if (MODE === "worker" && isActiveSource) {
            if (data.active) {
                startCamera();
                startFrameUpload();
            } else {
                stopFrameUpload();
                stopCamera();
            }
        }

        // Worker active screen tied to pipeline state
        updateWorkerIdleState(data.active);
    });

    evtSource.addEventListener("description", function (e) {
        var data = JSON.parse(e.data);
        if (data.text) {
            addToMessageLog(data.text, data.tone, data.timestamp ? String(data.timestamp) : null, data.type || "commentary");
            // Feed text to active commentary screen typewriter (not during work mode — circle shows score)
            if (MODE === "worker" && !isWorkActive && workerActiveScreen && workerActiveScreen.style.display !== "none") {
                updateActiveText(data.text);
            }
        }
    });

    evtSource.addEventListener("tone", function (e) {
        var data = JSON.parse(e.data);
        var v = parseFloat(data.value);
        var nearest = v <= 0.25 ? "0" : v <= 0.75 ? "0.5" : "1";
        highlightTonePill(nearest);
        currentTone = nearest;
        // Drop any pending old-tone audio (let current playback finish naturally)
        if (MODE === "worker") {
            pendingAudio = null;
        }
    });

    evtSource.addEventListener("clients", function (e) {
        var data = JSON.parse(e.data);
        renderClientList(data.clients || []);
    });

    evtSource.addEventListener("action_phase", function (e) {
        var data = JSON.parse(e.data);
        highlightActionSettingPill(data.setting);
        currentActionSetting = data.setting;
        updateActionPhaseUI(data.phase, data.action);
    });

    evtSource.addEventListener("frequency", function (e) {
        var data = JSON.parse(e.data);
        var secs = Math.round(data.value);
        updateFrequencyLabel(secs);
        if (frequencySlider) {
            frequencySlider.value = frequencyToSlider(secs);
            frequencySlider.dispatchEvent(new Event("input"));
        }
    });

    evtSource.addEventListener("comment_length", function (e) {
        var data = JSON.parse(e.data);
        var words = data.value;
        updateCommentLengthLabel(words);
        if (commentLengthSlider) {
            commentLengthSlider.value = words;
            commentLengthSlider.dispatchEvent(new Event("input"));
        }
    });

    console.log("[SSE] heat_strength listener registered");
    evtSource.addEventListener("heat_strength", function (e) {
        var data = JSON.parse(e.data);
        console.log("[SSE] heat_strength received:", data.value, "old:", _frostHeatStrength);
        _frostHeatStrength = data.value;
        if (heatStrengthSlider) {
            heatStrengthSlider.value = Math.round(data.value * 100);
            heatStrengthSlider.dispatchEvent(new Event("input"));
        }
    });

    evtSource.addEventListener("freeze_time", function (e) {
        var data = JSON.parse(e.data);
        FROST_TIMEOUT = data.value * 1000;
        if (freezeTimeSlider) {
            freezeTimeSlider.value = Math.round(data.value);
            freezeTimeSlider.dispatchEvent(new Event("input"));
        }
    });

    evtSource.addEventListener("heat_radius", function (e) {
        var data = JSON.parse(e.data);
        _frostHeatRadius = data.value;
        if (heatRadiusSlider) {
            heatRadiusSlider.value = Math.round(data.value);
            heatRadiusSlider.dispatchEvent(new Event("input"));
        }
    });

    evtSource.addEventListener("work", function (e) {
        var data = JSON.parse(e.data);
        updateWorkButton(data.active);
        updateFrostGameState(data.active);
        if (!data.active) {
            updateWorkScoreDisplay(null);
        }
    });

    evtSource.addEventListener("work_score", function (e) {
        var data = JSON.parse(e.data);
        updateWorkScoreDisplay(data);
    });

    // Audio events (both modes mark log entries; only worker plays audio)
    evtSource.addEventListener("audio", function (e) {
        var data = JSON.parse(e.data);
        var ts = data.timestamp ? String(data.timestamp) : null;
        if (ts) markLogEntryPlayed(ts);
        if (MODE === "worker" && data.url) playAudio(data.url);
    });

    evtSource.addEventListener("audio_robotic", function (e) {
        if (MODE !== "worker") return;
        var data = JSON.parse(e.data);
        if (data.url) playRoboticAudio(data.url);
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
            updateWorkButton(data.work_active);
            updateWorkerIdleState(data.active);
            updateFrostGameState(data.work_active);
            if (data.work_active && data.work_score_total > 0) {
                updateWorkScoreDisplay({
                    unfrozen: data.work_score_unfrozen,
                    total: data.work_score_total,
                    cols: data.work_score_cols,
                    rows: data.work_score_rows,
                    tiles: data.work_score_tiles,
                });
            }

            var v = parseFloat(data.tone);
            var nearest = v <= 0.25 ? "0" : v <= 0.75 ? "0.5" : "1";
            highlightTonePill(nearest);
            currentTone = nearest;

            if (data.description) addToMessageLog(data.description, data.tone);

            // Frequency & comment length initial state
            if (data.frequency) {
                var freqSecs = Math.round(data.frequency);
                updateFrequencyLabel(freqSecs);
                if (frequencySlider) {
                    frequencySlider.value = frequencyToSlider(freqSecs);
                    frequencySlider.dispatchEvent(new Event("input"));
                }
            }
            if (data.comment_length) {
                updateCommentLengthLabel(data.comment_length);
                if (commentLengthSlider) {
                    commentLengthSlider.value = data.comment_length;
                    commentLengthSlider.dispatchEvent(new Event("input"));
                }
            }

            // Frost game settings initial state
            if (data.heat_strength !== undefined) {
                _frostHeatStrength = data.heat_strength;
                if (heatStrengthSlider) {
                    heatStrengthSlider.value = Math.round(data.heat_strength * 100);
                    heatStrengthSlider.dispatchEvent(new Event("input"));
                }
            }
            if (data.freeze_time !== undefined) {
                FROST_TIMEOUT = data.freeze_time * 1000;
                if (freezeTimeSlider) {
                    freezeTimeSlider.value = Math.round(data.freeze_time);
                    freezeTimeSlider.dispatchEvent(new Event("input"));
                }
            }
            if (data.heat_radius !== undefined) {
                _frostHeatRadius = data.heat_radius;
                if (heatRadiusSlider) {
                    heatRadiusSlider.value = Math.round(data.heat_radius);
                    heatRadiusSlider.dispatchEvent(new Event("input"));
                }
            }

            // Action mode initial state
            if (data.action_setting) {
                currentActionSetting = data.action_setting;
                highlightActionSettingPill(data.action_setting);
            }
            if (data.action_phase) {
                updateActionPhaseUI(data.action_phase, data.action_requested || "");
            }

            // If already active: controller shows MJPEG, worker starts camera
            if (data.active) {
                if (MODE === "controller") {
                    startSnapshotPolling();
                    startCtrlRipples();
                    var circle = document.getElementById("ctrl-circle");
                    if (circle) circle.classList.add("active");
                } else if (MODE === "worker" && isActiveSource) {
                    startCamera();
                    startFrameUpload();
                }
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

    if (MODE === "worker") {
        setupWorker();
    }

    // Controller circle phased activation timer
    var _ctrlActivateTimer = null;

    // Controller circle typewriter
    var _ctrlSloganVersion = 0;
    function typeCtrlSlogan() {
        var el = document.getElementById("ctrl-circle-status");
        if (!el) return;
        el.textContent = "";
        var version = ++_ctrlSloganVersion;
        var text = "Oversight is care.";
        var i = 0;
        function typeNext() {
            if (version !== _ctrlSloganVersion) return;
            if (i < text.length) {
                el.textContent += text[i];
                i++;
                setTimeout(typeNext, 60);
            }
        }
        setTimeout(typeNext, 500);
    }
    if (MODE === "controller") {
        typeCtrlSlogan();
    }
})();
