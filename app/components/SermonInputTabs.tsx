'use client';

import { useState, useRef, useCallback } from 'react';
import AssistantManager from './AssistantManager';
import { ASSISTANT_IDS, VECTOR_STORE_IDS } from '../config/constants';
import { useAuth } from '../contexts/AuthContext';
import styles from './SermonInputTabs.module.css';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type TabId = 'pdf' | 'youtube' | 'audio';

type TranscriptionState =
  | { status: 'idle' }
  | { status: 'loading'; message: string }
  | { status: 'done'; text: string; source: 'caption' | 'whisper'; charCount: number }
  | { status: 'uploading'; message: string }
  | { status: 'error'; message: string };

interface SermonInputTabsProps {
  onFileProcessed: (content: {
    summary: string;
    fullText: string;
    devotional: string;
    bibleStudy: string;
  }) => void;
  setIsProcessing: (isProcessing: boolean) => void;
  setUploadProgress: (progress: number) => void;
  setUploadTime: (time: string) => void;
  disabled?: boolean;
  assistantId?: string;
  vectorStoreId?: string;
  unitId?: string;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function SermonInputTabs({
  onFileProcessed,
  setIsProcessing,
  setUploadProgress,
  setUploadTime,
  disabled = false,
  assistantId: propAssistantId,
  vectorStoreId: propVectorStoreId,
  unitId: propUnitId,
}: SermonInputTabsProps) {
  const effectiveAssistantId = propAssistantId || ASSISTANT_IDS.SUNDAY_GUIDE;
  const effectiveVectorStoreId = propVectorStoreId || VECTOR_STORE_IDS.SUNDAY_GUIDE;
  const { user } = useAuth();

  // Tab state
  const [activeTab, setActiveTab] = useState<TabId>('pdf');

  // YouTube state
  const [ytUrl, setYtUrl] = useState('');
  const [ytTranscription, setYtTranscription] = useState<TranscriptionState>({ status: 'idle' });
  const [ytStartTime, setYtStartTime] = useState('');
  const [ytEndTime, setYtEndTime] = useState('');
  const [ytShowSegment, setYtShowSegment] = useState(false);
  const [ytVideoTitle, setYtVideoTitle] = useState('');

  // Audio state
  const [audioTranscription, setAudioTranscription] = useState<TranscriptionState>({ status: 'idle' });
  const [audioDragging, setAudioDragging] = useState(false);
  const [audioFileName, setAudioFileName] = useState('');
  const audioInputRef = useRef<HTMLInputElement>(null);
  const publicWorkerUrl = process.env.NEXT_PUBLIC_YOUTUBE_WORKER_URL;

  // Shared: transcript editor
  const [editedText, setEditedText] = useState('');
  const [activeTranscriptTab, setActiveTranscriptTab] = useState<'youtube' | 'audio' | null>(null);

  // ---- Tab definitions ----
  // Production: hide YouTube tab (set NEXT_PUBLIC_HIDE_YOUTUBE_TAB=true in Amplify)
  const hideYoutube = process.env.NEXT_PUBLIC_HIDE_YOUTUBE_TAB === 'true';
  const allTabs: { id: TabId; icon: string; label: string }[] = [
    { id: 'pdf', icon: '📄', label: 'PDF / 文件' },
    { id: 'youtube', icon: '▶️', label: 'YouTube' },
    { id: 'audio', icon: '🎵', label: '音频文件' },
  ];
  const tabs = hideYoutube ? allTabs.filter((t) => t.id !== 'youtube') : allTabs;

  // =========================================================================
  // Helpers
  // =========================================================================
  /** 將 HH:MM:SS / MM:SS / SS 字串轉換為秒數，無效時回傳 null */
  const parseTimestamp = (s: string): number | null => {
    const trimmed = s.trim();
    if (!trimmed) return null;
    const parts = trimmed.split(':').map(Number);
    if (parts.some(isNaN)) return null;
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    if (parts.length === 1) return parts[0];
    return null;
  };

  /** 將秒數格式化為 HH:MM:SS 供顯示用 */
  const formatSeconds = (sec: number): string => {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    return [h, m, s].map((v) => String(v).padStart(2, '0')).join(':');
  };

  /**
   * 輸入遮罩：使用者只需輸入數字，自動補上冒號組成 HH:MM:SS。
   * 分鐘/秒鐘超過 59 時自動夾在 59；刪除冒號時視同刪除前一位數字，讓 backspace 體感自然。
   */
  const formatTimeMask = (raw: string, prevValue: string): string => {
    const isDeleting = raw.length < prevValue.length;
    let digits = raw.replace(/\D/g, '');
    if (isDeleting && digits.length === prevValue.replace(/\D/g, '').length) {
      // 使用者刪除的是自動補上的冒號本身，一併刪除前一位數字
      digits = digits.slice(0, -1);
    }
    digits = digits.slice(0, 6);

    const clamp59 = (pair: string) => (pair.length === 2 && Number(pair) > 59 ? '59' : pair);

    const hh = digits.slice(0, 2);
    const mm = clamp59(digits.slice(2, 4));
    const ss = clamp59(digits.slice(4, 6));

    if (digits.length <= 2) return hh;
    if (digits.length <= 4) return `${hh}:${mm}`;
    return `${hh}:${mm}:${ss}`;
  };

  // =========================================================================
  // YouTube: fetch captions → fallback to audio extraction + Whisper
  // =========================================================================
  const requestYouTubeAudioTranscription = async () => {
    const payload = {
      url: ytUrl.trim(),
      startTime: ytStartTime.trim() || undefined,
      endTime: ytEndTime.trim() || undefined,
      // Do NOT force audio — let the worker try its Python caption API first
      // (different library from the Next.js npm one, often succeeds where npm fails)
      forceAudioTranscription: false,
    };

    const tryParseJson = async (res: Response): Promise<Record<string, any>> => {
      try {
        const rawText = await res.text();
        if (!rawText.trim()) return {};
        return JSON.parse(rawText);
      } catch {
        return {};
      }
    };

    // Preferred path: start an async job on the worker and poll it.
    // The synchronous route cannot outlive API Gateway's hard 29s cap, and when it is
    // cut off the worker keeps transcribing a request nobody is listening to — so the
    // client pays for the same video twice. Polling removes both problems.
    if (publicWorkerUrl) {
      const startRes = await fetch(`${publicWorkerUrl}/api/youtube-audio/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }).catch(() => null);

      // A 404 means the deployed worker predates the job API; fall through to the
      // synchronous path so a frontend release can ship before the worker one.
      if (startRes && startRes.status !== 404) {
        const startData = await tryParseJson(startRes);
        if (!startRes.ok || !startData.jobId) {
          throw new Error(
            startData.message || startData.error || `启动转录任务失败（HTTP ${startRes.status}）`
          );
        }

        const POLL_MS = 4000;
        const MAX_POLLS = 225; // ~15 分鐘
        const startedAt = Date.now();

        for (let i = 0; i < MAX_POLLS; i++) {
          await new Promise((r) => setTimeout(r, POLL_MS));

          const statusRes = await fetch(
            `${publicWorkerUrl}/api/youtube-audio/status/${startData.jobId}`
          ).catch(() => null);
          if (!statusRes) continue; // transient network blip — keep polling

          // Any 4xx is terminal. 404 means the job expired; Fly's proxy answers 400
          // when it cannot replay the poll onto the machine that owns the job,
          // because that machine is gone. Neither gets better by polling again.
          if (statusRes.status >= 400 && statusRes.status < 500) {
            throw new Error('转录任务已过期或遗失，请重新提交。');
          }

          const statusData = await tryParseJson(statusRes);
          if (statusData.status !== 'done') {
            const mins = Math.floor((Date.now() - startedAt) / 60000);
            const secs = Math.floor(((Date.now() - startedAt) % 60000) / 1000);
            setYtTranscription({
              status: 'loading',
              message: `正在转录音频...（已进行 ${mins}:${String(secs).padStart(2, '0')}）`,
            });
            continue;
          }

          const result = statusData.result || {};
          if (statusData.httpStatus !== 200 || !result.transcript) {
            throw new Error(
              result.message || result.error || `音频转录失败（HTTP ${statusData.httpStatus}）`
            );
          }
          return result;
        }

        throw new Error('转录逾时，请稍后再试，或使用「指定转录片段」缩短影片长度。');
      }
    }

    // Fallback: synchronous route via the Next API (short videos, or an old worker)
    const apiRes = await fetch('/api/sunday-guide/youtube-audio', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const apiData = await tryParseJson(apiRes);

    if (apiRes.ok && apiData.transcript) return apiData;

    // If Amplify/API Gateway returns 5xx or a proxy timeout (WORKER_PROXY_FAILED),
    // retry directly against the Fly.io worker URL (bypasses the 160s Amplify limit).
    const shouldTryDirectWorker =
      !apiRes.ok &&
      !!publicWorkerUrl &&
      apiRes.status >= 500 &&
      (!apiData.message || apiData.error === 'WORKER_PROXY_FAILED');

    if (!shouldTryDirectWorker) {
      throw new Error(apiData.message || apiData.error || `音频转录失败（HTTP ${apiRes.status}）`);
    }

    const workerRes = await fetch(`${publicWorkerUrl}/api/youtube-audio`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const workerData = await tryParseJson(workerRes);

    if (!workerRes.ok || !workerData.transcript) {
      throw new Error(
        workerData.message ||
        workerData.error ||
        `音频转录失败（直连 Worker HTTP ${workerRes.status}）`
      );
    }

    return workerData;
  };

  const handleYouTubeFetch = async () => {
    if (!ytUrl.trim()) return;

    // 驗證時段格式
    const startSec = ytStartTime.trim() ? parseTimestamp(ytStartTime) : null;
    const endSec = ytEndTime.trim() ? parseTimestamp(ytEndTime) : null;
    if (ytStartTime.trim() && startSec === null) {
      setYtTranscription({ status: 'error', message: '開始時間格式錯誤，請使用 HH:MM:SS 格式，例如 00:10:30' });
      return;
    }
    if (ytEndTime.trim() && endSec === null) {
      setYtTranscription({ status: 'error', message: '結束時間格式錯誤，請使用 HH:MM:SS 格式，例如 01:00:00' });
      return;
    }
    if (startSec !== null && endSec !== null && startSec >= endSec) {
      setYtTranscription({ status: 'error', message: '結束時間必須大於開始時間' });
      return;
    }

    const segmentLabel =
      startSec !== null || endSec !== null
        ? `（${startSec !== null ? formatSeconds(startSec) : '00:00:00'} → ${endSec !== null ? formatSeconds(endSec) : '結尾'}）`
        : '';

    setYtVideoTitle('');
    setYtTranscription({ status: 'loading', message: `正在获取字幕${segmentLabel}...` });

    try {
      // Step 1: 嘗試抓取字幕
      const res = await fetch('/api/sunday-guide/youtube-transcript', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: ytUrl.trim(),
          startTime: ytStartTime.trim() || undefined,
          endTime: ytEndTime.trim() || undefined,
        }),
      });

      const data = await res.json();

      if (res.ok) {
        // 成功取得字幕
        setYtTranscription({
          status: 'done',
          text: data.transcript,
          source: 'caption',
          charCount: data.charCount,
        });
        setEditedText(data.transcript);
        setActiveTranscriptTab('youtube');
        if (data.videoTitle) setYtVideoTitle(data.videoTitle);
        return;
      }

      // Step 2: 字幕失敗時，自動 fallback 到音源擷取 + Whisper 轉錄
      console.log('[SermonInputTabs] Caption fetch failed, falling back to audio extraction...', data?.error || 'UNKNOWN');
      setYtTranscription({
        status: 'loading',
        message: '字幕不可用，正在下载音频并进行 AI 语音转录（约需 1-3 分钟）...',
      });

      try {
        const audioData = await requestYouTubeAudioTranscription();
        if (audioData.videoTitle) setYtVideoTitle(audioData.videoTitle);
        setYtTranscription({
          status: 'done',
          text: audioData.transcript,
          source: audioData.source === 'youtube_transcript' ? 'caption' : 'whisper',
          charCount: audioData.charCount,
        });
        setEditedText(audioData.transcript);
        setActiveTranscriptTab('youtube');
        // 扣除 Whisper 音頻轉錄 credit
        if (user?.user_id) {
          const estimatedPages = Math.max(1, Math.ceil((audioData.charCount || 0) / 2000));
          fetch('/api/usage/update-tokens', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: user.user_id, type: 'transcribe', estimatedPages }),
          }).catch((e) => console.error('[SermonInputTabs] youtube transcribe token deduction error:', e));
        }
        return;
      } catch (audioErr: any) {
        setYtTranscription({
          status: 'error',
          message: audioErr?.message || '音频转录失败，请改用「音频文件」手动上传。',
        });
        return;
      }
    } catch (err: any) {
      setYtTranscription({
        status: 'error',
        message: err?.message || '网络错误，请重试',
      });
    }
  };

  // =========================================================================
  // Audio: upload + Whisper transcription
  // =========================================================================
  const handleAudioFile = async (file: File) => {
    // Validate
    const ext = file.name.split('.').pop()?.toLowerCase() || '';
    const allowedExts = ['mp3', 'wav', 'm4a', 'mp4', 'webm', 'ogg'];
    if (!allowedExts.includes(ext)) {
      setAudioTranscription({
        status: 'error',
        message: `不支持的格式（.${ext}）。支持：${allowedExts.join('、')}`,
      });
      return;
    }

    const sizeMB = file.size / (1024 * 1024);
    // 200MB 上限（100 分鐘音頻約 92MB @ 128kbps）
    if (sizeMB > 200) {
      setAudioTranscription({
        status: 'error',
        message: `文件 ${sizeMB.toFixed(1)}MB 超出限制（最大 200MB）。`,
      });
      return;
    }

    const isLarge = sizeMB > 10;
    const timeHint = isLarge
      ? `（${sizeMB.toFixed(1)}MB，約需 3-10 分鐘，請耐心等待）`
      : `（${sizeMB.toFixed(1)}MB，约需 1-2 分钟）`;
    setAudioTranscription({
      status: 'loading',
      message: `正在取得轉錄配置...`,
    });

    try {
      let data: any;

      // 先取得 Worker 配置。若 directUpload=true（Amplify / 有設 YOUTUBE_WORKER_URL），
      // 無論檔案大小都直送 Worker，避免 API Gateway 29s timeout。
      // 若 directUpload=false（本地無 Worker 且檔案 ≤10MB），走 Lambda 路徑。
      const configRes = await fetch('/api/sunday-guide/transcription');
      const config = await configRes.json().catch(() => ({ directUpload: false }));

      if (config.directUpload) {
        // 直送 Fly.io Worker（無 API Gateway timeout 限制）
        setAudioTranscription({
          status: 'loading',
          message: `正在上傳「${file.name}」到轉錄服務${timeHint}...`,
        });

        const headers: Record<string, string> = {
          // encodeURIComponent: HTTP headers must be ISO-8859-1; encode non-ASCII filenames
          'x-filename': encodeURIComponent(file.name),
          'content-type': file.type || 'application/octet-stream',
        };
        if (config.workerSecret) headers['x-worker-secret'] = config.workerSecret;

        const workerRes = await fetch(config.uploadUrl, {
          method: 'POST',
          headers,
          body: file,
        });

        let rawText = '';
        try { rawText = await workerRes.text(); } catch { /* ignore */ }
        try { data = rawText.trim() ? JSON.parse(rawText) : {}; } catch { data = {}; }

        if (!workerRes.ok) {
          setAudioTranscription({
            status: 'error',
            message: data.message || data.error || `轉錄失敗（HTTP ${workerRes.status}），請重試。`,
          });
          return;
        }
      } else if (!isLarge) {
        // 本地開發 且 檔案 ≤10MB：走 Amplify Lambda 路徑
        setAudioTranscription({
          status: 'loading',
          message: `正在转录「${file.name}」${timeHint}...`,
        });
        const formData = new FormData();
        formData.append('file', file);
        const res = await fetch('/api/sunday-guide/transcription', {
          method: 'POST',
          body: formData,
        });
        let rawText = '';
        try { rawText = await res.text(); } catch { /* ignore */ }
        try { data = rawText.trim() ? JSON.parse(rawText) : {}; } catch { data = {}; }
        if (!res.ok) {
          setAudioTranscription({
            status: 'error',
            message: data.message || data.error || `转录失败（HTTP ${res.status}）`,
          });
          return;
        }
      } else {
        // directUpload=false 且檔案 >10MB：無法處理
        setAudioTranscription({
          status: 'error',
          message: `文件 ${sizeMB.toFixed(1)}MB 超出伺服器限制（10MB）。請聯絡管理員設定轉錄服務。`,
        });
        return;
      }

      setAudioTranscription({
        status: 'done',
        text: data.transcript,
        source: 'whisper',
        charCount: data.charCount,
      });
      setAudioFileName(file.name);
      setEditedText(data.transcript);
      setActiveTranscriptTab('audio');
      // 扣除 Whisper 音頻轉錄 credit
      if (user?.user_id) {
        const estimatedPages = Math.max(1, Math.ceil((data.charCount || 0) / 2000));
        fetch('/api/usage/update-tokens', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userId: user.user_id, type: 'transcribe', estimatedPages }),
        }).catch((e) => console.error('[SermonInputTabs] audio transcribe token deduction error:', e));
      }
    } catch (err: any) {
      setAudioTranscription({
        status: 'error',
        message: err?.message || '网络错误，请重试',
      });
    }
  };

  // Audio drag-and-drop handlers
  const onAudioDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!disabled) setAudioDragging(true);
  };
  const onAudioDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setAudioDragging(false);
  };
  const onAudioDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };
  const onAudioDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setAudioDragging(false);
    if (disabled) return;
    const file = e.dataTransfer.files?.[0];
    if (file) handleAudioFile(file);
  };

  // =========================================================================
  // Shared: Upload confirmed transcript as .txt → existing pipeline
  // =========================================================================
  const handleConfirmAndUpload = useCallback(async () => {
    const source = activeTranscriptTab;
    if (!editedText.trim() || !source) return;

    const state = source === 'youtube' ? ytTranscription : audioTranscription;
    const setState = source === 'youtube' ? setYtTranscription : setAudioTranscription;

    // Build a .txt file name
    let baseName = 'transcript';
    if (source === 'youtube' && ytUrl) {
      if (ytVideoTitle) {
        // 使用影片標題：去除檔名不合法字元，限制 50 字
        const slug = ytVideoTitle
          .slice(0, 50)
          .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
          .replace(/_{2,}/g, '_')
          .replace(/^_+|_+$/g, '');
        baseName = slug || 'youtube_transcript';
      } else {
        const match = ytUrl.match(/(?:v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
        baseName = match ? `youtube_${match[1]}` : 'youtube_transcript';
      }
    } else if (source === 'audio' && state.status === 'done') {
      if (audioFileName) {
        baseName = audioFileName
          .replace(/\.[^.]+$/, '')
          .slice(0, 50)
          .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
          .replace(/_{2,}/g, '_')
          .replace(/^_+|_+$/g, '') || 'audio_transcript';
      } else {
        baseName = 'audio_transcript';
      }
    }
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

    // 取得現有檔名清單，避免重複
    let existingNames: Set<string> = new Set();
    try {
      const docsRes = await fetch(
        `/api/sunday-guide/documents?assistantId=${effectiveAssistantId}&allUsers=true&limit=500`
      );
      if (docsRes.ok) {
        const docsData = await docsRes.json();
        const items: { fileName?: string }[] = docsData.files || docsData.records || docsData || [];
        items.forEach((item) => { if (item.fileName) existingNames.add(item.fileName); });
      }
    } catch { /* 查詢失敗不阻擋上傳 */ }

    // 產生唯一檔名：若已存在則加 (1)、(2)…
    let fileName = `${baseName}_${today}.txt`;
    if (existingNames.has(fileName)) {
      let idx = 1;
      while (existingNames.has(`${baseName}_${today} (${idx}).txt`)) idx++;
      fileName = `${baseName}_${today} (${idx}).txt`;
    }

    setState({ status: 'uploading', message: '正在上传转录文本并生成讲章内容...' });
    setIsProcessing(true);
    setUploadProgress(5);

    try {
      // Create a File from transcript text
      const txtFile = new File([editedText], fileName, { type: 'text/plain' });
      const formData = new FormData();
      formData.append('file', txtFile);
      if (user?.user_id) formData.append('userId', user.user_id);

      // Step 1: Upload to vector store (same as PDF path)
      const uploadRes = await fetch(
        `/api/vector-store/upload?vectorStoreId=${effectiveVectorStoreId}&assistantId=${effectiveAssistantId}&unitId=${propUnitId || ''}`,
        { method: 'POST', body: formData }
      );

      let uploadData: Record<string, any> = {};
      try {
        uploadData = await uploadRes.json();
      } catch {
        // 空 body（Lambda timeout / CloudFront 504）
        throw new Error(`文件上傳失敗 (HTTP ${uploadRes.status})，請稍後再試。`);
      }
      if (!uploadRes.ok) {
        throw new Error(uploadData.error || `上传失败 (${uploadRes.status})`);
      }

      // 扣除上傳 token 使用量（txt 大小估算頁數）
      if (user?.user_id) {
        const estimatedPages = Math.max(1, Math.ceil(editedText.length / (100 * 1024)));
        fetch('/api/usage/update-tokens', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userId: user.user_id, type: 'upload', estimatedPages }),
        }).catch((e) => console.error('[SermonInputTabs] upload token deduction error:', e));
      }

      setUploadProgress(20);

      // Step 2: Trigger processing（fire-and-forget：不 await，避免 CloudFront 30s 超時）
      fetch('/api/sunday-guide/process-document', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          assistantId: effectiveAssistantId,
          vectorStoreId: effectiveVectorStoreId,
          fileName,
          fileId: uploadData.fileId,
          userId: user?.user_id || '-',
          unitId: propUnitId || undefined,
        }),
      }).catch(e => console.log('[SermonInputTabs] process-document kick:', e.message));

      setUploadProgress(30);

      // Step 3: Poll for results
      let pollCount = 0;
      const MAX_POLLS = 150; // ~7.5 分鐘
      const pollResult = async () => {
        pollCount++;
        if (pollCount > MAX_POLLS) {
          setIsProcessing(false);
          setState({ status: 'error', message: '處理逾時，請重新上傳或稍後再試。' });
          return;
        }
        try {
          const statusRes = await fetch(
            `/api/sunday-guide/check-result?vectorStoreId=${effectiveVectorStoreId}&fileName=${encodeURIComponent(fileName)}`
          );
          if (!statusRes.ok) {
            setTimeout(pollResult, 5000);
            return;
          }
          const result = await statusRes.json();
          if (result.status === 'failed') {
            setIsProcessing(false);
            setState({ status: 'error', message: result.error || '文件處理失敗，請重新嘗試。' });
            return;
          }
          if (result.found) {
            setUploadProgress(100);
            setIsProcessing(false);
            const pdtTime = new Date().toLocaleString('zh-TW', {
              timeZone: 'America/Los_Angeles',
              year: 'numeric',
              month: '2-digit',
              day: '2-digit',
              hour: '2-digit',
              minute: '2-digit',
              second: '2-digit',
              hour12: false,
            }) + ' PDT';
            setUploadTime(pdtTime);
            onFileProcessed(result);

            if (user?.user_id) {
              const textLength = (result.summary?.length || 0) +
                (result.fullText?.length || 0) +
                (result.devotional?.length || 0) +
                (result.bibleStudy?.length || 0);
              const estimatedPages = Math.max(1, Math.ceil(textLength / 5000));
              fetch('/api/usage/update-tokens', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  userId: user.user_id,
                  type: 'process',
                  estimatedPages,
                }),
              }).catch((e) => console.error('[SermonInputTabs] token deduction error:', e));
            }

            setState({ status: 'idle' });
          } else {
            setUploadProgress(Math.min(pollCount * 0.5 + 30, 90));
            setTimeout(pollResult, 3000);
          }
        } catch {
          setTimeout(pollResult, 5000);
        }
      };

      setTimeout(pollResult, 3000);
    } catch (err: any) {
      console.error('[SermonInputTabs] Upload error:', err);
      setState({
        status: 'error',
        message: err?.message || '上传处理失败，请重试',
      });
      setIsProcessing(false);
      setUploadProgress(0);
    }
  }, [
    editedText,
    activeTranscriptTab,
    ytUrl,
    ytTranscription,
    audioTranscription,
    user,
    onFileProcessed,
    setIsProcessing,
    setUploadProgress,
    setUploadTime,
    effectiveAssistantId,
    effectiveVectorStoreId,
  ]);

  // =========================================================================
  // Get current transcription state (for the active transcript tab)
  // =========================================================================
  const currentState = activeTranscriptTab === 'youtube' ? ytTranscription : audioTranscription;

  // =========================================================================
  // RENDER
  // =========================================================================
  return (
    <div className={styles.wrapper}>
      {/* ---- Tab Bar ---- */}
      <div className={styles.tabBar}>
        {tabs.map((tab) => (
          <button
            key={tab.id}
            className={`${styles.tab} ${activeTab === tab.id ? styles.tabActive : ''}`}
            onClick={() => setActiveTab(tab.id)}
          >
            <span className={styles.tabIcon}>{tab.icon}</span>
            {tab.label}
          </button>
        ))}
      </div>

      {/* ---- Tab Content ---- */}
      <div className={styles.tabContent}>
        {/* ===== PDF Tab ===== */}
        {activeTab === 'pdf' && (
          <AssistantManager
            onFileProcessed={onFileProcessed}
            setIsProcessing={setIsProcessing}
            setUploadProgress={setUploadProgress}
            setUploadTime={setUploadTime}
            disabled={disabled}
            assistantId={propAssistantId}
            vectorStoreId={propVectorStoreId}
          />
        )}

        {/* ===== YouTube Tab ===== */}
        {activeTab === 'youtube' && (
          <div className={styles.ytPanel}>
            <p className={styles.panelDesc}>
              贴上 YouTube 影片链接，系统将自动获取字幕文字。
              <br />
              <span className={styles.panelHint}>
                支持官方字幕与自动生成字幕；若影片无字幕，将自动下载音频并使用 AI 语音转录。
                <br />
                影片时长上限：120 分钟。超过时请使用「指定转录片段」功能选取部分内容。
              </span>
            </p>

            <div className={styles.ytInputRow}>
              <input
                type="text"
                className={styles.ytInput}
                placeholder="https://www.youtube.com/watch?v=..."
                value={ytUrl}
                onChange={(e) => setYtUrl(e.target.value)}
                disabled={
                  disabled ||
                  ytTranscription.status === 'loading' ||
                  ytTranscription.status === 'uploading'
                }
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleYouTubeFetch();
                }}
              />
              <button
                className={styles.ytFetchBtn}
                onClick={handleYouTubeFetch}
                disabled={
                  disabled ||
                  !ytUrl.trim() ||
                  ytTranscription.status === 'loading' ||
                  ytTranscription.status === 'uploading'
                }
              >
                {ytTranscription.status === 'loading' ? '处理中...' : '获取字幕'}
              </button>
            </div>

            {/* ---- 時段選擇器 ---- */}
            <div className={styles.ytSegmentToggle}>
              <button
                type="button"
                className={`${styles.ytSegmentBtn} ${ytShowSegment ? styles.ytSegmentBtnActive : ''}`}
                onClick={() => setYtShowSegment((v) => !v)}
                disabled={
                  disabled ||
                  ytTranscription.status === 'loading' ||
                  ytTranscription.status === 'uploading'
                }
              >
                ✂️ {ytShowSegment ? '隱藏片段設定' : '指定轉錄片段（可選）'}
              </button>
            </div>
            {ytShowSegment && (
              <div className={styles.ytSegmentRow}>
                <span className={styles.ytSegmentLabel}>開始</span>
                <input
                  type="text"
                  inputMode="numeric"
                  autoComplete="off"
                  maxLength={8}
                  className={styles.ytSegmentInput}
                  placeholder="00:00:00"
                  value={ytStartTime}
                  onChange={(e) => setYtStartTime(formatTimeMask(e.target.value, ytStartTime))}
                  disabled={
                    disabled ||
                    ytTranscription.status === 'loading' ||
                    ytTranscription.status === 'uploading'
                  }
                />
                <span className={styles.ytSegmentArrow}>→</span>
                <span className={styles.ytSegmentLabel}>結束</span>
                <input
                  type="text"
                  inputMode="numeric"
                  autoComplete="off"
                  maxLength={8}
                  className={styles.ytSegmentInput}
                  placeholder="00:00:00"
                  value={ytEndTime}
                  onChange={(e) => setYtEndTime(formatTimeMask(e.target.value, ytEndTime))}
                  disabled={
                    disabled ||
                    ytTranscription.status === 'loading' ||
                    ytTranscription.status === 'uploading'
                  }
                />
                <span className={styles.ytSegmentHint}>格式 HH:MM:SS，留空表示從頭 / 到結尾</span>
              </div>
            )}

            {/* Status messages */}
            {ytTranscription.status === 'loading' && (
              <div className={styles.statusLoading}>
                <span className={styles.spinner}>⟳</span> {ytTranscription.message}
              </div>
            )}
            {ytTranscription.status === 'uploading' && (
              <div className={styles.statusLoading}>
                <span className={styles.spinner}>⟳</span> {ytTranscription.message}
              </div>
            )}
            {ytTranscription.status === 'error' && (
              <div className={styles.statusError}>{ytTranscription.message}</div>
            )}
            {ytTranscription.status === 'done' && (
              <div className={styles.statusDone}>
                ✅ 字幕获取完成（{ytTranscription.charCount} 字）。请在下方审阅文字，确认无误后点击「确认并生成」。
              </div>
            )}
          </div>
        )}

        {/* ===== Audio Tab ===== */}
        {activeTab === 'audio' && (
          <div className={styles.audioPanel}>
            <p className={styles.panelDesc}>
              上传音频文件，系统将使用 AI 语音识别自动转录为文字。
              <br />
              <span className={styles.panelHint}>
                支持格式：mp3、wav、m4a、mp4、webm、ogg（最大 200MB，约 160 分钟）
              </span>
            </p>

            {/* Drop zone */}
            <input
              ref={audioInputRef}
              type="file"
              accept=".mp3,.wav,.m4a,.mp4,.webm,.ogg"
              style={{ display: 'none' }}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) handleAudioFile(file);
                e.target.value = '';
              }}
              disabled={
                disabled ||
                audioTranscription.status === 'loading' ||
                audioTranscription.status === 'uploading'
              }
            />
            <div
              className={`${styles.audioDropZone} ${audioDragging ? styles.audioDropZoneDragging : ''} ${
                disabled || audioTranscription.status === 'loading' || audioTranscription.status === 'uploading'
                  ? styles.audioDropZoneDisabled
                  : ''
              }`}
              onDragEnter={onAudioDragEnter}
              onDragLeave={onAudioDragLeave}
              onDragOver={onAudioDragOver}
              onDrop={onAudioDrop}
              onClick={() => {
                if (
                  !disabled &&
                  audioTranscription.status !== 'loading' &&
                  audioTranscription.status !== 'uploading'
                ) {
                  audioInputRef.current?.click();
                }
              }}
            >
              <span className={styles.audioDropIcon}>🎙️</span>
              <span className={styles.audioDropMain}>
                {audioDragging ? '放开以上传' : '点击或拖放音频文件到此处'}
              </span>
              <span className={styles.audioDropSub}>mp3、wav、m4a、mp4、webm、ogg（最大 200MB，约 160 分钟）</span>
            </div>

            {/* Status messages */}
            {audioTranscription.status === 'loading' && (
              <div className={styles.statusLoading}>
                <span className={styles.spinner}>⟳</span> {audioTranscription.message}
              </div>
            )}
            {audioTranscription.status === 'uploading' && (
              <div className={styles.statusLoading}>
                <span className={styles.spinner}>⟳</span> {audioTranscription.message}
              </div>
            )}
            {audioTranscription.status === 'error' && (
              <div className={styles.statusError}>{audioTranscription.message}</div>
            )}
            {audioTranscription.status === 'done' && (
              <div className={styles.statusDone}>
                ✅ 转录完成（{audioTranscription.charCount} 字）。请在下方审阅文字，确认无误后点击「确认并生成」。
              </div>
            )}
          </div>
        )}
      </div>

      {/* ---- Transcript Review (shared for YouTube & Audio) ---- */}
      {currentState.status === 'done' && activeTranscriptTab && (
        <div className={styles.reviewSection}>
          <div className={styles.reviewHeader}>
            <h4 className={styles.reviewTitle}>
              {currentState.source === 'caption' ? '📝 字幕文字' : '📝 转录文字'}
              <span className={styles.reviewBadge}>
                {currentState.source === 'caption' ? 'YouTube 字幕' : 'Whisper 转录'}
              </span>
            </h4>
            <span className={styles.charCount}>{editedText.length} 字</span>
          </div>

          <textarea
            className={styles.reviewTextarea}
            value={editedText}
            onChange={(e) => setEditedText(e.target.value)}
            rows={12}
            placeholder="转录文字将显示在此处..."
          />

          <div className={styles.reviewActions}>
            <button
              className={styles.reviewCancelBtn}
              onClick={() => {
                if (activeTranscriptTab === 'youtube') {
                  setYtTranscription({ status: 'idle' });
                } else {
                  setAudioTranscription({ status: 'idle' });
                }
                setActiveTranscriptTab(null);
                setEditedText('');
              }}
            >
              取消
            </button>
            <button
              className={styles.reviewConfirmBtn}
              onClick={handleConfirmAndUpload}
              disabled={disabled || !editedText.trim()}
            >
              ✓ 确认并上传生成讲章
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
