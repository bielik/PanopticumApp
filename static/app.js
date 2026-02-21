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

    // --- State ---
    var isActive = false;
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
        // Update worker label for info line
        _workerLabel = null;
        if (clients) {
            for (var w = 0; w < clients.length; w++) {
                if (clients[w].role === "worker") {
                    var lbl = clients[w].label || "";
                    // Default labels like "Worker (Win32)" mean no Employee ID registered
                    if (lbl && !/^Worker\s*\(/.test(lbl)) {
                        _workerLabel = lbl;
                    } else {
                        _workerLabel = "NOT REGISTERED";
                    }
                    break;
                }
            }
        }
        updateWorkerInfo();

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

            html += '<div class="' + cls + '">';
            html += '<span class="client-item-label">' + escapeHtml(c.label || c.id.slice(0, 8)) + '</span>';
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

    function updateWorkerInfo() {
        if (!workerInfoEl) return;
        var parts = [];
        if (ROOM) parts.push("ROOM: " + ROOM);
        if (MODE === "controller") {
            parts.push("WORKER: " + (_workerLabel || "NOT CONNECTED"));
        } else {
            parts.push("ID: " + (STORED_WORKER_ID || "NOT REGISTERED"));
        }
        workerInfoEl.textContent = parts.join("  /  ");
    }
    updateWorkerInfo();

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
                if (idBox) idBox.classList.add("visible");
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
                setTimeout(function () { workerIdBtn.textContent = "REGISTER"; }, 2000);
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
    // Worker idle state
    // =========================================================================
    function updateWorkerIdleState(active) {
        if (MODE !== "worker") return;
        if (active) {
            // Session active — show active commentary screen immediately
            hideLoadingScreen();
            if (workerIdleMessage) workerIdleMessage.style.display = "none";
            if (workerActiveScreen) {
                workerActiveScreen.style.display = "flex";
                initActiveScreenRipples();
                initFrostGame();
            }
            if (workerStream) { workerStream.src = ""; workerStream.style.display = "none"; }
        } else {
            // Session stopped — show idle message, hide active screen
            if (workerActiveScreen) workerActiveScreen.style.display = "none";
            destroyActiveScreenRipples();
            destroyFrostGame();
            clearActiveText();
            if (workerIdleMessage) {
                workerIdleMessage.style.display = "flex";
                startSloganTypewriter();
            }
            if (workerStream) {
                workerStream.src = "";
                workerStream.style.display = "none";
            }
        }
    }

    // =========================================================================
    // Active commentary screen — ripples & typewriter
    // =========================================================================
    var _activeRipples = null;

    function initActiveScreenRipples() {
        if (_activeRipples) return;
        setTimeout(function () {
            try {
                if (!window.jQuery) return;
                var el = document.getElementById("worker-active-screen");
                if (!el || !el.clientWidth) return;
                var c = document.createElement("canvas");
                c.width = 1; c.height = 1;
                var ctx = c.getContext("2d");
                ctx.fillStyle = "#7a9a86";
                ctx.fillRect(0, 0, 1, 1);
                $("#worker-active-screen").ripples({
                    resolution: 512,
                    dropRadius: 20,
                    perturbance: 0.04,
                    interactive: true,
                    imageUrl: c.toDataURL()
                });
                _activeRipples = setInterval(function () {
                    if (!el || el.style.display === "none") return;
                    $("#worker-active-screen").ripples("drop", el.clientWidth / 2, el.clientHeight / 2, 30, 0.3);
                }, 2000);
            } catch (e) {
                console.log("Active screen ripples not supported:", e);
            }
        }, 100);
    }

    function destroyActiveScreenRipples() {
        if (_activeRipples) {
            clearInterval(_activeRipples);
            _activeRipples = null;
        }
        try { if (window.jQuery) $("#worker-active-screen").ripples("destroy"); } catch (e) {}
    }

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
            el.classList.remove("typing");
        }
    }

    // =========================================================================
    // Frost tile game (worker active screen)
    // =========================================================================
    var FROST_COLS = 10;
    var FROST_ROWS = 8;
    var FROST_TOTAL = FROST_COLS * FROST_ROWS;
    var FROST_TIMEOUT = 20000;
    var _frostHeatStrength = 0.7;

    var _frostTiles = null;    // Float64Array — last-hover timestamp per tile
    var _frostFrozen = null;   // Uint8Array — 0=warm, 1=frozen
    var _frostCanvas = null;
    var _frostCtx = null;
    var _frostScoreEl = null;
    var _frostAnimFrame = null;
    var _frostActive = false;
    var _frostGameOver = false;
    var _frostMoveHandler = null;
    var _frostResizeHandler = null;
    var _frostMouseX = -9999;
    var _frostMouseY = -9999;
    var _frostLastFrame = 0;
    var _frostDebug = false;  // toggle: window._frostDebug = true in console

    function frostGridGeometry() {
        if (!_frostCanvas) return { tileW: 0, tileH: 0 };
        return {
            tileW: _frostCanvas.width / FROST_COLS,
            tileH: _frostCanvas.height / FROST_ROWS
        };
    }

    function frostTileFromMouse(clientX, clientY) {
        if (!_frostCanvas) return -1;
        var rect = _frostCanvas.getBoundingClientRect();
        var x = (clientX - rect.left) * (_frostCanvas.width / rect.width);
        var y = (clientY - rect.top) * (_frostCanvas.height / rect.height);
        if (x < 0 || y < 0 || x >= _frostCanvas.width || y >= _frostCanvas.height) return -1;
        var col = Math.floor(x / (_frostCanvas.width / FROST_COLS));
        var row = Math.floor(y / (_frostCanvas.height / FROST_ROWS));
        if (col < 0 || col >= FROST_COLS || row < 0 || row >= FROST_ROWS) return -1;
        return row * FROST_COLS + col;
    }

    function frostOnMouseMove(e) {
        if (!_frostActive || _frostGameOver) return;
        if (!_frostCanvas) return;
        var rect = _frostCanvas.getBoundingClientRect();
        _frostMouseX = e.clientX - rect.left;
        _frostMouseY = e.clientY - rect.top;
    }

    function frostRenderLoop() {
        if (!_frostActive) return;
        var now = Date.now();
        var geo = frostGridGeometry();
        var tw = geo.tileW;
        var th = geo.tileH;

        _frostCtx.clearRect(0, 0, _frostCanvas.width, _frostCanvas.height);

        // Apply heat: push timestamps forward (kills dead zone) + cap age (holds frost level)
        var dt = _frostLastFrame > 0 ? now - _frostLastFrame : 0;
        _frostLastFrame = now;
        var dbg = window._frostDebug;
        var heatMap = dbg ? new Float32Array(FROST_TOTAL) : null;

        if (_frostMouseX > -9000) {
            var rect = _frostCanvas.getBoundingClientRect();
            var tileCssW = rect.width / FROST_COLS;
            var tileCssH = rect.height / FROST_ROWS;
            var HEAT_RADIUS = 150;
            for (var i = 0; i < FROST_TOTAL; i++) {
                var col = i % FROST_COLS;
                var row = Math.floor(i / FROST_COLS);
                var cx = (col + 0.5) * tileCssW;
                var cy = (row + 0.5) * tileCssH;
                var dist = Math.sqrt((_frostMouseX - cx) * (_frostMouseX - cx) + (_frostMouseY - cy) * (_frostMouseY - cy));
                if (dist >= HEAT_RADIUS) continue;
                var heat = (1 - dist / HEAT_RADIUS) * _frostHeatStrength;
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

        for (var i = 0; i < FROST_TOTAL; i++) {
            var age = now - _frostTiles[i];
            if (age <= 0) continue; // fully warm — draw nothing
            var col = i % FROST_COLS;
            var row = Math.floor(i / FROST_COLS);
            var x = col * tw;
            var y = row * th;

            if (age >= FROST_TIMEOUT) {
                _frostFrozen[i] = 1;
                frozenCount++;
            }

            // Smooth linear ramp: 0 → 0.8 over the full FROST_TIMEOUT
            var progress = Math.min(age / FROST_TIMEOUT, 1);
            var fillAlpha = progress * 0.8;
            var strokeAlpha = Math.min(fillAlpha + 0.2, 1);
            _frostCtx.fillStyle = "rgba(255, 255, 255, " + fillAlpha.toFixed(3) + ")";
            _frostCtx.fillRect(x, y, tw, th);
            _frostCtx.strokeStyle = "rgba(255, 255, 255, " + strokeAlpha.toFixed(3) + ")";
            _frostCtx.lineWidth = 0.5;
            _frostCtx.strokeRect(x + 0.25, y + 0.25, tw - 0.5, th - 0.5);

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

        frostUpdateScore(FROST_TOTAL - frozenCount);

        if (!_frostGameOver && frozenCount >= FROST_TOTAL) {
            frostOnGameOver();
        }

        _frostAnimFrame = requestAnimationFrame(frostRenderLoop);
    }

    function frostUpdateScore(unfrozen) {
        if (!_frostScoreEl) return;
        if (_frostGameOver) return;
        var heatPct = Math.round(_frostHeatStrength * 100);
        _frostScoreEl.textContent = unfrozen + " / " + FROST_TOTAL + "  heat:" + heatPct + "%";
    }

    function frostOnGameOver() {
        _frostGameOver = true;
        if (_frostScoreEl) {
            _frostScoreEl.textContent = "0 / " + FROST_TOTAL + " \u2014 TERMINATED";
            _frostScoreEl.style.color = "#ef4444";
        }
    }

    function frostResizeCanvas() {
        if (!_frostCanvas) return;
        var rect = _frostCanvas.getBoundingClientRect();
        _frostCanvas.width = rect.width;
        _frostCanvas.height = rect.height;
    }

    function initFrostGame() {
        _frostCanvas = document.getElementById("frost-canvas");
        _frostScoreEl = document.getElementById("frost-score");
        if (!_frostCanvas) return;
        _frostCtx = _frostCanvas.getContext("2d");

        frostResizeCanvas();

        var now = Date.now();
        _frostTiles = new Float64Array(FROST_TOTAL);
        _frostFrozen = new Uint8Array(FROST_TOTAL);
        for (var i = 0; i < FROST_TOTAL; i++) {
            _frostTiles[i] = now;
            _frostFrozen[i] = 0;
        }

        _frostGameOver = false;
        _frostActive = true;
        if (_frostScoreEl) {
            _frostScoreEl.style.color = "#fff";
            _frostScoreEl.textContent = FROST_TOTAL + " / " + FROST_TOTAL;
        }

        _frostMoveHandler = frostOnMouseMove;
        var screen = document.getElementById("worker-active-screen");
        if (screen) screen.addEventListener("mousemove", _frostMoveHandler);

        _frostResizeHandler = frostResizeCanvas;
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
            if (screen) screen.removeEventListener("mousemove", _frostMoveHandler);
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
        _frostTiles = null;
        _frostFrozen = null;
        _frostGameOver = false;
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
            actionTriggerBtn.disabled = phase !== "commenting";
        }
    }

    actionSettingPills.forEach(function (btn) {
        btn.addEventListener("click", function () {
            setActionSetting(btn.getAttribute("data-action-setting"));
        });
    });

    if (actionTriggerBtn) {
        actionTriggerBtn.addEventListener("click", function () {
            if (currentActionPhase !== "commenting") return;
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
        updateWorkerIdleState(data.active);

        if (MODE === "controller") {
            var circle = document.getElementById("ctrl-circle");
            if (data.active) {
                startSnapshotPolling();
                startCtrlRipples();
                if (circle) circle.classList.add("active");
            } else {
                stopSnapshotPolling();
                stopCtrlRipples();
                if (circle) circle.classList.remove("active");
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
    });

    evtSource.addEventListener("description", function (e) {
        var data = JSON.parse(e.data);
        if (data.text) {
            addToMessageLog(data.text, data.tone, data.timestamp ? String(data.timestamp) : null, data.type || "commentary");
            // Feed text to active commentary screen typewriter
            if (MODE === "worker" && workerActiveScreen && workerActiveScreen.style.display !== "none") {
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
            updateWorkerIdleState(data.active);

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
