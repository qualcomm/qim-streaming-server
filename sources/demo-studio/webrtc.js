// Copyright (c) Qualcomm Technologies, Inc. and/or its subsidiaries.
// SPDX-License-Identifier: BSD-3-Clause-Clear

let ws_conn = null;
let _connected = false;

let _metaLayout = "right";

function qs() { return new URLSearchParams(window.location.search); }
const _thumbEnabled = (qs().get("thumb") !== "0");

function readMetaFontPx() {
  return WebRTCViewer.resolveMetaFontPx(qs());
}

let _metaFontApplied = null;
let _metaFontStyleTag = null;

function enforceMetaFont(px) {
  if (!px) return;

  document.documentElement.style.setProperty('--meta-font', px);

  const box = document.getElementById('metaBox');
  if (box) box.style.setProperty('font-size', px, 'important');

  if (!_metaFontStyleTag) {
    _metaFontStyleTag = document.createElement('style');
    document.head.appendChild(_metaFontStyleTag);
  }
  _metaFontStyleTag.textContent = `
    #rightPane, #rightPane * { font-size: ${px} !important; }
  `;
  _metaFontApplied = px;
}

let retryTimer = null;

function startRetry() {
  if (retryTimer) return;

  retryTimer = setInterval(() => {
    connectToSender();
  }, 2000);
}

function stopRetry() {
  if (retryTimer) {
    clearInterval(retryTimer);
    retryTimer = null;
  }
}

function applyMetaFontIfNeeded() {
  const px = readMetaFontPx();
  if (px && px !== _metaFontApplied) {
    enforceMetaFont(px);
  }
}

function setStatus(text, cls /* 'ok' | 'bad' | null */) {
  const el = document.getElementById("status");
  if (!el) return;
  el.textContent = text;
  el.classList.remove("ok", "bad");
  if (cls) el.classList.add(cls);
}
function setMetaStatus(text) {
  const el = document.getElementById("metaStatus");
  if (el) el.textContent = text;
}
function setMetaText(txt) {
  const el = document.getElementById("metaBox");
  if (!el) return;
  el.textContent = txt || "";
  applyMetaFontIfNeeded();
}
function setTargetIdLabel(id) {
  const el = document.getElementById("targetId");
  if (!el) return;
  el.textContent = (id == null) ? "" : String(id);
}
function getVideoEl() { return document.getElementById("videoLeft"); }

function getWsUrl() {
  const override = qs().get("ws");
  const port = qs().get("port") || "8443";
  if (override) return `ws://${override}`;
  if (window.location.protocol.startsWith("http")) {
    return `ws://${window.location.hostname}:${port}`;
  }
  throw new Error("No ws");
}

function notifyParent(type, extra) {
  try { window.parent?.postMessage({ type, ...(extra || {}) }, "*"); } catch (e) {}
}
function requestConnectAll() { notifyParent("connect-all"); }
function markConnected() {
  if (_connected) return;

  stopRetry();

  _connected = true;
  setStatus("CONNECTED", "ok");
  notifyParent("webrtc-connected");
}

function resetConnected() { _connected = false; }

let lastThumbUrl = null;
function clearThumb() {
  const img = document.getElementById("metaThumb");
  if (!img) return;
  if (lastThumbUrl) URL.revokeObjectURL(lastThumbUrl);
  lastThumbUrl = null;
  img.removeAttribute("src");
  img.style.display = "none";
}
function setMetaThumbFromBase64(b64) {
  const img = document.getElementById("metaThumb");
  if (!img) return;
  if (!b64 || typeof b64 !== "string" || b64.length < 32) {
    clearThumb(); return;
  }
  const url = WebRTCViewer.decodeBase64ToBlobURL(b64, lastThumbUrl);
  if (!url) { clearThumb(); return; }
  lastThumbUrl = url;
  img.src = url;
  img.style.display = "block";
}

function placeThumb(mode /* 'right' | 'bottom' */) {
  _metaLayout = mode;
  const img = document.getElementById("metaThumb");
  const bottomWrap = document.getElementById("rightThumbWrap");
  if (!img || !bottomWrap) return;
  if (mode === "bottom") {

    if (img.parentElement !== bottomWrap) bottomWrap.appendChild(img);
  } else {

    if (img.parentElement !== bottomWrap) bottomWrap.appendChild(img);
    clearThumb();
  }
}

const thumbAssemblies = new Map();
function cleanupThumbAssemblies(maxAgeMs = 8000) {
  const now = Date.now();
  for (const [id, a] of thumbAssemblies.entries()) {
    if (!a || (now - a.t0) > maxAgeMs) thumbAssemblies.delete(id);
  }
}
function handleStatusMessage(msg) {
  if (msg && msg.type === "status") {
    setStatus(msg.data);
    return true;
  }
}
function handleThumbMessage(msg) {
  const t = msg?.type;
  const isThumbType = t === "thumb"
    || t === "thumb-begin"
    || t === "thumb-chunk"
    || t === "thumb-end";

  if (!isThumbType) return false;

  if (!_thumbEnabled) return true;

  if (_metaLayout !== "bottom") return true;

  if (t === "thumb") {
    const b64 = msg.thumb_jpeg_b64 ?? msg.buffer_base64 ?? null;
    setMetaThumbFromBase64(b64);
    return true;
  }
  if (t === "thumb-begin") {
    cleanupThumbAssemblies();
    const id = msg.id;
    const n = msg.n;
    if (typeof id === "undefined" || typeof n !== "number" || n <= 0) return true;
    thumbAssemblies.set(id, { n, parts: new Array(n), got: 0, t0: Date.now() });
    return true;
  }
  if (t === "thumb-chunk") {
    const a = thumbAssemblies.get(msg.id);
    if (!a) return true;
    const i = msg.i;
    if (typeof i !== "number" || i < 0 || i >= a.n) return true;
    if (typeof msg.data !== "string") return true;
    if (a.parts[i] == null) { a.parts[i] = msg.data; a.got++; }
    return true;
  }
  if (t === "thumb-end") {
    const a = thumbAssemblies.get(msg.id);
    if (!a) return true;
    if (a.got === a.n) setMetaThumbFromBase64(a.parts.join(""));
    thumbAssemblies.delete(msg.id);
    return true;
  }
  return false;
}

window.addEventListener("message", (ev) => {
  const msg = ev.data;
  if (!msg || typeof msg !== "object") return;
  if (msg.type === "meta-layout") {
    const isBottom = (msg.mode === "bottom");
    document.body.classList.toggle("meta-bottom", isBottom);
    placeThumb(isBottom ? "bottom" : "right");

    adjustMetaHeightToKeepVideo16x9();
    return;
  }
  if (msg.type === "set-id") {
    const id = String(msg.id ?? "").trim();
    if (!id) return;
    const input = document.getElementById("sender-id");
    if (input) input.value = id;
    window._target_sender_id = id;
    setTargetIdLabel(id);
    return;
  }
  if (msg.type === "connect") {
    const id = String(msg.id ?? "").trim();
    if (id) {
      const input = document.getElementById("sender-id");
      if (input) input.value = id;
      window._target_sender_id = id;
      setTargetIdLabel(id);
    }
    try { connectToSender(); } catch (e) {}
    return;
  }
});

// ---------------- WebRTC / signaling engine ----------------
const engine = WebRTCViewer.create({
  getWsUrl,
  hooks: {
    onOpen() {
      const target = window._target_sender_id;
      if (target) {
        engine.sendSession(target);
        setStatus("SESSION");
        setTargetIdLabel(target);
      } else {
        setStatus("READY");
      }
      applyMetaFontIfNeeded();
    },
    onWsError() {
      setStatus("ERR", "bad");
      notifyParent("webrtc-disconnected");
      window.setTimeout(websocketServerConnect, 2000);
    },
    onWsClose() {
      setStatus("OFF", "bad");
      notifyParent("webrtc-disconnected");
      engine.closePeerConnection();
      window.setTimeout(websocketServerConnect, 1000);
    },
    onHello() {
      if (!window._target_sender_id) setStatus("READY");
    },
    onSessionOk() {
      setStatus("NEG");
    },
    onSessionError() {
      setStatus("ERR", "bad");
      notifyParent("webrtc-disconnected");
    },
    onProtocolError() {
      setStatus("ERR", "bad");
    },
    onAnswering() {
      setStatus("ANSWER");
    },
    onAnswerSent() {
      setStatus("WAIT");
    },
    onPeerCreated() {
      setStatus("WAIT");
      const v = getVideoEl();
      if (v) {
        v.onplaying = () => markConnected();
        v.onloadeddata = () => { if (v.readyState >= 2) markConnected(); };
      }
    },
    onTrack(ev) {
      const v2 = getVideoEl();
      const ms = (ev.streams && ev.streams[0]) ? ev.streams[0] : new MediaStream([ev.track]);
      if (v2 && v2.srcObject !== ms) v2.srcObject = ms;
      if (v2) v2.play().catch(() => {});
    },
    onDataChannel(ch) {
      if (ch.label === "meta") setMetaStatus("OK");
    },
    onMetaOpen() {
      setMetaStatus("OK");
      applyMetaFontIfNeeded();
    },
    onMetaClose() {
      setMetaStatus("OFF");
    },
    onMetaError() {
      setMetaStatus("ERR");
    },
    onMetaMessage(obj, raw) {
      if (typeof obj === "undefined") { setMetaText(raw); return; }

      if (handleStatusMessage(obj)) return;
      // If it was thumb or thumb-chunk, handled (or ignored) here
      if (handleThumbMessage(obj)) return;

      let display = "";

      if (obj.object_detection && obj.object_detection.length) {

        display = obj.object_detection.map((o, i) => {
          return `#${i + 1} ${o.label}
          Conf: ${o.confidence.toFixed(1)}%`;
        }).join("\n\n");

        display = `${obj.object_detection.length}\n\n` + display;
      }

      // if (obj.parameters?.timestamp) {
      //   display += `\n\nTimestamp: ${obj.parameters.timestamp}`;
      // }

      // fallback (important!)
      if (!display) {
        display = JSON.stringify(obj, null, 2);
      }

      setMetaText(display);

      setStatus("OK", "ok");

      // Embedded thumbs (only when enabled and bottom layout)
      if (_thumbEnabled && _metaLayout === "bottom") {
        const b64 = obj.thumb_jpeg_b64 ?? obj.buffer_base64 ?? null;
        setMetaThumbFromBase64(b64);
      }
    },
    onIceStateChange(st) {
      if (st === "failed" || st === "disconnected" || st === "closed") {
        notifyParent("webrtc-disconnected");
        if (!_connected) setStatus("OFF", "bad");
      }
    }
  }
});

function websocketServerConnect() {
  resetConnected();
  setStatus("WS");
  ws_conn = engine.connect();
}

/* --- Dynamic split: keep ~16:9 video in meta-bottom mode --- */
function adjustMetaHeightToKeepVideo16x9() {
  if (!document.body) return;
  if (!document.body.classList.contains('meta-bottom')) return;
  if (document.body.classList.contains('video-only')) return;

  const main = document.querySelector('main');
  const left = document.getElementById('leftPane');
  if (!main || !left) return;

  const totalH = main.clientHeight;
  const w = left.clientWidth; // width available to video
  const idealVideoH = Math.round(w * 9 / 16); // perfect 16:9
  let metaH = totalH - idealVideoH;

  // Read min/max from CSS variables if present
  const styles = getComputedStyle(document.body);
  const metaMin = parseFloat(styles.getPropertyValue('--meta-h-min')) || 60;
  const metaMaxFrac = parseFloat(styles.getPropertyValue('--meta-h-max-frac')) || 0.5;
  const metaMax = totalH * metaMaxFrac;

  // Clamp and set
  metaH = Math.max(metaMin, Math.min(metaH, metaMax));
  document.body.style.setProperty('--meta-h', `${metaH}px`);
}
adjustMetaHeightToKeepVideo16x9();
window.addEventListener('resize', adjustMetaHeightToKeepVideo16x9);

// Re-run when meta content size changes
const metaBox = document.getElementById('metaBox');
if (window.ResizeObserver && metaBox) {
  const ro = new ResizeObserver(adjustMetaHeightToKeepVideo16x9);
  ro.observe(metaBox);
}

applyMetaFontIfNeeded();

function connectToSender() {
  const input = document.getElementById("sender-id");
  const target = input ? input.value.trim() : (String(window._target_sender_id || "").trim());
  if (!target) {
    setStatus("ID", "bad"); return;
  }
  window._target_sender_id = target;
  setTargetIdLabel(target);
  resetConnected();

  if (ws_conn && ws_conn.readyState === WebSocket.OPEN) {
    setStatus("SESSION");
    engine.sendSession(target);
  } else {
    setStatus("WS");
    ws_conn = engine.connect();
  }
}

window.addEventListener("DOMContentLoaded", async () => {
  const params = new URLSearchParams(window.location.search);

  window._target_sender_id =
    params.get("id") ||
    params.get("sender") ||
    (params.get("ids") || "").split(",")[0];

  startRetry();
  websocketServerConnect();
});
