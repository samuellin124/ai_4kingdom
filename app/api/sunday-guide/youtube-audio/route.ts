import { NextResponse } from 'next/server';
import OpenAI from 'openai';
import { exec } from 'child_process';
import { promisify } from 'util';
import { unlink, mkdir, readdir, readFile, writeFile, chmod } from 'fs/promises';
import { existsSync, statSync } from 'fs';
import { join } from 'path';
import os from 'os';
import { formatTranscript } from '../../../lib/formatTranscript';

// Whisper API 單次上限（保留 1MB buffer）
const WHISPER_MAX_BYTES = 24 * 1024 * 1024; // 24 MB
// gpt-4o-transcribe 單次音頻時長上限
const WHISPER_MAX_DURATION_SEC = 1400; // ~23 分鐘
// 每個分片的目標時長（秒）— 20 分鐘，安全低於 1400s 限制
const CHUNK_DURATION_SEC = 20 * 60;
// Amplify 相容：YouTube 影片最長 180 分鐘
const MAX_VIDEO_DURATION_SEC = 180 * 60; // 10800s

const execAsync = promisify(exec);

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// yt-dlp 二進制路徑（快取，避免重複查找）
let ytDlpPath: string | null = null;

/**
 * yt-dlp 通用參數：
 * - Linux：使用 --js-runtimes node 搭配 ios/mweb 客戶端（Lambda 環境優化）
 * - Windows（本地開發）：使用簡化參數，避免 cmd.exe 引號解析問題
 */
const isWindows = os.platform() === 'win32';
const YT_DLP_COMMON_ARGS = isWindows
  ? [
      '--no-check-certificates',
      '--no-warnings',
    ].join(' ')
  : [
      '--js-runtimes', 'node',
      '--extractor-args', '"youtube:player_client=tv_embedded,ios,mweb"',
      '--user-agent', '"Mozilla/5.0 (iPhone; CPU iPhone OS 17_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1"',
      '--no-check-certificates',
      '--no-warnings',
    ].join(' ');

/**
 * 確保 yt-dlp 二進制可用。
 * 優先使用系統安裝的 yt-dlp，否則自動下載。
 * Linux/Lambda：下載 yt-dlp_linux 獨立二進制（內含 Python，不需要系統 python3）
 * Windows：透過 yt-dlp-wrap 下載 yt-dlp.exe
 */
async function ensureYtDlp(): Promise<string> {
  if (ytDlpPath) return ytDlpPath;

  try {
    const { stdout } = await execAsync('yt-dlp --version', { timeout: 5000 });
    if (stdout.trim()) {
      console.log('[youtube-audio] Using system yt-dlp:', stdout.trim());
      ytDlpPath = 'yt-dlp';
      return ytDlpPath;
    }
  } catch {
    // not in PATH
  }

  // Lambda 環境只有 /tmp 可寫，改用 os.tmpdir()
  const binDir = join(os.tmpdir(), 'yt-dlp-bin');
  const binaryName = isWindows ? 'yt-dlp.exe' : 'yt-dlp_linux';
  const binaryPath = join(binDir, binaryName);

  if (existsSync(binaryPath)) {
    ytDlpPath = binaryPath;
    return ytDlpPath;
  }

  console.log('[youtube-audio] Downloading yt-dlp binary...');
  if (!existsSync(binDir)) {
    await mkdir(binDir, { recursive: true });
  }

  if (isWindows) {
    // Windows：使用 yt-dlp-wrap 內建下載器（下載 yt-dlp.exe）
    const YTDlpWrap = (await import('yt-dlp-wrap')).default;
    await YTDlpWrap.downloadFromGithub(binaryPath);
  } else {
    // Linux/Lambda：下載獨立二進制，不需要 python3
    // x86_64 → yt-dlp_linux，ARM64 → yt-dlp_linux_aarch64
    const assetName = process.arch === 'arm64' ? 'yt-dlp_linux_aarch64' : 'yt-dlp_linux';
    const downloadUrl = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${assetName}`;
    console.log(`[youtube-audio] Fetching standalone binary: ${assetName}`);

    const response = await fetch(downloadUrl, { redirect: 'follow' });
    if (!response.ok) {
      throw new Error(`Failed to download yt-dlp: HTTP ${response.status}`);
    }
    const arrayBuffer = await response.arrayBuffer();
    await writeFile(binaryPath, Buffer.from(arrayBuffer));
    await chmod(binaryPath, 0o755);
  }

  console.log('[youtube-audio] yt-dlp downloaded to:', binaryPath);
  ytDlpPath = binaryPath;
  return ytDlpPath;
}

/**
 * 取得 ffmpeg 執行檔路徑。
 * 優先系統 ffmpeg，其次 ffmpeg-static（bundled npm binary）。
 */
async function getFfmpegPath(): Promise<string | null> {
  try {
    await execAsync('ffmpeg -version', { timeout: 5000 });
    return 'ffmpeg';
  } catch {
    try {
      // 使用 require() 避免 Next.js bundle 將路徑轉換為內部模組 ID
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const p: string | null = require('ffmpeg-static');
      if (p && existsSync(p)) {
        console.log('[youtube-audio] Using ffmpeg-static:', p);
        return p;
      }
    } catch {
      // ffmpeg-static not available
    }
    return null;
  }
}

/**
 * 獲取音頻時長（秒），從 ffmpeg stderr 解析 Duration 行
 */
async function getAudioDuration(ffmpegPath: string, filePath: string): Promise<number> {
  try {
    // ffmpeg -i 會把 Duration 輸出到 stderr
    const result = await execAsync(`"${ffmpegPath}" -i "${filePath}"`, { timeout: 15000 })
      .catch((e: any) => ({ stdout: '', stderr: e.stderr || e.message || '' }));
    const output = (result.stdout || '') + (result.stderr || '');
    const m = output.match(/Duration:\s*(\d+):(\d+):(\d+)/);
    if (m) return parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseInt(m[3]);
  } catch (e) {
    console.warn('[youtube-audio] Could not get duration:', e);
  }
  return 0;
}

/**
 * 使用 ffmpeg 將音頻按固定時長切成多個片段
 * 回傳已排序的分片路徑陣列
 */
async function splitAudio(
  ffmpegPath: string,
  inputPath: string,
  outputDir: string,
  chunkSec: number
): Promise<string[]> {
  const ext = inputPath.split('.').pop()?.toLowerCase() || 'm4a';
  const pattern = join(outputDir, `chunk_%03d.${ext}`);
  const cmd = `"${ffmpegPath}" -i "${inputPath}" -f segment -segment_time ${chunkSec} -c copy -reset_timestamps 1 "${pattern}"`;
  console.log('[youtube-audio] Splitting with ffmpeg...');
  await execAsync(cmd, { timeout: 120_000, maxBuffer: 50 * 1024 * 1024 });
  const files = await readdir(outputDir);
  return files
    .filter((f) => /^chunk_\d+\.\w+$/.test(f))
    .sort()
    .map((f) => join(outputDir, f));
}

/**
 * 將音頻檔轉成 File 物件後送 Whisper 轉錄，回傳文字
 */
async function transcribeFile(filePath: string, ext: string): Promise<string> {
  const mimeMap: Record<string, string> = {
    m4a: 'audio/mp4', webm: 'audio/webm', mp3: 'audio/mpeg',
    ogg: 'audio/ogg', opus: 'audio/ogg', wav: 'audio/wav',
    mp4: 'video/mp4', aac: 'audio/aac',
  };
  const mimeType = mimeMap[ext] || 'audio/mp4';
  const buf = await readFile(filePath);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  const whisperFile = new File([ab], `audio.${ext}`, { type: mimeType });
  const result = await openai.audio.transcriptions.create({
    file: whisperFile,
    model: 'gpt-4o-transcribe',
    response_format: 'text',
  });
  return typeof result === 'string' ? result : (result as any).text || String(result);
}

// ── YouTube 代理策略 ─────────────────────────────────────────────
// 使用多套 YouTube 代理前端取得音頻下載 URL：
//   Piped  (Java)      — GET /streams/{videoId}       → audioStreams[]
//   Invidious (Crystal) — GET /api/v1/videos/{videoId} → adaptiveFormats[]
//   Cobalt              — POST /                       → proxied download URL
// 實例清單透過公開 API「動態發現」，避免硬編碼實例過時失效。

/** 代理 API 回傳的音頻串流資訊 */
interface ProxyAudioResult {
  url: string;       // 音頻下載 URL（CDN 直連或代理隧道）
  ext: string;       // 檔案副檔名 (webm / m4a / mp3)
  duration: number;  // 影片時長（秒），0 = 未知
  source: string;    // 來源描述
}

const PROXY_HEADERS = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36' };

// ── 動態實例發現（含記憶體快取）────────────────────────────────
let _pipedCache: string[] | null = null;
let _invidiousCache: string[] | null = null;
let _cacheTs = 0;
const CACHE_TTL = 30 * 60_000; // 30 分鐘

/** 硬編碼備用（當動態發現 API 本身也掛時） */
const PIPED_FALLBACK = [
  'https://pipedapi.kavin.rocks',
  'https://pipedapi.adminforge.de',
  'https://api.piped.projectsegfau.lt',
  'https://pipedapi.darkness.services',
  'https://pipedapi.moomoo.me',
];
const INVIDIOUS_FALLBACK = [
  'https://vid.puffyan.us',
  'https://invidious.fdn.fr',
  'https://yt.artemislena.eu',
  'https://invidious.perennialte.ch',
  'https://inv.tux.pizza',
];

/**
 * 從 Piped 官方 API 動態獲取活躍的 Piped 實例清單
 * @see https://piped-instances.kavin.rocks/
 */
async function discoverPipedInstances(): Promise<string[]> {
  if (_pipedCache && Date.now() - _cacheTs < CACHE_TTL) return _pipedCache;
  try {
    const res = await fetch('https://piped-instances.kavin.rocks/', {
      signal: AbortSignal.timeout(5_000), headers: PROXY_HEADERS,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    const list: any[] = JSON.parse(text);
    const urls = list
      .filter((i) => i.api_url && !i.cdn)
      .map((i) => (i.api_url as string).replace(/\/$/, ''))
      .slice(0, 10);
    if (urls.length > 0) {
      _pipedCache = urls;
      _cacheTs = Date.now();
      console.log(`[youtube-audio] Discovered ${urls.length} Piped instances`);
      return urls;
    }
  } catch (err) {
    console.warn('[youtube-audio] Piped discovery failed:', (err as Error).message?.slice(0, 80));
  }
  return PIPED_FALLBACK;
}

/**
 * 從 Invidious 官方 API 動態獲取活躍的 Invidious 實例清單
 * @see https://api.invidious.io/instances.json
 */
async function discoverInvidiousInstances(): Promise<string[]> {
  if (_invidiousCache && Date.now() - _cacheTs < CACHE_TTL) return _invidiousCache;
  try {
    const res = await fetch('https://api.invidious.io/instances.json', {
      signal: AbortSignal.timeout(5_000), headers: PROXY_HEADERS,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    const list: [string, any][] = JSON.parse(text);
    const urls = list
      .filter(([, info]) => info.api === true && info.type === 'https' && info.uri)
      .map(([, info]) => (info.uri as string).replace(/\/$/, ''))
      .slice(0, 10);
    if (urls.length > 0) {
      _invidiousCache = urls;
      _cacheTs = Date.now();
      console.log(`[youtube-audio] Discovered ${urls.length} Invidious instances`);
      return urls;
    }
  } catch (err) {
    console.warn('[youtube-audio] Invidious discovery failed:', (err as Error).message?.slice(0, 80));
  }
  return INVIDIOUS_FALLBACK;
}

/**
 * 回傳第一個成功的任務結果；只有在全部失敗時才 reject。
 * 用於彼此獨立的候選來源——逐一嘗試會把每個失敗者的逾時時間累加起來。
 */
async function firstSuccessful<T>(tasks: Array<() => Promise<T>>, label: string): Promise<T> {
  if (tasks.length === 0) throw new Error(`${label}: 沒有可用的候選來源`);
  return new Promise<T>((resolve, reject) => {
    let remaining = tasks.length;
    let settled = false;
    for (const task of tasks) {
      task().then(
        (value) => { if (!settled) { settled = true; resolve(value); } },
        (err) => {
          remaining -= 1;
          if (remaining === 0 && !settled) {
            reject(new Error(`${label}: ${tasks.length} 個候選全部失敗（最後：${(err as Error)?.message?.slice(0, 80)}）`));
          }
        },
      );
    }
  });
}

// ── Piped 解析 ──────────────────────────────────────────────────
// 各實例是彼此獨立的輕量 JSON 查詢，因此同時發出並取最快成功者。
// 舊的逐一嘗試在實例失效時，最多要累積 10 × 8 秒的逾時才會放棄。
async function resolveViaPiped(videoId: string): Promise<ProxyAudioResult> {
  const instances = await discoverPipedInstances();
  return firstSuccessful(
    instances.map((instance) => async (): Promise<ProxyAudioResult> => {
      const res = await fetch(`${instance}/streams/${videoId}`, {
        signal: AbortSignal.timeout(8_000), headers: PROXY_HEADERS,
      });
      if (!res.ok) throw new Error(`${instance} → ${res.status}`);
      const text = await res.text();
      if (!text || text.length < 2) throw new Error(`${instance} → empty`);
      let data: any;
      try { data = JSON.parse(text); } catch { throw new Error(`${instance} → bad JSON`); }
      if (data.error) throw new Error(`${instance} → ${String(data.error).slice(0, 60)}`);
      const duration: number = data.duration || 0;
      const streams: any[] = (data.audioStreams || []).filter((s: any) => s.url);
      if (streams.length === 0) throw new Error(`${instance} → no audio streams`);
      streams.sort((a: any, b: any) =>
        Math.abs((a.bitrate ?? 0) - 128_000) - Math.abs((b.bitrate ?? 0) - 128_000)
      );
      const fmt = streams[0];
      const ext = fmt.mimeType?.includes('webm') ? 'webm' : 'm4a';
      const host = new URL(instance).hostname;
      console.log(`[youtube-audio] Piped ${host} → ${ext} @ ${Math.round((fmt.bitrate ?? 0) / 1000)}kbps, ${Math.round(duration / 60)}min`);
      return { url: fmt.url, ext, duration, source: `Piped(${host})` };
    }),
    'Piped',
  );
}

// ── Invidious 解析 ──────────────────────────────────────────────
async function resolveViaInvidious(videoId: string): Promise<ProxyAudioResult> {
  const instances = await discoverInvidiousInstances();
  return firstSuccessful(
    instances.map((instance) => async (): Promise<ProxyAudioResult> => {
      const res = await fetch(`${instance}/api/v1/videos/${videoId}`, {
        signal: AbortSignal.timeout(8_000), headers: PROXY_HEADERS,
      });
      if (!res.ok) throw new Error(`${instance} → ${res.status}`);
      const text = await res.text();
      if (!text || text.length < 2) throw new Error(`${instance} → empty`);
      let data: any;
      try { data = JSON.parse(text); } catch { throw new Error(`${instance} → bad JSON`); }
      if (data.error) throw new Error(`${instance} → ${String(data.error).slice(0, 60)}`);
      const duration: number = data.lengthSeconds || 0;
      const formats: any[] = data.adaptiveFormats || [];
      const audioFormats = formats.filter((f) => f.type?.startsWith('audio/') && f.url);
      if (audioFormats.length === 0) throw new Error(`${instance} → no audio fmts`);
      audioFormats.sort((a, b) => Math.abs((a.bitrate ?? 0) - 128_000) - Math.abs((b.bitrate ?? 0) - 128_000));
      const fmt = audioFormats[0];
      const ext = (fmt.type as string).includes('webm') ? 'webm' : 'm4a';
      const host = new URL(instance).hostname;
      console.log(`[youtube-audio] Invidious ${host} → ${ext} @ ${Math.round((fmt.bitrate ?? 0) / 1000)}kbps, ${Math.round(duration / 60)}min`);
      return { url: fmt.url as string, ext, duration, source: `Invidious(${host})` };
    }),
    'Invidious',
  );
}

// ── Cobalt API 解析（自帶下載代理，不受 IP 限制）─────────────────
const COBALT_INSTANCES = [
  'https://api.cobalt.tools',
];

/**
 * 透過 Cobalt API 取得 YouTube 音頻下載 URL。
 * Cobalt 以 tunnel 模式代理下載，不暴露 Lambda IP 給 YouTube。
 * @see https://github.com/imputnet/cobalt
 */
async function resolveViaCobalt(videoId: string): Promise<ProxyAudioResult> {
  const ytUrl = `https://www.youtube.com/watch?v=${videoId}`;
  for (const instance of COBALT_INSTANCES) {
    try {
      const res = await fetch(instance, {
        method: 'POST',
        signal: AbortSignal.timeout(15_000),
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ url: ytUrl, downloadMode: 'audio', audioFormat: 'mp3' }),
      });
      if (!res.ok) { console.warn(`[youtube-audio] Cobalt ${instance} → ${res.status}`); continue; }
      const text = await res.text();
      if (!text || text.length < 2) continue;
      let data: any;
      try { data = JSON.parse(text); } catch { console.warn(`[youtube-audio] Cobalt → bad JSON`); continue; }
      if (data.status === 'error') { console.warn(`[youtube-audio] Cobalt error: ${data.error?.code || data.error}`); continue; }
      const dlUrl: string = data.url;
      if (!dlUrl) { console.warn('[youtube-audio] Cobalt → no URL in response'); continue; }
      console.log(`[youtube-audio] Cobalt → mp3 download URL obtained (status: ${data.status})`);
      return { url: dlUrl, ext: 'mp3', duration: 0, source: 'Cobalt' };
    } catch (err) {
      console.warn(`[youtube-audio] Cobalt ${instance} err:`, (err as Error).message?.slice(0, 80));
    }
  }
  throw new Error('Cobalt API failed');
}

/**
 * 從 URL 提取 videoId
 */
function extractVideoId(url: string): string | null {
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/v\/|youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/,
    /^([a-zA-Z0-9_-]{11})$/,
  ];
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) return match[1];
  }
  return null;
}

/**
 * POST /api/sunday-guide/youtube-audio
 * 下載 YouTube 影片音源並透過 Whisper 轉錄。支援最長約 1 小時影片：
 * - 優先選低位元率格式（48kbps webm/opus）確保單一檔案 < 25MB
 * - 若仍超限則用 ffmpeg-static 自動分片（每 20 分鐘一片），逐片轉錄後拼接
 *
 * Body: { url: string }
 * Response: { transcript: string, source: 'whisper', videoId: string, charCount: number }
 */
export async function POST(request: Request) {
  // ── Fly.io 微服務代理模式（Amplify 生產環境）──────────────────
  // 設定 YOUTUBE_WORKER_URL 環境變數後，所有 YouTube 轉錄請求將代理到 Fly.io 微服務
  // 未設定時走本地 yt-dlp 管道（Windows 開發）
  const WORKER_URL = process.env.YOUTUBE_WORKER_URL;
  console.log('[youtube-audio] ENV check — YOUTUBE_WORKER_URL:', WORKER_URL ? `"${WORKER_URL}"` : '(not set)',
    '| YOUTUBE_WORKER_SECRET:', process.env.YOUTUBE_WORKER_SECRET ? '(set)' : '(not set)');
  if (WORKER_URL) {
    try {
      const body = await request.json();
      console.log('[youtube-audio] Proxying to Fly.io worker:', WORKER_URL);

      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      const workerSecret = process.env.YOUTUBE_WORKER_SECRET;
      if (workerSecret) headers['x-worker-secret'] = workerSecret;

      const workerRes = await fetch(`${WORKER_URL}/api/youtube-audio`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(160_000), // 160 秒（Amplify Lambda 限制 180s，留 20s buffer）
      });

      // 防禦：先讀 text 再 parse，避免 worker 回傳空 body 時 crash
      let data: any;
      const rawText = await workerRes.text();
      try {
        data = rawText.trim() ? JSON.parse(rawText) : { error: 'EMPTY_RESPONSE', message: 'Worker 回傳空 body' };
      } catch {
        data = { error: 'INVALID_JSON', message: `Worker 回傳非 JSON: ${rawText.slice(0, 200)}` };
      }
      return NextResponse.json(data, { status: workerRes.status });
    } catch (proxyErr: any) {
      console.error('[youtube-audio] Fly.io proxy failed:', proxyErr);
      return NextResponse.json(
        { error: 'WORKER_PROXY_FAILED', message: `Fly.io 微服務連線失敗: ${proxyErr?.message || '未知錯誤'}` },
        { status: 502 }
      );
    }
  }

  // ── 本地模式（直接使用 yt-dlp）──────────────────────────────
  const tmpDir = join(os.tmpdir(), `yt-audio-${Date.now()}`);
  const chunkDir = join(tmpDir, 'chunks');

  try {
    const body = await request.json();
    const { url, startTime, endTime } = body;

    if (!url || typeof url !== 'string') {
      return NextResponse.json(
        { error: 'INVALID_URL', message: '请提供有效的 YouTube URL' },
        { status: 400 }
      );
    }

    const videoId = extractVideoId(url);
    if (!videoId) {
      return NextResponse.json(
        { error: 'INVALID_URL', message: '无法识别 YouTube 影片 ID，请检查 URL 格式' },
        { status: 400 }
      );
    }

    console.log('[youtube-audio] Starting audio extraction for:', videoId);

    const ffmpegPath = await getFfmpegPath();

    await mkdir(tmpDir, { recursive: true });
    await mkdir(chunkDir, { recursive: true });

    // ── 音頻下載策略（多代理 + yt-dlp 備案）──────────────────────
    // 三種代理彼此獨立，因此「解析」階段同時發出（都只是輕量 JSON 查詢）；
    // 舊的逐一嘗試在多數實例失效時，光是累積逾時就可能超過三分鐘才開始下載。
    // 「下載」階段仍維持逐一嘗試——同時抓取完整音訊會浪費頻寬，也拿不到回退的好處。
    console.log('[youtube-audio] Resolving via Piped / Invidious / Cobalt in parallel...');
    const resolveStartedAt = Date.now();

    // 三者立即同時啟動，但仍依偏好順序取用：Piped 先回來就馬上開始下載，
    // 不必等最慢的那個逾時；若它的下載失敗，其餘通常也已經在背景解析完成。
    const pending: Array<{ name: string; promise: Promise<ProxyAudioResult> }> = [
      { name: 'Piped', promise: resolveViaPiped(videoId) },
      { name: 'Invidious', promise: resolveViaInvidious(videoId) },
      { name: 'Cobalt', promise: resolveViaCobalt(videoId) },
    ];
    // 先掛上 no-op catch：提早成功時未被 await 的那幾個才不會變成 unhandled rejection。
    pending.forEach(({ promise }) => { promise.catch(() => {}); });

    let downloaded = false;
    for (const { name, promise } of pending) {
      if (downloaded) break;
      try {
        const proxy = await promise;
        console.log(`[youtube-audio] ${name} resolved after ${((Date.now() - resolveStartedAt) / 1000).toFixed(1)}s`);
        // 時長檢查（由代理 API 直接回傳，免除 yt-dlp --dump-json）
        if (proxy.duration > 0) {
          console.log(`[youtube-audio] Duration: ${Math.round(proxy.duration / 60)} min (${proxy.source})`);
          if (proxy.duration > MAX_VIDEO_DURATION_SEC) {
            return NextResponse.json(
              {
                error: 'VIDEO_TOO_LONG',
                message: `影片時長約 ${Math.round(proxy.duration / 60)} 分鐘，超出上限（180 分鐘）。請使用「指定轉錄片段」功能擷取部分內容，或選擇較短的影片。`,
              },
              { status: 400 }
            );
          }
        }

        // 從 Google CDN 下載音頻
        console.log(`[youtube-audio] Downloading via ${proxy.source}...`);
        const cdnRes = await fetch(proxy.url, { signal: AbortSignal.timeout(300_000) });
        if (!cdnRes.ok) {
          console.warn(`[youtube-audio] ${name} CDN HTTP ${cdnRes.status}, trying next strategy`);
          continue;
        }
        const buf = await cdnRes.arrayBuffer();
        if (buf.byteLength < 1000) {
          console.warn(`[youtube-audio] ${name} response too small (${buf.byteLength}B), trying next`);
          continue;
        }
        await writeFile(join(tmpDir, `${videoId}.${proxy.ext}`), Buffer.from(buf));
        console.log(`[youtube-audio] ✓ ${proxy.source} → ${(buf.byteLength / 1024 / 1024).toFixed(1)} MB`);
        downloaded = true;
      } catch (err) {
        console.warn(`[youtube-audio] ${name} failed:`, (err as Error).message?.slice(0, 150));
      }
    }

    // yt-dlp 最後備案（Lambda 因 YouTube IP 封鎖幾乎必定失敗，但本地開發可用）
    if (!downloaded) {
      console.log('[youtube-audio] All proxy strategies failed, trying yt-dlp as last resort...');
      try {
        const ytDlp = await ensureYtDlp();

        // 時長預檢（代理策略未成功時才需要）
        try {
          const { stdout: infoJson } = await execAsync(
            `"${ytDlp}" ${YT_DLP_COMMON_ARGS} --dump-json --no-playlist "https://www.youtube.com/watch?v=${videoId}"`,
            { timeout: 30_000, maxBuffer: 10 * 1024 * 1024 }
          );
          const dur: number = JSON.parse(infoJson).duration || 0;
          if (dur > MAX_VIDEO_DURATION_SEC) {
            return NextResponse.json(
              {
                error: 'VIDEO_TOO_LONG',
                message: `影片時長約 ${Math.round(dur / 60)} 分鐘，超出上限（180 分鐘）。`,
              },
              { status: 400 }
            );
          }
        } catch {
          // metadata 取得失敗不阻擋下載嘗試
        }

        const fmtSel =
          'bestaudio[abr<=48][ext=webm]/bestaudio[abr<=48]/bestaudio[abr<=64][ext=m4a]/bestaudio[ext=webm]/bestaudio[ext=m4a]/bestaudio';
        const outTpl = join(tmpDir, '%(id)s.%(ext)s');
        const cmd = `"${ytDlp}" ${YT_DLP_COMMON_ARGS} -f "${fmtSel}" --no-playlist --no-post-overwrites -o "${outTpl}" "https://www.youtube.com/watch?v=${videoId}"`;
        console.log('[youtube-audio] Running yt-dlp...');
        const { stderr } = await execAsync(cmd, { timeout: 600_000, maxBuffer: 50 * 1024 * 1024 });
        if (stderr) console.log('[youtube-audio] yt-dlp stderr:', stderr.slice(0, 300));
      } catch (dlpErr: any) {
        console.error('[youtube-audio] yt-dlp also failed:', (dlpErr as Error).message?.slice(0, 300));
        return NextResponse.json(
          {
            error: 'YOUTUBE_BLOCKED',
            message:
              '伺服器目前無法從 YouTube 取得此影片的音頻。所有下載管道（Piped / Invidious / yt-dlp）均已嘗試但未成功。\n\n' +
              '請改用「手動上傳音頻」功能：\n' +
              '1. 在您的電腦或手機上下載 YouTube 影片音頻（可用 yt-dlp、瀏覽器外掛或線上轉換工具）\n' +
              '2. 點擊頁面上的「上傳音頻檔案」按鈕\n' +
              '3. 選擇 MP3 / M4A / WebM 檔案，系統將自動使用 Whisper AI 轉錄',
          },
          { status: 503 }
        );
      }
    }

    // 找出下載的主音頻檔案
    const allFiles = await readdir(tmpDir);
    const audioFileName = allFiles.find((f) =>
      /\.(m4a|webm|mp3|ogg|opus|wav|mp4|aac)$/i.test(f)
    );

    if (!audioFileName) {
      console.error('[youtube-audio] No audio file. Files:', allFiles);
      return NextResponse.json(
        { error: 'DOWNLOAD_FAILED', message: '下载音频失败，未找到音频文件。' },
        { status: 500 }
      );
    }

    let audioFilePath = join(tmpDir, audioFileName);
    const ext = audioFileName.split('.').pop()?.toLowerCase() || 'm4a';

    // ── 時段裁剪（若有指定 startTime 或 endTime）─────────────────────────────
    if ((startTime || endTime) && ffmpegPath) {
      const trimmedPath = join(tmpDir, `trimmed.${ext}`);
      const ssArg = startTime ? `-ss "${startTime}"` : '';
      const toArg = endTime ? `-to "${endTime}"` : '';
      const trimCmd = `"${ffmpegPath}" -i "${audioFilePath}" ${ssArg} ${toArg} -c copy "${trimmedPath}"`;
      console.log(`[youtube-audio] Trimming segment: ${startTime || '00:00:00'} → ${endTime || 'end'}`);
      await execAsync(trimCmd, { timeout: 60_000, maxBuffer: 50 * 1024 * 1024 });
      if (existsSync(trimmedPath)) {
        audioFilePath = trimmedPath;
      } else {
        console.warn('[youtube-audio] Trim output not found, using original file.');
      }
    } else if ((startTime || endTime) && !ffmpegPath) {
      console.warn('[youtube-audio] ffmpeg not available, cannot trim segment. Using full audio.');
    }

    const fileSizeBytes = statSync(audioFilePath).size;
    const fileSizeMB = fileSizeBytes / (1024 * 1024);

    console.log(`[youtube-audio] Audio to transcribe: ${audioFilePath.split(/[\/\\]/).pop()} (${fileSizeMB.toFixed(1)}MB)${startTime || endTime ? ` [segment ${startTime || '00:00:00'}→${endTime || 'end'}]` : ''}`);

    let transcript = '';

    // 檢查是否需要分片（檔案過大 OR 時長超過 gpt-4o-transcribe 1400s 限制）
    const durationSec = ffmpegPath ? await getAudioDuration(ffmpegPath, audioFilePath) : 0;
    const needsChunking = fileSizeBytes > WHISPER_MAX_BYTES || durationSec > WHISPER_MAX_DURATION_SEC;

    if (!needsChunking) {
      // ── 情況 A：檔案夠小且時長夠短，直接送 Whisper ─────────────────────
      console.log(`[youtube-audio] Within limits (${fileSizeMB.toFixed(1)}MB, ${Math.round(durationSec / 60)}min), transcribing directly...`);
      transcript = await transcribeFile(audioFilePath, ext);
    } else {
      // ── 情況 B：檔案過大或時長超限，用 ffmpeg 分片後逐片轉錄 ────────────
      console.log(`[youtube-audio] Needs chunking: ${fileSizeMB.toFixed(1)}MB, ${Math.round(durationSec / 60)}min — splitting into ${CHUNK_DURATION_SEC / 60}min chunks...`);

      if (!ffmpegPath) {
        return NextResponse.json(
          {
            error: 'FFMPEG_REQUIRED',
            message: `音频 ${fileSizeMB.toFixed(1)}MB 超出 Whisper 限制（24MB）且無法自动分片（ffmpeg 不可用）。请选择 30 分钟以内的影片，或手动上传音频文件。`,
          },
          { status: 413 }
        );
      }

      const chunkPaths = await splitAudio(ffmpegPath, audioFilePath, chunkDir, CHUNK_DURATION_SEC);
      console.log(`[youtube-audio] Split into ${chunkPaths.length} chunks.`);

      if (chunkPaths.length === 0) {
        return NextResponse.json(
          { error: 'SPLIT_FAILED', message: '音频分片失败，请重试。' },
          { status: 500 }
        );
      }

      // 逐片轉錄並拼接
      const parts: string[] = [];
      for (let i = 0; i < chunkPaths.length; i++) {
        const chunkPath = chunkPaths[i];
        const chunkBytes = statSync(chunkPath).size;
        const chunkMB = chunkBytes / (1024 * 1024);
        console.log(`[youtube-audio] Chunk ${i + 1}/${chunkPaths.length} (${chunkMB.toFixed(1)}MB)...`);

        if (chunkBytes > WHISPER_MAX_BYTES) {
          console.warn(`[youtube-audio] Chunk ${i + 1} still ${chunkMB.toFixed(1)}MB, skipping.`);
          continue;
        }

        const chunkExt = chunkPath.split('.').pop()?.toLowerCase() || ext;
        const part = await transcribeFile(chunkPath, chunkExt);
        if (part.trim()) parts.push(part.trim());
      }

      transcript = parts.join(' ');
    }

    if (!transcript || transcript.trim().length === 0) {
      return NextResponse.json(
        { error: 'EMPTY_TRANSCRIPTION', message: '转录结果为空。影片可能没有包含可识别的语音内容。' },
        { status: 422 }
      );
    }

    const final = transcript.trim();
    console.log('[youtube-audio] Whisper done. Total chars:', final.length, '— formatting...');

    const formatted = await formatTranscript(final);
    console.log('[youtube-audio] Formatted. chars:', formatted.length);

    const videoTitle = await fetchVideoTitle(videoId);

    return NextResponse.json({
      transcript: formatted,
      source: 'whisper',
      videoId,
      charCount: formatted.length,
      videoTitle: videoTitle ?? null,
    });
  } catch (error: any) {
    console.error('[youtube-audio] Error:', error);
    const msg = error?.message || '';

    if (msg.includes('timeout') || msg.includes('TIMEOUT') || msg.includes('ETIMEDOUT')) {
      return NextResponse.json(
        { error: 'TIMEOUT', message: '下载超时。请检查网络连接后重试，或尝试较短的影片。' },
        { status: 504 }
      );
    }
    if (msg.includes('Video unavailable') || msg.includes('Private video')) {
      return NextResponse.json(
        { error: 'VIDEO_UNAVAILABLE', message: '影片无法访问（可能为私人影片或已删除）。' },
        { status: 404 }
      );
    }
    if (error?.status === 413 || msg.includes('Maximum content size')) {
      return NextResponse.json(
        { error: 'FILE_TOO_LARGE', message: '音频超出 Whisper API 大小限制，请选择较短的影片。' },
        { status: 413 }
      );
    }

    return NextResponse.json(
      { error: 'TRANSCRIPTION_FAILED', message: msg || '音频下载或转录过程中发生错误' },
      { status: 500 }
    );
  } finally {
    // 清理整個暫存目錄（含分片）
    try {
      if (existsSync(tmpDir)) {
        const { rmSync } = require('fs');
        rmSync(tmpDir, { recursive: true, force: true });
      }
    } catch (e) {
      console.warn('[youtube-audio] Cleanup warning:', e);
    }
  }
}

export const maxDuration = 900; // 15 分鐘（Lambda 最長執行時間）
export const dynamic = 'force-dynamic';

async function fetchVideoTitle(videoId: string): Promise<string | null> {
  try {
    const res = await fetch(
      `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`,
      { signal: AbortSignal.timeout(5000) }
    );
    if (!res.ok) return null;
    const data = await res.json();
    return typeof data?.title === 'string' ? data.title : null;
  } catch {
    return null;
  }
}
