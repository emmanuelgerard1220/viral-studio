# Viral Studio

AI-powered video editor that generates platform-specific viral strategies and exports cropped, trimmed, captioned videos for YouTube Shorts, TikTok, and Instagram Reels.

## What it does

1. Upload any video
2. Describe your content — Claude generates tailored strategies for all 3 platforms
3. Click "Export" — FFmpeg on the server crops to 9:16, trims to platform length, burns in captions
4. Download 3 ready-to-upload videos

---

## Deploy to Railway (5 minutes)

Railway is the easiest way to host this. ~$5/month.

### Step 1 — Push to GitHub

```bash
git init
git add .
git commit -m "initial"
gh repo create viral-studio --public --push
# or push to an existing repo
```

### Step 2 — Deploy on Railway

1. Go to [railway.app](https://railway.app) and sign in with GitHub
2. Click **New Project → Deploy from GitHub repo**
3. Select your `viral-studio` repo
4. Railway auto-detects the Dockerfile and builds it
5. Click **Generate Domain** under Settings → Networking to get a public URL

That's it. Railway handles FFmpeg (it's in the Dockerfile), ports, and restarts.

### Step 3 — Share the URL

Send the Railway URL to anyone. They open it in Chrome, paste their own Anthropic API key, and use the full app.

---

## Run locally

```bash
npm install
node server.js
# open http://localhost:3000
```

Requires FFmpeg installed locally:
- Mac: `brew install ffmpeg`
- Ubuntu: `apt-get install ffmpeg`
- Windows: download from ffmpeg.org and add to PATH

---

## How the editing works

Claude generates a strategy that includes machine-readable edit instructions:

```
START: 45        ← cut starts at 45s in the original
END: 89          ← cut ends at 89s (44s clip, fits in 59s Shorts limit)
CAPTION_1: 0|This is the hook|top
CAPTION_2: 4|Key technique here|bottom
CAPTION_3: 10|Try this at home|bottom
```

The server parses these, runs FFmpeg with:
- `-ss` seek to START
- `-t` duration
- `scale + crop` filter for 9:16
- `drawtext` filter for each caption

Output is a proper H.264/AAC MP4.

---

## Environment variables

| Variable | Description |
|---|---|
| `PORT` | Server port (default 3000, Railway sets automatically) |
| `ANTHROPIC_API_KEY` | Optional — if set, users don't need to enter their own key |

To set a shared API key on Railway: go to your service → Variables → add `ANTHROPIC_API_KEY`.
