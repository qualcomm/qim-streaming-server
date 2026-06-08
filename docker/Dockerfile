FROM ubuntu:20.04

ENV DEBIAN_FRONTEND=noninteractive PYTHONUNBUFFERED=1

#RUN apt-get update && apt-get install -y python3

RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-pip ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN python3 -m pip install --no-cache-dir --upgrade pip && \
    python3 -m pip install --no-cache-dir websockets

# Installing required apt packages
RUN apt-get update && \
    DEBIAN_FRONTEND=noninteractive TZ=Etc/UTC apt-get install -y \
        bash-completion \
        python3 \
        python3-pip \
        python3-gi \
        python3-gst-1.0 \
        gstreamer1.0-tools \
        gstreamer1.0-plugins-base \
        gstreamer1.0-plugins-good \
        gstreamer1.0-plugins-bad \
        gstreamer1.0-plugins-ugly \
        gstreamer1.0-libav \
        gir1.2-gst-plugins-base-1.0 \
        gir1.2-gst-plugins-bad-1.0 \
        libgstrtspserver-1.0-0 \
        gstreamer1.0-nice \
        libjpeg62 \
        libprotobuf17 \
        libdaemon0 \
        librdkafka1 \
        libhiredis0.14 \

    && apt-get autoremove -y \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/* /var/tmp/*

RUN mkdir -p /service

WORKDIR /service

COPY sources/backend/ /service/

COPY sources/demo-studio /service/js

EXPOSE 8080 8443

CMD bash -lc "python3 /service/control_server.py & \
              python3 /service/signaling.py & \
              wait -n; kill 0"
