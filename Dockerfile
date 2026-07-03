FROM python:3.13-slim

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl ffmpeg unzip git \
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# yt-dlp本体（プラグインが使えるpip版）と、YouTubeのボット検証へ応答するPO Tokenプラグイン
RUN pip install --no-cache-dir 'yt-dlp[default]' bgutil-ytdlp-pot-provider==1.3.1

# PO Tokenを生成するローカルサーバー（プラグインが 127.0.0.1:4416 を自動検出する）
RUN git clone --depth 1 --branch 1.3.1 https://github.com/Brainicism/bgutil-ytdlp-pot-provider.git /app/bgutil \
    && cd /app/bgutil/server \
    && npm ci \
    && npx tsc \
    && npm cache clean --force

COPY . /app

RUN mkdir -p /app/tools /app/downloads \
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
