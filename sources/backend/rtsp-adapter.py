#!/usr/bin/env python3

# Copyright (c) Qualcomm Technologies, Inc. and/or its subsidiaries.
# SPDX-License-Identifier: BSD-3-Clause-Clear

import gi
gi.require_version("Gst", "1.0")
gi.require_version("GstWebRTC", "1.0")
gi.require_version("GstSdp", "1.0")

from gi.repository import Gst, GstWebRTC, GstSdp

import asyncio
import websockets
import json
import socket
import sys
import threading

Gst.init(None)
print(f"[INFO] GStreamer {Gst.version_string()}", flush=True)

STUN_HOST = "stun.l.google.com"
STUN_PORT = 19302
STUN_RESOLVE_TIMEOUT = 1.0


def resolve_stun_server():
    """DNS lookup for the STUN host can block for many seconds (observed:
    20s+, effectively unbounded) when there is no route to a resolver
    (offline/LAN-only deployments). socket.setdefaulttimeout() does NOT
    bound gethostbyname()/getaddrinfo() - that timeout only applies to
    socket I/O, not the underlying libc resolver call. webrtcbin resolves
    the hostname synchronously on the pipeline thread during create-offer,
    so a hung lookup stalls the entire offer/answer exchange (and, if this
    runs before the RTSP/video elements are linked, video too). Run the
    lookup on a background daemon thread and abandon it if it doesn't
    finish in time - the thread may keep hanging, but daemon threads don't
    block process exit and we simply proceed without STUN."""
    result = {}

    def do_lookup():
        try:
            result["ip"] = socket.gethostbyname(STUN_HOST)
        except Exception as e:
            result["error"] = e

    t = threading.Thread(target=do_lookup, daemon=True)
    t.start()
    t.join(STUN_RESOLVE_TIMEOUT)

    if "ip" in result:
        return f"stun://{result['ip']}:{STUN_PORT}"

    reason = result.get("error", "timed out")
    print(f"[STUN] {STUN_HOST} did not resolve within {STUN_RESOLVE_TIMEOUT}s ({reason}), continuing without STUN", flush=True)
    return None


class RTSPWebRTC:
    def __init__(self, rtsp_url, webrtc_id):
        self.rtsp_url = rtsp_url
        self.webrtc_id = webrtc_id
        self.ws = None
        self.pipeline = None
        self.webrtc = None
        self.meta_channel = None

    def build_pipeline(self):
        self.pipeline = Gst.Pipeline.new("pipeline")

        self.webrtc = Gst.ElementFactory.make("webrtcbin", "sendrecv")
        stun_server = resolve_stun_server()
        if stun_server:
            self.webrtc.set_property("stun-server", stun_server)

        # Connect on-negotiation-needed BEFORE create-data-channel: it can fire
        # synchronously inside the emit() call below, and a handler connected
        # afterward would miss that firing (channel gets created but no offer
        # is ever produced for it).
        self.webrtc.connect("on-negotiation-needed", self.on_negotiation_needed)
        self.webrtc.connect("on-ice-candidate", self.on_ice_candidate)

        self.pipeline.add(self.webrtc)

        rtspsrc = Gst.ElementFactory.make("rtspsrc", "src")
        rtspsrc.set_property("location", self.rtsp_url)
        rtspsrc.set_property("latency", 0)
        rtspsrc.set_property("drop-on-latency", True)

        depay = Gst.ElementFactory.make("rtph264depay", "depay")
        parse = Gst.ElementFactory.make("h264parse", "parse")
        pay = Gst.ElementFactory.make("rtph264pay", "pay")
        pay.set_property("pt", 96)
        pay.set_property("config-interval", 1)

        capsfilter = Gst.ElementFactory.make("capsfilter", "caps")
        capsfilter.set_property(
            "caps",
            Gst.Caps.from_string(
                "application/x-rtp,media=video,encoding-name=H264,payload=96,clock-rate=90000"
            )
        )

        queue = Gst.ElementFactory.make("queue", "q")

        # qtirtspbin packetizes the metadata track as text/x-raw wrapped in
        # rtpgstpay (media=application, encoding-name=X-GST) - needs its own
        # depay/sink branch, it cannot share the video depayloader.
        metadepay = Gst.ElementFactory.make("rtpgstdepay", "metadepay")
        metasink = Gst.ElementFactory.make("appsink", "metasink")
        metasink.set_property("emit-signals", True)
        metasink.set_property("sync", False)
        metasink.connect("new-sample", self.on_meta_sample)

        self.pipeline.add(rtspsrc)
        self.pipeline.add(depay)
        self.pipeline.add(parse)
        self.pipeline.add(pay)
        self.pipeline.add(capsfilter)
        self.pipeline.add(queue)
        self.pipeline.add(metadepay)
        self.pipeline.add(metasink)

        depay.link(parse)
        parse.link(pay)
        pay.link(capsfilter)
        capsfilter.link(queue)
        queue.link(self.webrtc)
        metadepay.link(metasink)

        def on_pad_added(src, pad):
            caps      = pad.get_current_caps() or pad.query_caps(None)
            structure = caps.get_structure(0) if caps and caps.get_size() > 0 else None
            media     = structure.get_string("media") if structure else None
            enc       = structure.get_string("encoding-name") if structure else None
            print(f"[GST] pad-added  media={media}  encoding={enc}  caps={caps.to_string() if caps else 'none'}", flush=True)

            if media == "video":
                sink_pad = depay.get_static_pad("sink")
            else:
                sink_pad = metadepay.get_static_pad("sink")

            if not sink_pad.is_linked():
                result = pad.link(sink_pad)
                print(f"[GST] pad link result ({media}): {result}", flush=True)
            else:
                print(f"[GST] {media} sink already linked, ignoring this pad", flush=True)

        rtspsrc.connect("pad-added", on_pad_added)

        # webrtcbin must be past NULL state before create-data-channel works -
        # on NULL it silently returns None (gst_webrtc_bin_create_data_channel
        # asserts !is_closed, which only becomes true once the element enters
        # at least READY).
        self.webrtc.set_state(Gst.State.READY)

        channel = self.webrtc.emit("create-data-channel", "meta", None)
        if channel is not None:
            print("[META] create-data-channel returned channel directly", flush=True)
            self.meta_channel = channel
            channel.connect("on-open",  lambda _:    print("[META] channel open", flush=True))
            channel.connect("on-close", lambda _:    print("[META] channel closed", flush=True))
            channel.connect("on-error", lambda _, e: print("[META] channel error:", e, flush=True))
        else:
            print("[META] create-data-channel returned None, waiting for on-data-channel", flush=True)
            self.webrtc.connect("on-data-channel", self.on_data_channel)

        bus = self.pipeline.get_bus()
        bus.add_signal_watch()
        bus.connect("message", self.on_bus_message)

    def on_data_channel(self, _, channel):
        label = channel.get_property("label") if channel else "?"
        print(f"[META] on-data-channel: label={label}", flush=True)
        self.meta_channel = channel
        channel.connect("on-open",  lambda _:    print("[META] channel open", flush=True))
        channel.connect("on-close", lambda _:    print("[META] channel closed", flush=True))
        channel.connect("on-error", lambda _, e: print("[META] channel error:", e, flush=True))

    def on_meta_sample(self, sink):
        sample = sink.emit("pull-sample")
        if sample is None:
            return Gst.FlowReturn.OK

        buf = sample.get_buffer()
        ok, mapinfo = buf.map(Gst.MapFlags.READ)
        if not ok:
            return Gst.FlowReturn.OK

        text = mapinfo.data.decode("utf-8", errors="replace").strip()
        buf.unmap(mapinfo)

        if text and self.meta_channel:
            try:
                state = self.meta_channel.get_property("ready-state")
                if state == GstWebRTC.WebRTCDataChannelState.OPEN:
                    self.meta_channel.emit("send-string", text)
            except Exception as e:
                print("[META] send error:", e, flush=True)

        return Gst.FlowReturn.OK

    def on_bus_message(self, bus, message):
        t = message.type
        if t == Gst.MessageType.ERROR:
            err, dbg = message.parse_error()
            print("[GST ERROR]:", err, dbg, flush=True)
        elif t == Gst.MessageType.WARNING:
            err, dbg = message.parse_warning()
            print("[GST WARNING]:", err, dbg, flush=True)
        elif t == Gst.MessageType.STATE_CHANGED and message.src == self.pipeline:
            old, new, pending = message.parse_state_changed()
            print(f"[GST] pipeline state: {old.value_nick} -> {new.value_nick}", flush=True)

    async def ws_send(self, msg):
        await self.ws.send(json.dumps(msg))

    def on_ice_candidate(self, _, mlineindex, candidate):
        print(f"[ICE] local candidate  mline={mlineindex}  {candidate}", flush=True)
        asyncio.run_coroutine_threadsafe(
            self.ws_send({
                "ice": {
                    "candidate": candidate,
                    "sdpMLineIndex": mlineindex
                }
            }),
            self.loop
        )

    def on_negotiation_needed(self, element):
        print("[GST] on-negotiation-needed fired, creating offer", flush=True)

        promise = Gst.Promise.new_with_change_func(
            self.on_offer_created, element, None
        )
        element.emit("create-offer", None, promise)

    def on_offer_created(self, promise, element, _):
        promise.wait()
        reply = promise.get_reply()
        offer = reply.get_value("offer")

        element.emit("set-local-description", offer, None)
        print("[GST] Offer SDP:\n" + offer.sdp.as_text(), flush=True)

        asyncio.run_coroutine_threadsafe(
            self.ws_send({
                "sdp": {
                    "type": "offer",
                    "sdp": offer.sdp.as_text()
                }
            }),
            self.loop
        )

    def handle_sdp(self, sdp):
        print("[WS] Answer SDP:\n" + sdp, flush=True)
        res, sdpmsg = GstSdp.SDPMessage.new()
        GstSdp.sdp_message_parse_buffer(bytes(sdp.encode()), sdpmsg)

        answer = GstWebRTC.WebRTCSessionDescription.new(
            GstWebRTC.WebRTCSDPType.ANSWER,
            sdpmsg
        )

        self.webrtc.emit("set-remote-description", answer, None)

    def handle_ice(self, ice):
        print(f"[ICE] remote candidate  mline={ice['sdpMLineIndex']}  {ice['candidate']}", flush=True)
        self.webrtc.emit(
            "add-ice-candidate",
            ice["sdpMLineIndex"],
            ice["candidate"]
        )

    async def connect_ws(self):
        self.ws = await websockets.connect("ws://127.0.0.1:8443")
        print("[WS] Connected")
        await self.ws.send(f"HELLO {self.webrtc_id}")

    async def run(self):
        self.loop = asyncio.get_event_loop()
        await self.connect_ws()

        while True:
            msg = await self.ws.recv()
            print("[WS]", msg)

            if msg.startswith("HELLO"):
                continue

            try:
                data = json.loads(msg)
            except Exception:
                continue

            try:
                if data.get("cmd") == "READY":
                    print("[WS] READY → starting pipeline")
                    self.build_pipeline()
                    self.pipeline.set_state(Gst.State.PLAYING)
                elif "sdp" in data:
                    self.handle_sdp(data["sdp"]["sdp"])
                elif "ice" in data:
                    self.handle_ice(data["ice"])
            except Exception as e:
                import traceback
                print(f"[ERROR] Failed to handle message {msg!r}:", e, flush=True)
                traceback.print_exc()


async def main():
    if len(sys.argv) < 3:
        print("Usage: rtsp_adapter.py <rtsp_url> <webrtc_id>")
        return

    rtsp_url = sys.argv[1]
    webrtc_id = sys.argv[2]

    app = RTSPWebRTC(rtsp_url, webrtc_id)
    await app.run()


if __name__ == "__main__":
    asyncio.run(main())