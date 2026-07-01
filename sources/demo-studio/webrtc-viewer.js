// Copyright (c) Qualcomm Technologies, Inc. and/or its subsidiaries.
// SPDX-License-Identifier: BSD-3-Clause-Clear
//
// Shared WebRTC/signaling engine used by both webrtc.js (grid/ring/center/
// split-grid tiles, via webrtc.html) and single-view.html. Owns the
// WebSocket signaling protocol, the RTCPeerConnection lifecycle, and the
// "meta" data channel wiring. Each consumer supplies hooks that reproduce
// its own status text / retry policy / rendering - this module only owns
// the mechanical parts that were already identical across both files.
// Reconnect timing/policy stays page-owned: the engine never reconnects or
// closes the peer connection on its own, so each page can keep its existing
// (different) delays around ws/pc teardown.

(function () {
  const DEFAULT_STUN_SERVERS = [
    { urls: "stun:stun.services.mozilla.com" },
    { urls: "stun:stun.l.google.com:19302" }
  ];

  function defaultCreateHelloId() {
    return String(Math.floor(Math.random() * 90000) + 1000);
  }

  function resolveMetaFontPx(qs) {
    const raw = (qs.get("meta_font") || qs.get("fontsize") || "").trim();
    if (!raw) return null;
    const num = Number(raw);
    if (Number.isFinite(num)) {
      return `${Math.max(8, Math.min(48, num))}px`;
    }
    const m = raw.match(/^(\d+(?:\.\d+)?)/);
    if (m) {
      return `${Math.max(8, Math.min(48, Number(m[1])))}px`;
    }
    return raw;
  }

  function decodeBase64ToBlobURL(b64, previousUrl) {
    try {
      if (typeof b64 !== "string") return null;
      if (b64.startsWith("data:image")) {
        const i = b64.indexOf(",");
        if (i >= 0) b64 = b64.slice(i + 1);
      }
      const bin = atob(b64);
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      const blob = new Blob([arr], { type: "image/jpeg" });
      if (previousUrl) { try { URL.revokeObjectURL(previousUrl); } catch (e) {} }
      return URL.createObjectURL(blob);
    } catch (e) {
      return null;
    }
  }

  function createWebRTCViewer(config) {
    config = config || {};
    const hooks = config.hooks || {};
    const stunServers = config.stunServers || DEFAULT_STUN_SERVERS;
    const createHelloId = config.createHelloId || defaultCreateHelloId;
    const retryOnErrorMs = config.retryOnErrorMs || null;

    let ws = null;
    let pc = null;
    let currentTargetId = null;
    let connected = false;
    let sessionRetryTimer = null;

    function call(name, ...args) {
      const fn = hooks[name];
      if (typeof fn === "function") {
        try { return fn(...args); }
        catch (e) { console.error(`[webrtc-viewer] hook "${name}" threw:`, e); }
      }
    }

    function markConnected() {
      connected = true;
      stopSessionRetry();
    }
    function resetConnected() { connected = false; }
    function isConnected() { return connected; }

    function stopSessionRetry() {
      if (sessionRetryTimer) { clearTimeout(sessionRetryTimer); sessionRetryTimer = null; }
    }

    function sendSession(id) {
      currentTargetId = id;
      if (ws && ws.readyState === WebSocket.OPEN) {
        try { ws.send("SESSION " + id); } catch (e) {}
        return true;
      }
      return false;
    }

    function scheduleSessionRetry() {
      if (!retryOnErrorMs) return;
      if (connected || sessionRetryTimer) return;
      // The RTSP adapter is spawned by /start-rtsp and needs a moment to boot
      // before it registers with the signaling server. A SESSION request
      // sent before that finishes gets ERROR peer not found - retry on the
      // same websocket instead of surfacing a dead error.
      sessionRetryTimer = setTimeout(() => {
        sessionRetryTimer = null;
        if (connected) return;
        if (ws && ws.readyState === WebSocket.OPEN) {
          call("onSessionRetry", currentTargetId);
          try { ws.send("SESSION " + currentTargetId); } catch (e) {}
        }
      }, retryOnErrorMs);
    }

    function closePeerConnection() {
      try { pc && pc.close(); } catch (e) {}
      pc = null;
    }

    function disconnect() {
      stopSessionRetry();
      try { ws && ws.close(); } catch (e) {}
      ws = null;
      closePeerConnection();
      resetConnected();
    }

    function ensurePeerConnection() {
      if (pc) return pc;
      pc = new RTCPeerConnection({ iceServers: stunServers });
      call("onPeerCreated");

      pc.ontrack = (ev) => {
        console.log("[TRACK] ontrack fired kind=", ev.track && ev.track.kind);
        call("onTrack", ev);
      };

      pc.ondatachannel = (ev) => {
        const ch = ev.channel;
        console.log("[META] ondatachannel fired label=", ch.label, "readyState=", ch.readyState);
        call("onDataChannel", ch);
        ch.onopen = () => { console.log("[META] channel open"); call("onMetaOpen"); };
        ch.onclose = () => { console.log("[META] channel closed"); call("onMetaClose"); };
        ch.onerror = (err) => { console.error("[META] channel error", err); call("onMetaError", err); };
        ch.onmessage = (ev2) => {
          const raw = String(ev2.data || "");
          console.log("[META] raw message:", raw);
          let obj;
          try { obj = JSON.parse(raw); } catch (e) {}
          call("onMetaMessage", obj, raw);
        };
      };

      pc.onicecandidate = (ev) => {
        if (ev.candidate) {
          console.log("[ICE] local candidate", ev.candidate.candidate);
          if (ws && ws.readyState === WebSocket.OPEN) {
            try {
              ws.send(JSON.stringify({
                ice: { candidate: ev.candidate.candidate, sdpMLineIndex: ev.candidate.sdpMLineIndex }
              }));
            } catch (e) {}
          }
        } else {
          console.log("[ICE] local candidate gathering complete");
        }
      };

      pc.oniceconnectionstatechange = () => {
        console.log("[ICE] connection state:", pc.iceConnectionState);
        call("onIceStateChange", pc.iceConnectionState);
      };

      return pc;
    }

    async function handleIncomingSDP(sdp) {
      console.log("[SDP] incoming", sdp.type, "\n" + sdp.sdp);
      await pc.setRemoteDescription(sdp);
      if (sdp.type !== "offer") return;
      call("onAnswering");
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      console.log("[SDP] outgoing answer\n" + answer.sdp);
      try { ws.send(JSON.stringify({ sdp: pc.localDescription })); } catch (e) {}
      call("onAnswerSent");
    }

    async function handleIncomingICE(ice) {
      console.log("[ICE] remote candidate", ice);
      try { await pc.addIceCandidate(new RTCIceCandidate(ice)); }
      catch (e) { console.error("[ICE] addIceCandidate failed", e); }
    }

    async function onWsMessage(ev) {
      const data = ev.data;
      if (typeof data === "string" && data.startsWith("HELLO")) {
        call("onHello");
        return;
      }
      if (data === "SESSION_OK") {
        stopSessionRetry();
        call("onSessionOk");
        try { ws.send(JSON.stringify({ cmd: "READY" })); } catch (e) {}
        return;
      }
      if (typeof data === "string" && data.startsWith("ERROR")) {
        call("onSessionError");
        scheduleSessionRetry();
        return;
      }
      let msg;
      try { msg = JSON.parse(data); }
      catch (e) { call("onProtocolError", "parse"); return; }

      ensurePeerConnection();

      if (msg.sdp) {
        await handleIncomingSDP(msg.sdp);
      } else if (msg.ice) {
        await handleIncomingICE(msg.ice);
      } else {
        call("onProtocolError", "unknown-message");
      }
    }

    function connect() {
      let wsUrl;
      try { wsUrl = config.getWsUrl(); }
      catch (e) { call("onProtocolError", "no-ws-url"); return null; }

      resetConnected();
      ws = new WebSocket(wsUrl);
      ws.addEventListener("open", () => {
        const helloId = createHelloId();
        ws.send("HELLO " + helloId);
        call("onOpen");
      });
      ws.addEventListener("message", onWsMessage);
      ws.addEventListener("error", () => call("onWsError"));
      ws.addEventListener("close", () => call("onWsClose"));

      return ws;
    }

    return {
      connect,
      disconnect,
      closePeerConnection,
      stopSessionRetry,
      sendSession,
      markConnected,
      resetConnected,
      isConnected
    };
  }

  window.WebRTCViewer = {
    create: createWebRTCViewer,
    resolveMetaFontPx,
    decodeBase64ToBlobURL
  };
})();
