# Viral Studio — Project Context

## What this is
An AI-powered video tool. A user uploads one video and gets three platform-optimized
versions: a YouTube Short, a TikTok, and an Instagram Reel. Each version is cropped to
9:16, trimmed to platform length, and has captions burned in.

## Architecture
- **Backend:** Node.js + Express (`server.js`)
- **Frontend:** single static page (`public/index.html`), vanilla JS, no framework
- **Video processing:** FFmpeg via `fluent-ffmpeg`, runs server-side
- **AI strategy:** Anthropic SDK (`@anthropic-ai/sdk`), model `claude-sonnet-4-6`
- **Deploy target:** Railway, using the `Dockerfile` (auto-rebuilds on git push)

## How it works end to end
1. Frontend collects: video file + description, niche, audience, duration, tone, and the
   user's own Anthropic API key.
2. `POST /api/strategy` — sends details to Claude for all 3 platforms in parallel. Claude
   returns a strategy that INCLUDES machine-readable edit instructions (see below).
3. `POST /api/process` — uploads the video + chosen platform's strategy. Server parses the
   edit instructions, runs FFmpeg, returns a download URL.

## The edit-instruction format (important)
Claude is prompted to emit these lines at the top of each strategy. `server.js` parses them
with regex. If you change the format in the prompt, update the parser too, and vice versa.
```
START: 45                       <- cut start, seconds (integer)
END: 89                         <- cut end, seconds (integer)
CAPTION_1: 0|Hook text here|top <- OFFSET_SECONDS|TEXT|POSITION(top|bottom)
CAPTION_2: 4|Next caption|bottom
```
- Total duration is clamped to each platform's max: YT/TikTok 59s, Instagram 29s.
- These lines are stripped from the strategy text before it's shown to the user
  (see `renderCardBody` in index.html).

## FFmpeg pipeline (in server.js /api/process)
- Crop to 9:16: `scale=720:1280:force_original_aspect_ratio=increase`, then `crop=720:1280`.
  Output is 720x1280 (NOT 1080x1920) to stay within Railway memory limits.
- Captions: one `drawtext` filter per wrapped line. Font is DejaVuSans-Bold.
- Encoding: `libx264`, `-preset ultrafast`, `-crf 26`, `-threads 1`. These low settings
  are deliberate — see Gotchas.

## Known gotchas (learned the hard way)
1. **Memory / SIGKILL.** FFmpeg gets OOM-killed on small Railway instances. Mitigations
   already in place: 720p output, ultrafast preset, single thread. If it still dies,
   bump the Railway instance memory (Settings > Resources).
2. **Fonts.** `drawtext` needs a real font file. The Dockerfile installs `fonts-dejavu`
   and the code points at `/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf`.
   Without the font install, FFmpeg exits code 1 "Conversion failed".
3. **Caption overflow.** `drawtext` does NOT wrap text. We wrap manually with
   `wrapText()` at `MAX_CHARS_PER_LINE` (currently 16). Lower it if text spills off the
   720px-wide frame; raise it if wrapping looks too choppy.
4. **drawtext escaping.** Colons, percents, backslashes, and the commas inside
   `enable='between(t,X,Y)'` all need escaping. See `escapeDrawtext()`.
5. **Anthropic package name.** It's `@anthropic-ai/sdk`, NOT `anthropic` (a different,
   abandoned package). This bit us during the first Railway build.

## Deploy flow
- Push to GitHub `main` -> Railway auto-rebuilds from the Dockerfile -> live.
- Public URL is set under Railway > service > Settings > Networking > Generate Domain.
- Optional: set `ANTHROPIC_API_KEY` as a Railway env var so users don't need their own key.

## Local dev
```
npm install
node server.js        # http://localhost:3000
```
Requires FFmpeg installed locally (Windows: download from ffmpeg.org and add to PATH).

## Things to be careful about
- Server-side encoding costs real CPU/RAM per request. If usage grows, add a job queue
  and/or per-user limits before sharing widely.
- Uploaded files land in `uploads/` and outputs in `outputs/`; outputs auto-delete after
  10 minutes. Both dirs are gitignored.
