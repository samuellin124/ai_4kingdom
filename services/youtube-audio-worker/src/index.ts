/**
 * YouTube Audio Worker - runs on Fly.io
 *
 * Strategy 1: youtube_transcript_api (Python) - fast, no bot detection
 * Strategy 2: yt-dlp audio download + ffmpeg + Whisper + GPT
 */
import express from 'express';
import { exec } from 'child_process';
import { promisify } from 'util';
import {
  mkdir, readdir, readFile, writeFile, rm,
} from 'fs/promises';
import { existsSync, statSync, chmodSync } from 'fs';
import { join } from 'path';
import os from 'os';
import { randomUUID } from 'crypto';
import OpenAI from 'openai';
import { ProxyAgent, fetch as undiciFetch } from 'undici';

const app = express();
app.use(express.json());

// CORS: allow cross-origin requests from any Amplify / custom domain
app.use((req: express.Request, res: express.Response, next: express.NextFunction) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'content-type, x-worker-secret, x-filename, authorization',
  );
  // Preflight: browsers send OPTIONS before the real POST — respond immediately
  // without going through authMiddleware (which would reject it as Unauthorized)
  if (req.method === 'OPTIONS') {
    res.sendStatus(204);
    return;
  }
  next();
});

const execAsync = promisify(exec);
const PORT = parseInt(process.env.PORT || '8080', 10);

// Auth
const SHARED_SECRET = process.env.WORKER_SECRET || '';
const PUBLIC_ALLOWED_ORIGINS = (process.env.PUBLIC_ALLOWED_ORIGINS || '*.amplifyapp.com,ai4kingdom.org,www.ai4kingdom.org,localhost,127.0.0.1')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

function isOriginAllowed(originRaw?: string): boolean {
  if (!originRaw) return false;
  try {
    const host = new URL(originRaw).hostname.toLowerCase();
    return PUBLIC_ALLOWED_ORIGINS.some((rule) => {
      if (rule === host) return true;
      if (rule.startsWith('*.')) {
        const suffix = rule.slice(1); // keep leading dot
        return host.endsWith(suffix);
      }
      return false;
    });
  } catch {
    return false;
  }
}

function authMiddleware(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
): void {
  if (!SHARED_SECRET) { next(); return; }
  const token = req.headers['x-worker-secret'] as string | undefined;
  if (token === SHARED_SECRET) {
    next();
    return;
  }

  // Browser direct fallback: allow trusted origins without exposing worker secret.
  const origin = req.headers.origin as string | undefined;
  if (isOriginAllowed(origin)) {
    next();
    return;
  }

  if (token !== SHARED_SECRET) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
}

// Lazy OpenAI client — routes through HTTP proxy when OPENAI_HTTP_PROXY is set,
// bypassing Fly.io → OpenAI direct connection issues.
let _openai: OpenAI | null = null;
function getOpenAI(): OpenAI {
  if (!_openai) {
    if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY not set');
    const httpProxy = process.env.OPENAI_HTTP_PROXY;
    if (httpProxy) {
      const dispatcher = new ProxyAgent(httpProxy);
      _openai = new OpenAI({
        apiKey: process.env.OPENAI_API_KEY,
        fetch: (url, init) => {
          const undiciInit: any = { ...(init as any), dispatcher };
          if (undiciInit.body && !undiciInit.duplex) {
            undiciInit.duplex = 'half';
          }
          return undiciFetch(url as string, undiciInit) as any;
        },
      });
      console.log('[worker] OpenAI client using HTTP proxy');
    } else {
      _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, fetch: globalThis.fetch });
    }
  }
  return _openai;
}

// Constants
const WHISPER_MAX_BYTES = 24 * 1024 * 1024;
const WHISPER_MAX_DURATION_SEC = 600; // 10 min per chunk — smaller = faster upload = less ECONNRESET
const CHUNK_DURATION_SEC = 10 * 60;
const MAX_VIDEO_DURATION_SEC = 180 * 60;
// Parallel Whisper uploads per batch. Override with the WHISPER_CONCURRENCY env var:
// drop to 2, or 1 (fully sequential, the old behaviour) if ECONNRESET reappears.
const WHISPER_CONCURRENCY = Math.max(1, Number(process.env.WHISPER_CONCURRENCY) || 3);
const COOKIES_PATH = join(os.tmpdir(), 'yt-cookies.txt');

// Write YouTube cookies from env var (base64 encoded to avoid multiline issues)
async function initCookies(): Promise<void> {
  const b64 = process.env.YOUTUBE_COOKIES_B64;
  const raw = process.env.YOUTUBE_COOKIES;
  if (!b64 && !raw) { console.log('[worker] No YOUTUBE_COOKIES set, yt-dlp will run without cookies'); return; }
  const content = b64 ? Buffer.from(b64, 'base64').toString('utf8') : raw!;
  await writeFile(COOKIES_PATH, content, 'utf8');
  console.log(`[worker] Wrote YouTube cookies to ${COOKIES_PATH} (${content.length} chars)`);
}

function cookiesArg(): string {
  return existsSync(COOKIES_PATH) ? `--cookies "${COOKIES_PATH}"` : '';
}

// Proxy support: set YTDLP_PROXY env var, e.g. "socks5://user:pass@host:port" or "http://user:pass@host:port"
// Webshare.io residential proxy: https://proxy.webshare.io/ (~$3/month)
function proxyArg(): string {
  const p = process.env.YTDLP_PROXY;
  return p ? `--proxy "${p}"` : '';
}

// Python script for youtube_transcript_api (bypasses bot detection via timedtext API)
// Compatible with youtube-transcript-api v1.x+ (new API) and falls back for older versions
// Strategy: fetch both the preferred-language track AND the default track, use whichever is longer.
const TRANSCRIPT_SCRIPT = `
import sys

video_id = sys.argv[1]
langs = sys.argv[2:] or ['zh-TW','zh-Hant','zh-Hans','zh','en']

def fetch_snippets(data):
    snippets = []
    for item in data:
        text = getattr(item, 'text', None) or (item.get('text') if isinstance(item, dict) else str(item))
        if text:
            snippets.append(text)
    return snippets

try:
    from youtube_transcript_api import YouTubeTranscriptApi

    # v1.x+ API: instance-based
    ytt = YouTubeTranscriptApi()

    best_snippets = []

    # Try preferred languages first
    try:
        data = ytt.fetch(video_id, languages=langs)
        best_snippets = fetch_snippets(data)
    except Exception:
        pass

    # Always also try default track (no language filter) and keep the longer result.
    # Some videos have a partial zh track + complete auto-generated default track.
    try:
        default_data = ytt.fetch(video_id)
        default_snippets = fetch_snippets(default_data)
        # If default track has >20% more segments, it is more complete — prefer it.
        if len(default_snippets) > len(best_snippets) * 1.2:
            best_snippets = default_snippets
    except Exception:
        pass

    if not best_snippets:
        print("NO_TRANSCRIPT", file=sys.stderr); sys.exit(1)
    print(' '.join(best_snippets))

except Exception as e:
    print(f"ERROR: {e}", file=sys.stderr); sys.exit(1)
`;

// Path to the Python transcript script (written to disk at startup to avoid shell escaping issues)
const TRANSCRIPT_SCRIPT_PATH = join(os.tmpdir(), 'yt_transcript.py');

async function ensureTranscriptScript(): Promise<void> {
  try {
    await writeFile(TRANSCRIPT_SCRIPT_PATH, TRANSCRIPT_SCRIPT, 'utf8');
    console.log('[worker] Transcript script written to', TRANSCRIPT_SCRIPT_PATH);
  } catch (e) {
    console.error('[worker] Failed to write transcript script:', e);
  }
}

async function getYouTubeTranscript(videoId: string): Promise<string | null> {
  try {
    const cmd = `python3 "${TRANSCRIPT_SCRIPT_PATH}" ${videoId} zh-TW zh-Hant zh-Hans zh en`;
    const { stdout, stderr } = await execAsync(cmd, { timeout: 30_000, maxBuffer: 10 * 1024 * 1024 });
    if (stderr && !stdout.trim()) {
      console.log(`[worker] Transcript fetch stderr: ${stderr.slice(0, 200)}`);
      return null;
    }
    const text = stdout.trim();
    if (!text) return null;
    console.log(`[worker] Transcript fetched: ${text.length} chars`);
    return text;
  } catch (err: any) {
    const msg = err?.stderr || err?.message || '';
    console.log(`[worker] youtube_transcript_api: ${msg.slice(0, 200)}`);
    return null;
  }
}

// yt-dlp binary management
let ytDlpBin: string | null = null;
const YTDLP_MAX_AGE_DAYS = 60; // force re-download if binary is older than this

/**
 * Parse yt-dlp version string (YYYY.MM.DD) and return age in days.
 * Returns Infinity if the version cannot be parsed.
 */
function ytDlpVersionAgeDays(version: string): number {
  const m = version.trim().match(/^(\d{4})\.(\d{2})\.(\d{2})/);
  if (!m) return Infinity;
  const built = new Date(parseInt(m[1]), parseInt(m[2]) - 1, parseInt(m[3]));
  return (Date.now() - built.getTime()) / 86_400_000;
}

/**
 * Download the latest yt-dlp standalone binary from GitHub releases to /tmp.
 * Returns the path to the downloaded binary.
 */
async function downloadLatestYtDlp(): Promise<string> {
  const binDir = join(os.tmpdir(), 'yt-dlp-bin');
  const assetName = process.arch === 'arm64' ? 'yt-dlp_linux_aarch64' : 'yt-dlp_linux';
  const binaryPath = join(binDir, assetName);
  await mkdir(binDir, { recursive: true });
  const url = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${assetName}`;
  console.log(`[worker] Downloading latest yt-dlp from GitHub (${assetName})...`);
  const resp = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(120_000) });
  if (!resp.ok) throw new Error(`Download yt-dlp failed: HTTP ${resp.status}`);
  const buf = await resp.arrayBuffer();
  await writeFile(binaryPath, Buffer.from(buf));
  chmodSync(binaryPath, 0o755);
  const { stdout: ver } = await execAsync(`"${binaryPath}" --version`, { timeout: 5000 });
  console.log(`[worker] yt-dlp downloaded: ${ver.trim()}`);
  return binaryPath;
}

async function ensureYtDlp(): Promise<string> {
  if (ytDlpBin) return ytDlpBin;

  // 1. Try system yt-dlp (installed in Dockerfile) — but only if it is fresh enough.
  try {
    const { stdout } = await execAsync('yt-dlp --version', { timeout: 5000 });
    const version = stdout.trim();
    const ageDays = ytDlpVersionAgeDays(version);
    console.log(`[worker] system yt-dlp: ${version} (${Math.round(ageDays)} days old)`);

    if (ageDays <= YTDLP_MAX_AGE_DAYS) {
      ytDlpBin = 'yt-dlp';
      return ytDlpBin;
    }

    // Version is too old — fall through to download a fresh binary.
    console.log(`[worker] system yt-dlp is ${Math.round(ageDays)} days old (>${YTDLP_MAX_AGE_DAYS}), downloading latest...`);
  } catch { /* not in PATH */ }

  // 2. Check cached /tmp binary — reuse only if still fresh.
  const binDir = join(os.tmpdir(), 'yt-dlp-bin');
  const assetName = process.arch === 'arm64' ? 'yt-dlp_linux_aarch64' : 'yt-dlp_linux';
  const cachedPath = join(binDir, assetName);
  if (existsSync(cachedPath)) {
    try {
      const { stdout: cachedVer } = await execAsync(`"${cachedPath}" --version`, { timeout: 5000 });
      const ageDays = ytDlpVersionAgeDays(cachedVer.trim());
      console.log(`[worker] cached yt-dlp: ${cachedVer.trim()} (${Math.round(ageDays)} days old)`);
      if (ageDays <= YTDLP_MAX_AGE_DAYS) {
        ytDlpBin = cachedPath;
        return ytDlpBin;
      }
      console.log(`[worker] cached yt-dlp is stale, re-downloading...`);
    } catch { /* corrupt binary — re-download */ }
  }

  // 3. Download latest binary from GitHub.
  ytDlpBin = await downloadLatestYtDlp();
  return ytDlpBin;
}

// ffmpeg detection
async function ensureFfmpeg(): Promise<string> {
  const candidates = ['ffmpeg', '/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg'];
  for (const bin of candidates) {
    try {
      const { stdout } = await execAsync(`${bin} -version`, { timeout: 10000 });
      console.log(`[worker] ffmpeg found: ${bin}`, (stdout || '').split('\n')[0]);
      return bin;
    } catch (err: any) {
      console.log(`[worker] ffmpeg check failed for "${bin}":`, err?.message?.slice(0, 200) || 'unknown error');
    }
  }
  try {
    const { stdout } = await execAsync('which ffmpeg', { timeout: 5000 });
    const found = stdout.trim();
    if (found) {
      console.log(`[worker] ffmpeg found via which: ${found}`);
      return found;
    }
  } catch (err: any) {
    console.log('[worker] which ffmpeg failed:', err?.message?.slice(0, 200));
  }
  throw new Error('ffmpeg not available on this host (all candidates failed)');
}

// Audio utilities
async function getAudioDuration(ffmpeg: string, filePath: string): Promise<number> {
  try {
    const result = await execAsync(`"${ffmpeg}" -i "${filePath}"`, { timeout: 15000 })
      .catch((e: any) => ({ stdout: '', stderr: e.stderr || e.message || '' }));
    const output = ((result as any).stdout || '') + ((result as any).stderr || '');
    const m = output.match(/Duration:\s*(\d+):(\d+):(\d+)/);
    if (m) return parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseInt(m[3]);
  } catch { /* ignore */ }
  return 0;
}

async function splitAudio(
  ffmpeg: string, inputPath: string, outputDir: string, chunkSec: number,
): Promise<string[]> {
  // Re-encode to 16kHz mono mp3 — ensures clean splits at any boundary (not limited to keyframes).
  // -c copy on webm/opus silently drops audio at cluster boundaries, causing missing sections.
  const pattern = join(outputDir, `chunk_%03d.mp3`);
  // -vn: drop any video stream — muxed fallback downloads (best[height<=360]) carry
  // a video track that the mp3 segment muxer can't accept, which fails the whole command.
  const cmd = `"${ffmpeg}" -i "${inputPath}" -vn -f segment -segment_time ${chunkSec} -c:a libmp3lame -q:a 5 -ar 16000 -ac 1 -reset_timestamps 1 "${pattern}"`;
  await execAsync(cmd, { timeout: 180_000, maxBuffer: 50 * 1024 * 1024 });
  const files = await readdir(outputDir);
  return files.filter((f) => /^chunk_\d+\.mp3$/.test(f)).sort().map((f) => join(outputDir, f));
}

function isTransientWhisperError(err: any): boolean {
  return err?.code === 'ECONNRESET'
    || err?.cause?.code === 'ECONNRESET'
    || err?.message?.includes('Connection error')
    || err?.message?.includes('ECONNRESET')
    || err?.status === 429
    || (err?.status !== undefined && err.status >= 500);
}

async function callWhisper(
  buf: Buffer, ext: string, mimeType: string, model: 'gpt-4o-transcribe' | 'whisper-1',
): Promise<string> {
  const whisperFile = new File([buf], `audio.${ext}`, { type: mimeType });
  const result = await getOpenAI().audio.transcriptions.create(
    { file: whisperFile, model, response_format: 'text' },
    { timeout: 300_000 }, // 5-minute timeout per chunk
  );
  return typeof result === 'string' ? result : (result as any).text || String(result);
}

async function transcribeFile(filePath: string, ext: string): Promise<string> {
  const mimeMap: Record<string, string> = {
    m4a: 'audio/mp4', webm: 'audio/webm', mp3: 'audio/mpeg',
    ogg: 'audio/ogg', opus: 'audio/ogg', wav: 'audio/wav',
    mp4: 'video/mp4', aac: 'audio/aac',
  };
  const mimeType = mimeMap[ext] || 'audio/mp4';
  const buf = await readFile(filePath);

  // gpt-4o-transcribe as primary; fall back to whisper-1 after 3 retries.
  // Delays: 5s/15s/30s for gpt-4o retries, then 10s/20s for whisper-1 retries.
  // Total worst-case delay ~80s — fits within the 160s Amplify proxy window even for multi-chunk videos.
  const GPT_DELAYS = [5_000, 15_000, 30_000];
  const W1_DELAYS  = [10_000, 20_000];
  let lastErr: any;

  // gpt-4o-transcribe attempts
  for (let attempt = 0; attempt <= GPT_DELAYS.length; attempt++) {
    try {
      const text = await callWhisper(buf, ext, mimeType, 'gpt-4o-transcribe');
      if (attempt > 0) console.log(`[worker] Whisper succeeded on attempt ${attempt + 1} (gpt-4o-transcribe)`);
      return text;
    } catch (err: any) {
      lastErr = err;
      if (attempt < GPT_DELAYS.length && isTransientWhisperError(err)) {
        const delay = GPT_DELAYS[attempt];
        console.log(`[worker] Whisper attempt ${attempt + 1} failed (${err?.message?.slice(0, 60)}), retrying in ${delay / 1000}s...`);
        await new Promise((r) => setTimeout(r, delay));
      } else if (attempt < GPT_DELAYS.length) {
        throw err; // non-transient, fail fast
      }
    }
  }

  // whisper-1 fallback with its own retries
  console.log('[worker] gpt-4o-transcribe failed, falling back to whisper-1...');
  for (let attempt = 0; attempt <= W1_DELAYS.length; attempt++) {
    try {
      const text = await callWhisper(buf, ext, mimeType, 'whisper-1');
      if (attempt > 0) console.log(`[worker] whisper-1 succeeded on attempt ${attempt + 1}`);
      return text;
    } catch (err: any) {
      lastErr = err;
      if (attempt < W1_DELAYS.length && isTransientWhisperError(err)) {
        const delay = W1_DELAYS[attempt];
        console.log(`[worker] whisper-1 attempt ${attempt + 1} failed (${err?.message?.slice(0, 60)}), retrying in ${delay / 1000}s...`);
        await new Promise((r) => setTimeout(r, delay));
      } else if (attempt < W1_DELAYS.length) {
        throw err;
      }
    }
  }
  throw lastErr;
}

// Whisper transcription with bounded concurrency.
// Each batch runs in parallel; WHISPER_CONCURRENCY caps simultaneous uploads so we
// don't retrigger the ECONNRESET that unbounded parallelism caused. Lower it via the
// WHISPER_CONCURRENCY env var (2, or 1 for fully sequential) if ECONNRESET reappears.
async function transcribeChunksParallel(
  chunks: string[], defaultExt: string,
): Promise<string[]> {
  const parts: string[] = [];
  for (let i = 0; i < chunks.length; i += WHISPER_CONCURRENCY) {
    const batch = chunks.slice(i, i + WHISPER_CONCURRENCY)
      .filter((c) => statSync(c).size <= WHISPER_MAX_BYTES);
    if (!batch.length) continue;
    const from = i + 1;
    const to = Math.min(i + WHISPER_CONCURRENCY, chunks.length);
    console.log(`[worker] Transcribing chunks ${from}–${to}/${chunks.length} (${batch.length} in parallel)...`);
    const startedAt = Date.now();

    // Promise.all resolves in input order, so parts stay in chunk order.
    const texts = await Promise.all(
      batch.map((c) => transcribeFile(c, c.split('.').pop()?.toLowerCase() || defaultExt)),
    );

    console.log(`[worker] Chunks ${from}–${to} done in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
    for (const text of texts) {
      if (text.trim()) parts.push(text.trim());
    }
  }
  return parts;
}

// GPT formatting
// Chunk size stays well under the 16k max_completion_tokens cap: ~6000 Chinese chars reformats
// to roughly the same length, so a reply can never be truncated mid-transcript.
const FORMAT_CHUNK_CHARS = Math.max(1000, Number(process.env.FORMAT_CHUNK_CHARS) || 6000);
const FORMAT_CONCURRENCY = Math.max(1, Number(process.env.FORMAT_CONCURRENCY) || 4);

const FORMAT_SYSTEM_PROMPT = [
  'You are a transcript editor. Format the following speech transcript:',
  '1. Fix punctuation and sentence boundaries only',
  '2. Do NOT remove any words, phrases, or content — preserve everything',
  '3. Do NOT summarize, shorten, or paraphrase',
  '4. Preserve repeated phrases, prayers, and emphasis (e.g. "阿們", "讚美主")',
  '5. Preserve the original language exactly (Chinese stays Chinese, English stays English)',
  'Return only the reformatted transcript, no commentary.',
].join('\n');

// Formats one chunk, falling back to the raw chunk on failure or on a suspiciously
// short reply. A truncated or summarised reply would silently drop sermon content,
// which matters far more here than perfect punctuation.
async function formatChunk(chunk: string): Promise<string> {
  try {
    const completion = await getOpenAI().chat.completions.create({
      // gpt-5.6-terra is a reasoning model: no temperature, max_tokens -> max_completion_tokens.
      // Punctuation/segmentation is mechanical, so keep reasoning as low as this pinned SDK allows
      // ('none' would be ideal but needs openai >=6 — see package.json). The raised token cap leaves
      // headroom so reasoning tokens can't truncate the transcript (a short reply is dropped as raw).
      model: 'gpt-5.6-terra', reasoning_effort: 'low',
      messages: [
        { role: 'system', content: FORMAT_SYSTEM_PROMPT },
        { role: 'user', content: chunk },
      ],
      max_completion_tokens: 24576,
    });
    const formatted = completion.choices[0]?.message?.content?.trim();
    if (!formatted) return chunk;
    if (formatted.length < chunk.length * 0.6) {
      console.warn(`[worker] Formatted chunk suspiciously short (${formatted.length} vs ${chunk.length} chars), keeping raw`);
      return chunk;
    }
    return formatted;
  } catch (err) {
    console.warn('[worker] Formatting failed for one chunk, keeping raw:', (err as Error)?.message?.slice(0, 120));
    return chunk;
  }
}

async function formatTranscript(rawText: string): Promise<string> {
  if (!rawText || rawText.trim().length < 50) return rawText.trim();
  const chunks = splitText(rawText.trim(), FORMAT_CHUNK_CHARS);
  console.log(`[worker] Formatting ${chunks.length} chunk(s), ${FORMAT_CONCURRENCY} in parallel...`);
  const startedAt = Date.now();

  const parts: string[] = [];
  for (let i = 0; i < chunks.length; i += FORMAT_CONCURRENCY) {
    const batch = chunks.slice(i, i + FORMAT_CONCURRENCY);
    // Promise.all resolves in input order, so the transcript stays in order.
    // formatChunk never rejects, so one bad chunk can't discard the whole transcript.
    parts.push(...await Promise.all(batch.map(formatChunk)));
  }

  console.log(`[worker] Formatting done in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
  return parts.join('\n\n');
}

function splitText(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text];
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = start + maxChars;
    if (end >= text.length) { chunks.push(text.slice(start)); break; }
    const breakChars = ['\u3002', '\uff0c', '\uff01', '\uff1f', '\n', ' ', '\u3001'];
    let cutAt = end;
    for (const ch of breakChars) {
      const idx = text.lastIndexOf(ch, end);
      if (idx > start + maxChars * 0.5) { cutAt = idx + 1; break; }
    }
    chunks.push(text.slice(start, cutAt));
    start = cutAt;
  }
  return chunks;
}

function extractVideoId(url: string): string | null {
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/v\/|youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/,
    /^([a-zA-Z0-9_-]{11})$/,
  ];
  for (const p of patterns) {
    const m = url.match(p);
    if (m) return m[1];
  }
  return null;
}

// Main API endpoint
// ── 音頻檔案直接上傳轉錄端點（繞過 Amplify 10MB 限制）──────────────
// 前端直接 POST binary 到此端點，X-Filename header 傳檔名
// 支援最大 250MB，自動 ffmpeg 分片後逐片 Whisper 轉錄
app.post('/api/audio-transcribe',
  authMiddleware,
  express.raw({ type: '*/*', limit: '250mb' }),
  async (req: express.Request, res: express.Response) => {
    const rawFileName = (req.headers['x-filename'] as string) || 'audio.mp3';
    // Front-end encodes filename with encodeURIComponent to stay ISO-8859-1 safe
    let fileName = rawFileName;
    try { fileName = decodeURIComponent(rawFileName); } catch { /* already plain ASCII */ }
    const ext = (fileName.split('.').pop() || 'mp3').toLowerCase();
    const skipFormat = req.query.format === 'false';
    const tmpDir = join(os.tmpdir(), `audio-upload-${Date.now()}`);
    const chunkDir = join(tmpDir, 'chunks');
    try {
      await mkdir(tmpDir, { recursive: true });
      await mkdir(chunkDir, { recursive: true });
      const audioPath = join(tmpDir, `upload.${ext}`);
      await writeFile(audioPath, req.body as Buffer);
      const fileSizeBytes = statSync(audioPath).size;
      const fileSizeMB = fileSizeBytes / (1024 * 1024);
      console.log(`[worker] Audio upload: ${fileName} (${fileSizeMB.toFixed(1)}MB)`);
      let transcript = '';
      const ffmpegForDur = await ensureFfmpeg().catch(() => null);
      const durSec = ffmpegForDur ? await getAudioDuration(ffmpegForDur, audioPath) : 0;
      if (fileSizeBytes <= WHISPER_MAX_BYTES && durSec <= WHISPER_MAX_DURATION_SEC) {
        console.log('[worker] Transcribing directly...');
        transcript = await transcribeFile(audioPath, ext);
      } else {
        const ffmpeg = ffmpegForDur || await ensureFfmpeg();
        const chunks = await splitAudio(ffmpeg, audioPath, chunkDir, CHUNK_DURATION_SEC);
        console.log(`[worker] Split into ${chunks.length} chunks`);
        const parts = await transcribeChunksParallel(chunks, ext);
        transcript = parts.join(' ');
      }
      if (!transcript || !transcript.trim()) {
        res.status(422).json({ error: 'EMPTY_TRANSCRIPTION', message: '轉錄結果為空，請確認音頻包含語音內容。' });
        return;
      }
      console.log(`[worker] Whisper done: ${transcript.length} chars, formatting...`);
      const formatted = skipFormat ? transcript.trim() : await formatTranscript(transcript.trim());
      console.log(`[worker] Done: ${formatted.length} chars`);
      res.json({ transcript: formatted, source: 'whisper', fileName, charCount: formatted.length });
    } catch (error: any) {
      console.error('[worker] audio-transcribe error:', error);
      res.status(500).json({ error: 'TRANSCRIPTION_FAILED', message: error?.message || 'Unknown error' });
    } finally {
      try { if (existsSync(tmpDir)) await rm(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

// ── Async job store ──────────────────────────────────────────────────────────
// Callers behind AWS Amplify hit API Gateway's hard 29s request cap, so a long
// transcription can never finish synchronously. They POST /start, then poll /status.
// Jobs are held in memory: they are short-lived and fly.toml pins
// min_machines_running = 1. Running more than one machine would need a shared store
// (or sticky routing), otherwise a poll can land on a machine that lacks the job.
type JobState =
  | { status: 'running'; startedAt: number }
  | { status: 'done'; httpStatus: number; body: any; finishedAt: number };

const jobs = new Map<string, JobState>();
const JOB_TTL_MS = 60 * 60_000;          // keep finished results readable for an hour
const JOB_MAX_RUNTIME_MS = 30 * 60_000;  // safety net if a handler never settles

// A job lives on the machine that started it, so the id carries that machine:
//   <machine id>.<uuid>
// Any machine can then read the owner straight off an incoming poll and hand it to
// Fly's proxy. The id stays opaque to the client, so no frontend change is needed.
const MACHINE_ID = process.env.FLY_MACHINE_ID || 'local';

function newJobId(): string {
  return `${MACHINE_ID}.${randomUUID()}`;
}

function jobOwner(jobId: string): string | null {
  const dot = jobId.indexOf('.');
  return dot > 0 ? jobId.slice(0, dot) : null;
}

setInterval(() => {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (job.status === 'done') {
      if (now - job.finishedAt > JOB_TTL_MS) jobs.delete(id);
    } else if (now - job.startedAt > JOB_MAX_RUNTIME_MS) {
      console.warn(`[worker] Job ${id} exceeded max runtime, marking failed`);
      jobs.set(id, {
        status: 'done', httpStatus: 504, finishedAt: now,
        body: { error: 'JOB_TIMEOUT', message: 'Transcription exceeded the maximum runtime' },
      });
    }
  }
}, 5 * 60_000).unref();

/** Collects what the handler writes to `res` instead of sending it to a client. */
function createResponseCapture(): {
  res: express.Response;
  settled: Promise<{ httpStatus: number; body: any }>;
} {
  let resolve!: (v: { httpStatus: number; body: any }) => void;
  const settled = new Promise<{ httpStatus: number; body: any }>((r) => { resolve = r; });
  let httpStatus = 200;
  const res = {
    status(code: number) { httpStatus = code; return res; },
    json(body: any) { resolve({ httpStatus, body }); return res; },
  } as unknown as express.Response;
  return { res, settled };
}

const handleYouTubeAudio = async (req: express.Request, res: express.Response): Promise<void> => {
  const tmpDir = join(os.tmpdir(), `yt-audio-${Date.now()}`);
  const chunkDir = join(tmpDir, 'chunks');

  try {
    const {
      url,
      startTime,
      endTime,
      format = true,
      forceAudioTranscription = false,
    } = req.body;
    if (!url || typeof url !== 'string') {
      res.status(400).json({ error: 'INVALID_URL', message: 'Please provide a valid YouTube URL' });
      return;
    }

    const videoId = extractVideoId(url);
    if (!videoId) {
      res.status(400).json({ error: 'INVALID_URL', message: 'Cannot extract YouTube video ID' });
      return;
    }

    console.log(`[worker] Starting: ${videoId}`);

    // Strategy 1: youtube_transcript_api (Python — no bot detection, no proxy needed)
    // Always try this first unless a time range is specified (captions can't be trimmed).
    // This library differs from the Next.js npm one and often succeeds where npm fails.
    if (!startTime && !endTime) {
      console.log('[worker] Trying YouTube transcript API first...');
      const transcriptText = await getYouTubeTranscript(videoId);
      if (transcriptText && transcriptText.length > 50) {
        console.log('[worker] Transcript available, skipping audio download');
        const formatted = format ? await formatTranscript(transcriptText) : transcriptText.trim();
        res.json({
          transcript: formatted,
          source: 'youtube_transcript',
          videoId,
          charCount: formatted.length,
        });
        return;
      }
      console.log('[worker] No transcript, falling back to audio download');
    } else {
      console.log('[worker] Time range specified — skipping transcript API, using audio path');
    }

    // Strategy 2: yt-dlp + Whisper
    const [ytDlp, ffmpeg] = await Promise.all([ensureYtDlp(), ensureFfmpeg()]);
    await mkdir(tmpDir, { recursive: true });
    await mkdir(chunkDir, { recursive: true });

    const fakeUA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
    const ytBase = `"${ytDlp}" --no-warnings --js-runtimes node --user-agent "${fakeUA}" --add-headers "Accept-Language:zh-TW,zh;q=0.9,en;q=0.8" ${cookiesArg()} ${proxyArg()}`.trim();
    // tv_embedded often bypasses bot detection; web_creator is another good option
    const playerClients = ['tv_embedded', 'ios', 'web_creator', 'android', 'mweb', 'web'];

    // Check video duration
    try {
      const { stdout: infoJson } = await execAsync(
        `${ytBase} --extractor-args "youtube:player_client=tv_embedded" --dump-json --no-playlist "https://www.youtube.com/watch?v=${videoId}"`,
        { timeout: 30_000, maxBuffer: 10 * 1024 * 1024 },
      );
      const dur: number = JSON.parse(infoJson).duration || 0;
      console.log(`[worker] Duration: ${Math.round(dur / 60)} min`);
      if (dur > MAX_VIDEO_DURATION_SEC) {
        res.status(400).json({
          error: 'VIDEO_TOO_LONG',
          message: `Video is ${Math.round(dur / 60)} min, exceeds 180 min limit`,
        });
        return;
      }
    } catch { /* ignore duration check errors */ }

    // Format selector: prefer small audio-only, fall back to low-res muxed (ffmpeg extracts audio)
    // The muxed fallback (best[height<=360]) handles clients that only provide muxed streams.
    const fmtSel = 'bestaudio[abr<=48][ext=webm]/bestaudio[abr<=48]/bestaudio[abr<=64][ext=m4a]/bestaudio[ext=webm]/bestaudio[ext=m4a]/bestaudio/best[height<=360]';
    const outTpl = join(tmpDir, '%(id)s.%(ext)s');
    let downloadOk = false;
    let lastErr = '';
    const proxyStr = proxyArg();
    console.log(`[worker] Downloading audio (proxy: ${proxyStr ? 'yes' : 'no'})...`);

    // Build command variants: with proxy first, then without proxy as fallback.
    // Webshare rotating proxy can cause 403 when the signed URL IP doesn't match download IP.
    const ytBaseNoProxy = `"${ytDlp}" --no-warnings --js-runtimes node --user-agent "${fakeUA}" --add-headers "Accept-Language:zh-TW,zh;q=0.9,en;q=0.8" ${cookiesArg()}`.trim();
    const commandBases = proxyStr ? [ytBase, ytBaseNoProxy] : [ytBase];

    outer: for (const base of commandBases) {
      const usingProxy = base.includes('--proxy');
      for (const client of playerClients) {
        const dlCmd = `${base} --extractor-args "youtube:player_client=${client}" -f "${fmtSel}" --no-playlist --no-post-overwrites -o "${outTpl}" "https://www.youtube.com/watch?v=${videoId}"`;
        try {
          console.log(`[worker] Trying player_client=${client} (proxy=${usingProxy})...`);
          const { stderr } = await execAsync(dlCmd, { timeout: 600_000, maxBuffer: 50 * 1024 * 1024 });
          if (stderr) console.log('[worker] yt-dlp stderr:', stderr.slice(0, 300));
          downloadOk = true;
          console.log(`[worker] Download succeeded with player_client=${client} proxy=${usingProxy}`);
          break outer;
        } catch (dlError: any) {
          lastErr = dlError?.stderr || dlError?.message || 'unknown';
          console.log(`[worker] player_client=${client} proxy=${usingProxy} failed:`, lastErr.slice(0, 300));
        }
      }

      // Also try default (no explicit player_client) for this proxy setting
      try {
        const dlCmd = `${base} -f "${fmtSel}" --no-playlist --no-post-overwrites -o "${outTpl}" "https://www.youtube.com/watch?v=${videoId}"`;
        console.log(`[worker] Trying default client (proxy=${usingProxy})...`);
        const { stderr } = await execAsync(dlCmd, { timeout: 600_000, maxBuffer: 50 * 1024 * 1024 });
        if (stderr) console.log('[worker] yt-dlp stderr:', stderr.slice(0, 300));
        downloadOk = true;
        console.log(`[worker] Download succeeded with default proxy=${usingProxy}`);
        break outer;
      } catch (dlError: any) {
        lastErr = dlError?.stderr || dlError?.message || 'unknown';
        console.log(`[worker] Default proxy=${usingProxy} failed:`, lastErr.slice(0, 300));
      }
    }

    if (!downloadOk) {
      // Strip WARNING lines (e.g. outdated version notice) — show only real errors.
      const cleanErr = lastErr
        .split('\n')
        .filter((l: string) => !l.trimStart().startsWith('WARNING:'))
        .join('\n')
        .trim() || lastErr.trim();
      const isBotBlock = cleanErr.includes('Sign in to confirm') || cleanErr.includes('not a bot');
      res.status(isBotBlock ? 403 : 500).json({
        error: isBotBlock ? 'BOT_DETECTED' : 'DOWNLOAD_FAILED',
        message: isBotBlock
          ? 'YouTube bot detection triggered. Please try again later.'
          : `Download failed: ${cleanErr.slice(0, 200)}`,
      });
      return;
    }

    // Find downloaded audio file
    const allFiles = await readdir(tmpDir);
    const audioFile = allFiles.find((f) => /\.(m4a|webm|mp3|ogg|opus|wav|mp4|aac)$/i.test(f));
    if (!audioFile) {
      console.error('[worker] No audio file. Files:', allFiles);
      res.status(500).json({ error: 'DOWNLOAD_FAILED', message: 'No audio file found after download' });
      return;
    }

    let audioPath = join(tmpDir, audioFile);
    const ext = audioFile.split('.').pop()?.toLowerCase() || 'm4a';

    // Trim to time range if specified
    if (startTime || endTime) {
      const trimmedPath = join(tmpDir, `trimmed.${ext}`);
      const ssArg = startTime ? `-ss "${startTime}"` : '';
      const toArg = endTime ? `-to "${endTime}"` : '';
      const trimCmd = `"${ffmpeg}" -i "${audioPath}" ${ssArg} ${toArg} -c copy "${trimmedPath}"`;
      console.log(`[worker] Trimming: ${startTime || '00:00:00'} to ${endTime || 'end'}`);
      await execAsync(trimCmd, { timeout: 60_000, maxBuffer: 50 * 1024 * 1024 });
      if (existsSync(trimmedPath)) audioPath = trimmedPath;
    }

    const fileBytes = statSync(audioPath).size;
    const fileMB = fileBytes / (1024 * 1024);
    console.log(`[worker] Audio: ${fileMB.toFixed(1)} MB`);

    // Transcribe with Whisper
    let transcript = '';
    const durSec = await getAudioDuration(ffmpeg, audioPath);
    const needsChunking = fileBytes > WHISPER_MAX_BYTES || durSec > WHISPER_MAX_DURATION_SEC;
    if (!needsChunking) {
      console.log(`[worker] Transcribing directly (${fileMB.toFixed(1)}MB, ${Math.round(durSec / 60)}min)...`);
      transcript = await transcribeFile(audioPath, ext);
    } else {
      console.log(`[worker] Needs chunking: ${fileMB.toFixed(1)}MB, ${Math.round(durSec / 60)}min — splitting...`);
      const chunks = await splitAudio(ffmpeg, audioPath, chunkDir, CHUNK_DURATION_SEC);
      console.log(`[worker] ${chunks.length} chunks`);
      const parts = await transcribeChunksParallel(chunks, ext);
      transcript = parts.join(' ');
    }

    if (!transcript.trim()) {
      res.status(422).json({ error: 'EMPTY_TRANSCRIPTION', message: 'Transcription returned empty result' });
      return;
    }

    console.log(`[worker] Whisper done: ${transcript.length} chars, formatting...`);
    const formatted = format ? await formatTranscript(transcript.trim()) : transcript.trim();
    console.log(`[worker] Done: ${formatted.length} chars`);

    res.json({
      transcript: formatted,
      source: 'whisper',
      videoId,
      charCount: formatted.length,
    });
  } catch (error: any) {
    console.error('[worker] Error:', error);
    const msg = error?.message || '';

    if (msg.includes('Sign in to confirm') || msg.includes('bot')) {
      res.status(503).json({
        error: 'YOUTUBE_BLOCKED',
        message: 'YouTube bot detection triggered. Please try again later.',
      });
      return;
    }
    if (msg.includes('Video unavailable') || msg.includes('Private video')) {
      res.status(404).json({ error: 'VIDEO_UNAVAILABLE', message: 'Video is unavailable or private' });
      return;
    }

    res.status(500).json({ error: 'TRANSCRIPTION_FAILED', message: msg || 'Unknown error' });
  } finally {
    try {
      if (existsSync(tmpDir)) await rm(tmpDir, { recursive: true, force: true });
    } catch { /* ignore */ }
  }
};

// Synchronous route — kept for short videos and for callers that predate /start.
app.post('/api/youtube-audio', authMiddleware, handleYouTubeAudio);

// Start a transcription job and return immediately; the client polls /status/:jobId.
app.post('/api/youtube-audio/start', authMiddleware, (req: express.Request, res: express.Response) => {
  const jobId = newJobId();
  jobs.set(jobId, { status: 'running', startedAt: Date.now() });
  console.log(`[worker] Job ${jobId} started`);
  res.status(202).json({ jobId });

  const capture = createResponseCapture();

  handleYouTubeAudio(req, capture.res).catch((err: any) => {
    // Only record this if the handler never produced a response of its own.
    if (jobs.get(jobId)?.status !== 'running') return;
    console.error(`[worker] Job ${jobId} threw:`, err);
    jobs.set(jobId, {
      status: 'done', httpStatus: 500, finishedAt: Date.now(),
      body: { error: 'TRANSCRIPTION_FAILED', message: err?.message || 'Unknown error' },
    });
  });

  capture.settled.then(({ httpStatus, body }) => {
    console.log(`[worker] Job ${jobId} finished with HTTP ${httpStatus}`);
    jobs.set(jobId, { status: 'done', httpStatus, body, finishedAt: Date.now() });
  });
});

app.get('/api/youtube-audio/status/:jobId', authMiddleware, (req: express.Request, res: express.Response) => {
  const jobId = String(req.params.jobId ?? '');
  const job = jobs.get(jobId);
  if (!job) {
    const owner = jobOwner(jobId);
    // The poll landed on a machine that does not own this job. Hand it to Fly's proxy,
    // which re-runs the request on the owning machine — transparent to the client.
    // `fly-replay-src` marks a request Fly already replayed once; never bounce it
    // again, or a dead owner would loop the request forever.
    if (owner && owner !== MACHINE_ID && !req.headers['fly-replay-src']) {
      console.log(`[worker] Replaying poll for ${jobId} → machine ${owner}`);
      res.setHeader('fly-replay', `instance=${owner}`);
      res.status(204).end();
      return;
    }
    // Expired, or the owning machine is gone — the client must restart the job.
    res.status(404).json({ error: 'JOB_NOT_FOUND', message: 'Job not found or expired' });
    return;
  }
  if (job.status === 'running') {
    res.json({ status: 'running', elapsedMs: Date.now() - job.startedAt });
    return;
  }
  res.json({ status: 'done', httpStatus: job.httpStatus, result: job.body });
});

// Health check
app.get('/health', (_req: express.Request, res: express.Response) => {
  res.json({ status: 'ok', service: 'youtube-audio-worker' });
});

// Start server
Promise.all([initCookies(), ensureTranscriptScript(), ensureYtDlp().catch((e) => {
  console.warn('[worker] yt-dlp pre-warm failed (will retry on first request):', e?.message?.slice(0, 100));
})]).then(() => {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[worker] YouTube Audio Worker running on port ${PORT}`);
  });
});
