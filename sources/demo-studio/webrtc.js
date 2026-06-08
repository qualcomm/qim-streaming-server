// Copyright (c) Qualcomm Technologies, Inc. and/or its subsidiaries.
// SPDX-License-Identifier: BSD-3-Clause-Clear

let peer_id = null;
let ws_conn = null;
let peer_connection = null;
let _connected = false;

let _metaLayout = "right";

function qs() { return new URLSearchParams(window.location.search); }
const _thumbEnabled = (qs().get("thumb") !== "0");

function readMetaFontPx() {

  const raw = (qs().get('meta_font') || qs().get('fontsize') || '').trim();
  if (!raw) return null;
  const num = Number(raw);
  if (Number.isFinite(num)) {
    const clamped = Math.max(8, Math.min(48, num));
    return `${clamped}px`;
  }
  const m = raw.match(/^(\d+(?:\.\d+)?)/);
  if (m) {
    const clamped = Math.max(8, Math.min(48, Number(m[1])));
    return `${clamped}px`;
  }

  return raw;
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

async function maybeStartRTSP() {
  const params = new URLSearchParams(window.location.search);

  const type = params.get("source_type");
  const rtsp = params.get("source");

  if (type !== "rtsp" || !rtsp) return;

  const id =
    window._target_sender_id ||
    params.get("id") ||
    (params.get("ids") || "").split(",")[0];

  if (!id) return;

  if (window._rtspStarted) return;
  window._rtspStarted = true;

  try {
    await fetch("/start-rtsp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        rtsp_url: rtsp,
        webrtc_id: id
      })
    });
  } catch (e) {
    console.error("RTSP start failed", e);
  }
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

  if (b64.startsWith("data:image")) {
    const comma = b64.indexOf(",");
    if (comma >= 0) b64 = b64.slice(comma + 1);
  }
  try {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const blob = new Blob([bytes], { type: "image/jpeg" });
    const url = URL.createObjectURL(blob);
    if (lastThumbUrl) URL.revokeObjectURL(lastThumbUrl);
    lastThumbUrl = url;
    img.src = url;
    img.style.display = "block";
  } catch (e) { clearThumb(); }
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

function websocketServerConnect() {
  let ws_url;
  try { ws_url = getWsUrl(); }
  catch (e) { setStatus("ERR", "bad"); return; }

  resetConnected();
  setStatus("WS");
  ws_conn = new WebSocket(ws_url);

  ws_conn.addEventListener("open", () => {
    peer_id = String(Math.floor(Math.random() * 90000) + 1000);
    ws_conn.send("HELLO " + peer_id);
    const target = window._target_sender_id;
    if (target) {
      ws_conn.send("SESSION " + target);
      setStatus("SESSION");
      setTargetIdLabel(target);
    } else {
      setStatus("READY");
    }
    // ★ ADDED: enforce font once WS opens (safe point)
    applyMetaFontIfNeeded();
  });

  ws_conn.addEventListener("message", onServerMessage);
  ws_conn.addEventListener("error", () => {
    setStatus("ERR", "bad");
    notifyParent("webrtc-disconnected");
    window.setTimeout(websocketServerConnect, 2000);
  });
  ws_conn.addEventListener("close", () => {
    setStatus("OFF", "bad");
    notifyParent("webrtc-disconnected");
    if (peer_connection) {
      try { peer_connection.close(); } catch (e) {}
      peer_connection = null;
    }
    window.setTimeout(websocketServerConnect, 1000);
  });
}

async function onServerMessage(event) {
  const data = event.data;
  if (typeof data === "string" && data.startsWith("HELLO")) {
    if (!window._target_sender_id) setStatus("READY");
    return;
  }
  if (data === "SESSION_OK") {
    setStatus("NEG");
    try { ws_conn.send(JSON.stringify({ cmd: "READY" })); } catch (e) {}
    return;
  }
  if (typeof data === "string" && data.startsWith("ERROR")) {
    setStatus("ERR", "bad");
    notifyParent("webrtc-disconnected");
    return;
  }
  let msg;
  try { msg = JSON.parse(data); }
  catch { setStatus("ERR", "bad"); return; }

  if (!peer_connection) createPeer();

  if (msg.sdp) {
    await onIncomingSDP(msg.sdp);
  } else if (msg.ice) {
    await onIncomingICE(msg.ice);
  } else {
    setStatus("ERR", "bad");
  }
}

// ---------------- WebRTC ----------------
function createPeer() {
  peer_connection = new RTCPeerConnection({
    iceServers: [
      { urls: "stun:stun.services.mozilla.com" },
      { urls: "stun:stun.l.google.com:19302" }
    ]
  });
  setStatus("WAIT");

  const v = getVideoEl();
  if (v) {
    v.onplaying = () => markConnected();
    v.onloadeddata = () => { if (v.readyState >= 2) markConnected(); };
  }

  peer_connection.ontrack = (ev) => {
    const v2 = getVideoEl();
    const ms = (ev.streams && ev.streams[0]) ? ev.streams[0] : new MediaStream([ev.track]);
    if (v2 && v2.srcObject !== ms) v2.srcObject = ms;
    if (v2) v2.play().catch(() => {});
  };

  peer_connection.ondatachannel = (ev) => {
    const ch = ev.channel;
    if (ch.label === "meta") setMetaStatus("OK");

    ch.onopen = () => {
      setMetaStatus("OK");
      // ★ ADDED: enforce font as soon as meta channel is up
      applyMetaFontIfNeeded();
    };
    ch.onclose = () => setMetaStatus("OFF");
    ch.onerror = () => setMetaStatus("ERR");

    ch.onmessage = (m) => {
      const raw = String(m.data);
      let obj = null;
      try { obj = JSON.parse(raw); }
      catch { setMetaText(raw); return; }

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
    };
  };

  peer_connection.onicecandidate = (ev) => {
    if (ev.candidate) {
      try {
        ws_conn.send(JSON.stringify({
          ice: {
            candidate: ev.candidate.candidate,
            sdpMLineIndex: ev.candidate.sdpMLineIndex
          }
        }));
      } catch (e) {}
    }
  };

  peer_connection.oniceconnectionstatechange = () => {
    const st = peer_connection.iceConnectionState;
    if (st === "failed" || st === "disconnected" || st === "closed") {
      notifyParent("webrtc-disconnected");
      if (!_connected) setStatus("OFF", "bad");
    }
  };
}

/* --- Dynamic split: keep ~16:9 video in meta-bottom mode --- */
function adjustMetaHeightToKeepVideo16x9() {
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

// ★ ADDED: ensure font is enforced on load as well
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
    try { ws_conn.send("SESSION " + target); } catch (e) {}
  } else {
    setStatus("WS");
    websocketServerConnect();
  }
}

async function onIncomingSDP(sdp) {
  await peer_connection.setRemoteDescription(sdp);
  if (sdp.type !== "offer") return;
  setStatus("ANSWER");
  const answer = await peer_connection.createAnswer();
  await peer_connection.setLocalDescription(answer);
  try { ws_conn.send(JSON.stringify({ sdp: peer_connection.localDescription })); } catch (e) {}
  setStatus("WAIT");
}

async function onIncomingICE(ice) {
  try { await peer_connection.addIceCandidate(new RTCIceCandidate(ice)); } catch (e) {}
}

// ✅ STARTUP HOOK (THIS IS WHAT YOU ARE MISSING)

window.addEventListener("DOMContentLoaded", async () => {

  // ✅ initialize target id EARLY
  const params = new URLSearchParams(window.location.search);

  window._target_sender_id =
    params.get("id") ||
    (params.get("ids") || "").split(",")[0];

  // ✅ 1. start RTSP adapter (if needed)
  await maybeStartRTSP();

  // ✅ 2. start retry loop
  startRetry();

  // ✅ 3. start websocket
  websocketServerConnect();
});
