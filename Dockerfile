FROM denoland/deno:2.1.9

# Install ffmpeg, python3, and latest yt-dlp
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    python3 \
    curl \
    ca-certificates \
    && curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY . .

# Ensure downloads directory exists
RUN mkdir -p downloads/thumbnails

EXPOSE 5050
ENV PORT=5050

CMD ["run", "-A", "server.ts"]
