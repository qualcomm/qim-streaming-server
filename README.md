# Demo Studio V1

Demo Studio V1 is a browser-based dashboard for viewing live video streams and metadata over WebRTC. It provides single-stream, grid, ring, center, and split-grid views for monitoring streams from devices on the same network.

The container hosts the dashboard UI, a WebRTC signaling server, and an RTSP-to-WebRTC adapter. WebRTC senders can connect directly through the signaling server, while RTSP sources can be started from the dashboard and bridged through GStreamer.

## Repository Layout

- `docker/`: Dockerfile and Docker Compose configuration for the service container.
- `sources/backend/`: Python backend services for HTTP control, WebRTC signaling, and RTSP adaptation.
- `sources/demo-studio/`: Browser UI and shared WebRTC viewer logic.

## Requirements

- Docker
- Docker Compose, either `docker compose` or `docker-compose`
- Network access between the browser, the service host, and the video source devices

## Build and Run

Clone the repository and enter the project directory:

```bash
git clone https://github.com/qualcomm/qim-streaming-server.git
cd qim-streaming-server
```

Build and start the service:

```bash
docker compose -f docker/docker-compose.yml up -d --build
```

If your Docker installation uses the legacy Compose command, use:

```bash
docker-compose -f docker/docker-compose.yml up -d --build
```

The service uses host networking and exposes:

- `8080`: dashboard UI and control API
- `8443`: WebRTC signaling WebSocket server

Open the dashboard from a browser on the same network:

```text
http://<device-ip>:8080
```

## Usage

1. Select the dashboard view: single, grid, ring, center, or split grid.
2. Choose the source type.
3. For WebRTC sources, enter the sender ID values that the sending devices use with the signaling server.
4. For RTSP sources, enter one RTSP URL per tile. The dashboard starts an RTSP adapter for each URL and assigns tile IDs automatically.
5. Select metadata, thumbnail, layout, and font settings as needed.
6. Press **Open** to launch the selected viewer.

Dashboard settings are saved in the browser. Use **Export JSON** and **Import JSON** to move a dashboard configuration between browsers or machines.

## Save and Reload the Image

Save the built image:

```bash
docker save -o sig-service.tar sig-service:ubuntu20
```

Load and run an existing image:

```bash
docker load -i sig-service.tar
docker compose -f docker/docker-compose.yml up -d --no-build
```

## Stop the Service

```bash
docker compose -f docker/docker-compose.yml down
```

## License

Demo Studio V1 is licensed under the BSD-3-Clause-Clear License. See [LICENSE.txt](LICENSE.txt) for the full license text.
