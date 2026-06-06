const express = require('express');
const multer = require('multer');
const ffmpeg = require('fluent-ffmpeg');
const Anthropic = require('@anthropic-ai/sdk');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Serve output files for download
app.use('/outputs', express.static(path.join(__dirname, 'outputs')));

// Multer — store uploads with original extension
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'uploads/'),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.mp4';
    cb(null, uuidv4() + ext);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 500 * 1024 * 1024 }, // 500MB
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('video/')) cb(null, true);
    else cb(new Error('Only video files allowed'));
  }
});

// ── Strategy generation ──────────────────────────────────────
app.post('/api/strategy', async (req, res) => {
  const { description, niche, audience, duration, tone, apiKey } = req.body;
  if (!description) return res.status(400).json({ error: 'Description required' });

  const key = apiKey || process.env.ANTHROPIC_API_KEY;
  if (!key) return res.status(400).json({ error: 'Anthropic API key required' });

  const anthropic = new Anthropic({ apiKey: key });

  const platformGuides = {
    youtube: {
      format: 'YouTube Shorts (vertical short-form ONLY, NOT long-form)',
      algo: 'YouTube Shorts rewards loop completion rate, likes-to-views ratio, shares. First frame IS the thumbnail. Under 60s hard limit. Videos loop automatically.',
      specs: 'VERTICAL 9:16, 1080×1920px, under 60 seconds. Title under 100 chars.',
      maxSec: 59
    },
    tiktok: {
      format: 'TikTok For You Page',
      algo: 'TikTok prioritizes completion rate, replays, shares, saves. First 3 seconds critical. On-screen captions boost completion significantly.',
      specs: 'Vertical 9:16, 1080×1920px. 15–59 seconds optimal. Trending audio essential.',
      maxSec: 59
    },
    instagram: {
      format: 'Instagram Reels',
      algo: 'Instagram rewards saves, shares to Stories, profile visits, watch time. Aesthetic quality matters most. 15–29 second Reels get highest distribution.',
      specs: 'Vertical 9:16, 1080×1920px. 15–29 seconds optimal.',
      maxSec: 29
    }
  };

  try {
    const strategies = {};

    await Promise.all(Object.entries(platformGuides).map(async ([platform, guide]) => {
      const prompt = `You are an elite social media strategist who has grown multiple accounts to millions of followers.

Video details:
- Description: ${description}
- Niche/Topic: ${niche || 'General'}
- Target Audience: ${audience || 'General adult audience'}
- Original Duration: ${duration || 'Unknown'}
- Tone/Vibe: ${tone || 'Not specified'}

Create a complete viral edit strategy for **${guide.format}**.
Algorithm: ${guide.algo}
Specs: ${guide.specs}

IMPORTANT: The video processing system will read your "Edit Structure" section to make actual cuts.
Format the Edit Structure section EXACTLY like this example (timestamps must be in seconds as numbers):
START: 45
END: 89
ZOOM: slow_in
COLOR: vibrant
CAPTION_1: 0|This is the hook text|top
CAPTION_2: 3|Key point here|bottom
CAPTION_3: 8|Call to action|bottom

Rules for Edit Structure:
- START and END are seconds from the original video (integers)
- Total duration must be ≤ ${guide.maxSec} seconds
- ZOOM options: slow_in (gradual push-in, energetic), slow_out (pull back, dramatic reveal), none
- COLOR options: vibrant (punchy/saturated — TikTok default), warm (golden tones — Instagram default), moody (dark contrasty), cool (blue-toned), cinematic (desaturated film look), natural (no grade)
- Choose ZOOM and COLOR that match the platform aesthetic and content vibe
- CAPTION lines: format is OFFSET_SECONDS|TEXT|POSITION(top or bottom)
- Include 3-6 captions max
- Keep caption text under 8 words each

Then provide the rest of the strategy using ### headers:

### Hook (First 3 Seconds)
Exactly what to show/say in the first 3 seconds.

### Audio Strategy
Music genre/tempo and 2-3 trending sound suggestions.

### Caption & Hashtags
Exact first-line caption hook, full caption, 10-15 hashtags.

### Viral Triggers
3 psychological triggers and HOW they're implemented.`;

      const msg = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 1024,
        messages: [{ role: 'user', content: prompt }]
      });

      strategies[platform] = msg.content[0].text;
    }));

    res.json({ strategies });
  } catch (err) {
    console.error('Strategy error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Video processing ─────────────────────────────────────────
app.post('/api/process', upload.single('video'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No video uploaded' });

  const { platform, strategy } = req.body;
  if (!platform || !strategy) return res.status(400).json({ error: 'platform and strategy required' });

  const platformSpecs = {
    youtube:   { maxDuration: 59, suffix: 'youtube_short' },
    tiktok:    { maxDuration: 59, suffix: 'tiktok' },
    instagram: { maxDuration: 29, suffix: 'instagram_reel' }
  };

  const spec = platformSpecs[platform];
  if (!spec) return res.status(400).json({ error: 'Unknown platform' });

  const inputPath  = req.file.path;
  const outputName = `${uuidv4()}_${spec.suffix}.mp4`;
  const outputPath = path.join(__dirname, 'outputs', outputName);

  // Parse edit instructions from strategy
  let startTime = 0;
  let endTime   = spec.maxDuration;
  const captions = [];

  const startMatch = strategy.match(/^START:\s*(\d+)/m);
  const endMatch   = strategy.match(/^END:\s*(\d+)/m);
  if (startMatch) startTime = parseInt(startMatch[1]);
  if (endMatch)   endTime   = parseInt(endMatch[1]);

  // Clamp duration to platform max
  const duration = Math.min(endTime - startTime, spec.maxDuration);

  // Parse zoom and color grade
  const zoomMatch  = strategy.match(/^ZOOM:\s*(\w+)/m);
  const colorMatch = strategy.match(/^COLOR:\s*(\w+)/m);
  const zoomType   = zoomMatch  ? zoomMatch[1].toLowerCase()  : 'none';
  const colorStyle = colorMatch ? colorMatch[1].toLowerCase() : 'natural';

  // Parse captions: CAPTION_N: offset|text|position
  const captionRegex = /^CAPTION_\d+:\s*(\d+)\|(.+?)\|(top|bottom)/gm;
  let captionMatch;
  while ((captionMatch = captionRegex.exec(strategy)) !== null) {
    captions.push({
      offset:   parseInt(captionMatch[1]),
      text:     captionMatch[2].trim(),
      position: captionMatch[3]
    });
  }

  console.log(`Processing ${platform}: start=${startTime} duration=${duration} captions=${captions.length}`);

  try {
    await new Promise((resolve, reject) => {
      // Build complex filtergraph
      // 1. Scale + crop to 9:16
      // 2. Build filtergraph
      const filterParts = [];

      // Crop to 9:16 center, then scale to 1080x1920.
      // crop=ih*9/16:ih  picks a 9:16-wide column when source is wider;
      // force_original_aspect_ratio handles both orientations cleanly via scale+crop.
      filterParts.push(
        `scale=720:1280:force_original_aspect_ratio=increase`,
        `crop=720:1280`
      );

      // Zoom effect — zoompan operates on the already-scaled 720x1280 frame
      if (zoomType === 'slow_in') {
        filterParts.push(
          `zoompan=z='min(1+0.2*t/${duration},1.2)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=720x1280:fps=30`
        );
      } else if (zoomType === 'slow_out') {
        filterParts.push(
          `zoompan=z='max(1.2-0.2*t/${duration},1)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=720x1280:fps=30`
        );
      }

      // Color grade
      const COLOR_GRADES = {
        vibrant:   ['eq=saturation=1.4:contrast=1.15:brightness=0.03'],
        warm:      ['eq=saturation=1.2:contrast=1.1', 'colorbalance=rs=0.08:gs=0.02:bs=-0.08'],
        moody:     ['eq=saturation=0.8:contrast=1.25:brightness=-0.05'],
        cool:      ['eq=saturation=1.1:contrast=1.1', 'colorbalance=rs=-0.08:gs=0.02:bs=0.12'],
        cinematic: ['eq=saturation=0.85:contrast=1.3:brightness=-0.03', 'colorbalance=rs=0.05:gs=0:bs=-0.08'],
      };
      if (COLOR_GRADES[colorStyle]) filterParts.push(...COLOR_GRADES[colorStyle]);

      // Font file — fonts-dejavu is installed in the Dockerfile
      const fontFile = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';
      const fontSize = 52;
      const lineHeight = 68; // px between stacked lines

      // Wrap a caption into lines of at most maxChars characters (word-aware)
      function wrapText(text, maxChars) {
        const words = text.split(/\s+/);
        const lines = [];
        let current = '';
        for (const word of words) {
          if ((current + ' ' + word).trim().length <= maxChars) {
            current = (current + ' ' + word).trim();
          } else {
            if (current) lines.push(current);
            current = word;
          }
        }
        if (current) lines.push(current);
        return lines;
      }

      function escapeDrawtext(s) {
        return s
          .replace(/\\/g, '\\\\')
          .replace(/'/g, '')
          .replace(/:/g, '\\:')
          .replace(/%/g, '\\%');
      }

      // At 720px wide with fontsize 52, ~16 chars fit per line comfortably
      const MAX_CHARS_PER_LINE = 16;

      // Add caption drawtext filters (one per wrapped line)
      captions.forEach(cap => {
        const endOffset = cap.offset + 3; // show each caption for 3 seconds
        const lines = wrapText(cap.text, MAX_CHARS_PER_LINE);
        const blockHeight = lines.length * lineHeight;

        lines.forEach((line, idx) => {
          const safeText = escapeDrawtext(line);
          // Compute y for each line so the block is anchored at top or bottom
          let yExpr;
          if (cap.position === 'top') {
            yExpr = `${160 + idx * lineHeight}`;
          } else {
            // bottom: anchor whole block above the lower edge
            yExpr = `h-${blockHeight + 160 - idx * lineHeight}`;
          }
          filterParts.push(
            `drawtext=fontfile='${fontFile}':text='${safeText}':fontsize=${fontSize}:fontcolor=white:borderw=4:bordercolor=black:x=(w-text_w)/2:y=${yExpr}:enable='between(t\\,${cap.offset}\\,${endOffset})'`
          );
        });
      });

      const vf = filterParts.join(',');

      let ffmpegLog = '';
      ffmpeg(inputPath)
        .setStartTime(startTime)
        .setDuration(duration)
        .videoFilter(vf)
        .audioCodec('aac')
        .audioBitrate('128k')
        .videoCodec('libx264')
        .outputOptions([
          '-preset ultrafast',
          '-crf 26',
          '-threads 1',
          '-max_muxing_queue_size 1024',
          '-movflags +faststart'
        ])
        .output(outputPath)
        .on('start', cmd => console.log('FFmpeg:', cmd))
        .on('stderr', line => { ffmpegLog += line + '\n'; })
        .on('progress', p => console.log(`Progress: ${Math.round(p.percent || 0)}%`))
        .on('end', resolve)
        .on('error', (err) => {
          console.error('FFmpeg stderr:\n', ffmpegLog);
          reject(new Error(err.message + ' | ' + ffmpegLog.split('\n').filter(Boolean).slice(-3).join(' ')));
        })
        .run();
    });

    // Clean up upload
    fs.unlink(inputPath, () => {});

    // Schedule output cleanup after 10 minutes
    setTimeout(() => fs.unlink(outputPath, () => {}), 10 * 60 * 1000);

    res.json({ url: `/outputs/${outputName}`, filename: `viral_${spec.suffix}.mp4` });

  } catch (err) {
    console.error('FFmpeg error:', err);
    fs.unlink(inputPath, () => {});
    res.status(500).json({ error: 'Video processing failed: ' + err.message });
  }
});

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => console.log(`Viral Studio running on port ${PORT}`));
