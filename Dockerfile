FROM node:20-slim

# Install FFmpeg 7.x from Debian backports (Bookworm's default 5.1 has a fatal
# AAC encoder bug where partial lookahead frames cause exit code 1 on close).
# fonts-dejavu comes from main and must be installed before adding backports.
RUN apt-get update && \
    apt-get install -y --no-install-recommends fonts-dejavu && \
    echo "deb http://deb.debian.org/debian bookworm-backports main" \
        > /etc/apt/sources.list.d/backports.list && \
    apt-get update && \
    apt-get install -y -t bookworm-backports --no-install-recommends ffmpeg && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json .
RUN npm install --production

COPY . .

# Create required directories
RUN mkdir -p uploads outputs

EXPOSE 3000

CMD ["node", "server.js"]
