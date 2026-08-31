# Demo Studio V1

# Demo Studio V1

*Demo Studio V1 is a tool that enables users to stream video and metadata from a device to a web browser in real time using WebRTC. It allows visualization of both the video feed and structured detection data directly in the browser, providing a flexible and low-latency monitoring interface.*

Project that does ... implemented in ... runs on Qualcomm® *\<processor\>*


## Requirements

 - Docker

## Installation Instructions
 # Build and run
(needs internet connection)<br>
`docker-compose -f demo-studio/docker/docker-compose.yml up -d --build`

# Save the image
`docker save -o ../images/sig-service.tar sig-service:ubuntu20`

# To run from the saved image (host the web UI)
 - `cd demo-studio/docker/` <br>
 - `docker load -i sig-service.tar` <br>
 - `docker-compose up -d --no-build`


## Usage

 - After running the docker image, navigate to `<device-ip>:8080` in a browser on a machine in the same network
 - Configure the desired settings from the UI
 - Start a sender webrtc stream on a device in the same network
 - Enter sender ID in the UI and press open


# To run from the saved image (host the web UI)
 - `cd demo-studio/docker/` <br>
 - `docker load -i sig-service.tar` <br>
 - `docker-compose up -d --no-build`


## Usage

 - After running the docker image, navigate to `<device-ip>:8080` in a browser on a machine in the same network
 - Configure the desired settings from the UI
 - Start a sender webrtc stream on a device in the same network
 - Enter sender ID in the UI and press open


## License

Demo Studio V1 is licensed under the BSD-3-Clause-Clear License. See [LICENSE.txt](LICENSE.txt) for the full license text.

