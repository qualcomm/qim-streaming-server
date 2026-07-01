#!/usr/bin/env python3

# Copyright (c) Qualcomm Technologies, Inc. and/or its subsidiaries.
# SPDX-License-Identifier: BSD-3-Clause-Clear

import os
import json
import subprocess
from http.server import SimpleHTTPRequestHandler, HTTPServer

ROOT = "/service/js"
RUNNING = {}

class Handler(SimpleHTTPRequestHandler):
    def translate_path(self, path):
        path = super().translate_path(path)
        rel = os.path.relpath(path, os.getcwd())
        return os.path.join(ROOT, os.path.basename(rel))

    def do_POST(self):
        if self.path == "/start-rtsp":
            length = int(self.headers.get("Content-Length", 0))
            data = json.loads(self.rfile.read(length))

            rtsp_url = data.get("rtsp_url")
            webrtc_id = data.get("webrtc_id")

            if not rtsp_url or not webrtc_id:
                self.send_response(400)
                self.end_headers()
                return

            existing = RUNNING.get(webrtc_id)
            if existing is not None and existing["proc"].poll() is None:
                if existing["rtsp_url"] == rtsp_url:
                    print(f"[CONTROL] RTSP adapter for {webrtc_id} already running "
                          f"(pid={existing['proc'].pid}), skipping")
                    self.send_response(200)
                    self.end_headers()
                    return

                print(f"[CONTROL] RTSP source changed for {webrtc_id}, "
                      f"stopping old adapter (pid={existing['proc'].pid})")
                existing["proc"].terminate()
                try:
                    existing["proc"].wait(timeout=2)
                except subprocess.TimeoutExpired:
                    existing["proc"].kill()
                    existing["proc"].wait(timeout=2)

            print(f"[CONTROL] Start RTSP: {rtsp_url} → {webrtc_id}")

            proc = subprocess.Popen(
                ["python3", "/service/rtsp-adapter.py", rtsp_url, webrtc_id]
            )

            RUNNING[webrtc_id] = {"proc": proc, "rtsp_url": rtsp_url}

            self.send_response(200)
            self.end_headers()
            return

        self.send_response(404)
        self.end_headers()

def run():
    os.chdir(ROOT)
    server = HTTPServer(("0.0.0.0", 8080), Handler)
    print("Control server running on :8080")
    server.serve_forever()

if __name__ == "__main__":
    run()