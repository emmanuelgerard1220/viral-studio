FROM node:20-slim

# Install FFmpeg and fonts (fonts needed for drawtext captions)
RUN apt-get update && \
    apt-get install -y ffmpeg fonts-dejavu && \
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
