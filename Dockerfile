FROM python:3.13-slim

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl ffmpeg unzip \
    && rm -rf /var/lib/apt/lists/*

COPY . /app

RUN mkdir -p /app/tools /app/downloads \
    && curl -L --fail --retry 3 https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux -o /app/tools/yt-dlp \
    && chmod +x /app/tools/yt-dlp \
    && curl -L --fail --retry 3 https://github.com/denoland/deno/releases/latest/download/deno-x86_64-unknown-linux-gnu.zip -o /tmp/deno.zip \
    && unzip /tmp/deno.zip -d /app/tools \
    && chmod +x /app/tools/deno \
    && rm /tmp/deno.zip \
    && useradd --create-home --uid 10001 oto \
    && chown -R oto:oto /app

USER oto

ENV AUDIO_TOOL_HOST=0.0.0.0 \
    AUDIO_TOOL_DELETE_AFTER_DOWNLOAD=1 \
    PYTHONUNBUFFERED=1

EXPOSE 10000

CMD ["python", "app.py"]
