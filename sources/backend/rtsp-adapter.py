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
import sys

Gst.init(None)


class RTSPWebRTC:
    def __init__(self, rtsp_url, webrtc_id):
        self.rtsp_url = rtsp_url
        self.webrtc_id = webrtc_id
        self.ws = None
        self.pipeline = None
        self.webrtc = None

    def build_pipeline(self):
        self.pipeline = Gst.Pipeline.new("pipeline")

        self.webrtc = Gst.ElementFactory.make("webrtcbin", "sendrecv")
        self.webrtc.set_property("stun-server", "stun://stun.l.google.com:19302")

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

        # ✅ add elements
        self.pipeline.add(rtspsrc)
        self.pipeline.add(depay)
        self.pipeline.add(parse)
        self.pipeline.add(pay)
        self.pipeline.add(capsfilter)
        self.pipeline.add(queue)
        self.pipeline.add(self.webrtc)

        # ✅ link static part
        depay.link(parse)
        parse.link(pay)
        pay.link(capsfilter)
        capsfilter.link(queue)
        queue.link(self.webrtc)

        # ✅ dynamic pad from rtspsrc
        def on_pad_added(src, pad):
            sink_pad = depay.get_static_pad("sink")
            if not sink_pad.is_linked():
                pad.link(sink_pad)

        rtspsrc.connect("pad-added", on_pad_added)

        # ✅ WebRTC signals
        self.webrtc.connect("on-negotiation-needed", self.on_negotiation_needed)
        self.webrtc.connect("on-ice-candidate", self.on_ice_candidate)

    def on_bus_message(self, bus, message):
        t = message.type
        if t == Gst.MessageType.ERROR:
            err, dbg = message.parse_error()
            print("[GST ERROR]:", err, dbg)
        elif t == Gst.MessageType.WARNING:
            err, dbg = message.parse_warning()
            print("[GST WARNING]:", err, dbg)

    async def ws_send(self, msg):
        await self.ws.send(json.dumps(msg))

    # ✅ ICE
    def on_ice_candidate(self, _, mlineindex, candidate):
        asyncio.run_coroutine_threadsafe(
            self.ws_send({
                "ice": {
                    "candidate": candidate,
                    "sdpMLineIndex": mlineindex
                }
            }),
            self.loop
        )

    # ✅ CREATE OFFER
    def on_negotiation_needed(self, element):
        print("[GST] Creating offer")

        promise = Gst.Promise.new_with_change_func(
            self.on_offer_created, element, None
        )
        element.emit("create-offer", None, promise)

    def on_offer_created(self, promise, element, _):
        promise.wait()
        reply = promise.get_reply()
        offer = reply.get_value("offer")

        element.emit("set-local-description", offer, None)

        asyncio.run_coroutine_threadsafe(
            self.ws_send({
                "sdp": {
                    "type": "offer",
                    "sdp": offer.sdp.as_text()
                }
            }),
            self.loop
        )

    # ✅ HANDLE ANSWER
    def handle_sdp(self, sdp):
        res, sdpmsg = GstSdp.SDPMessage.new()
        GstSdp.sdp_message_parse_buffer(bytes(sdp.encode()), sdpmsg)

        answer = GstWebRTC.WebRTCSessionDescription.new(
            GstWebRTC.WebRTCSDPType.ANSWER,
            sdpmsg
        )

        self.webrtc.emit("set-remote-description", answer, None)

    def handle_ice(self, ice):
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
            except:
                continue

            # ✅ START PIPELINE
            if data.get("cmd") == "READY":
                print("[WS] READY → starting pipeline")

                self.build_pipeline()
                self.pipeline.set_state(Gst.State.PLAYING)
                continue

            if "sdp" in data:
                self.handle_sdp(data["sdp"]["sdp"])

            elif "ice" in data:
                self.handle_ice(data["ice"])


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