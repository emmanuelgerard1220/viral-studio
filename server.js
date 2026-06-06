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
CAPTION_1: 0|This is the hook text|top
CAPTION_2: 3|Key point here|bottom
CAPTION_3: 8|Call to action|bottom

Rules for Edit Structure:
- START and END are seconds from the original video (integers)
- Total duration must be ≤ ${guide.maxSec} seconds
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

      // Font file — fonts-dejavu is installed in the Dockerfile
      const fontFile = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';

      // Add caption drawtext filters
      captions.forEach(cap => {
        const endOffset = cap.offset + 3; // show each caption for 3 seconds
        const yPos = cap.position === 'top' ? '160' : 'h-220';
        // Escape for FFmpeg drawtext: backslash, colon, single quote, percent
        const safeText = cap.text
          .replace(/\\/g, '\\\\')
          .replace(/'/g, '')
          .replace(/:/g, '\\:')
          .replace(/%/g, '\\%');

        filterParts.push(
          `drawtext=fontfile='${fontFile}':text='${safeText}':fontsize=58:fontcolor=white:borderw=4:bordercolor=black:x=(w-text_w)/2:y=${yPos}:enable='between(t\\,${cap.offset}\\,${endOffset})'`
        );
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
