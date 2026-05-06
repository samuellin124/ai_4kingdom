'use client';

import Script from 'next/script';
import { useState, useEffect, useRef } from 'react';
import SermonInputTabs from '../components/SermonInputTabs';
import WithChat from '../components/layouts/WithChat';
import ChatkitEmbed from '../components/ChatkitEmbed';
import UserIdDisplay from '../components/UserIdDisplay';
import PromoSegmentEditor from '../components/PromoSegmentEditor';
import { useCredit } from '../contexts/CreditContext';
import { useAuth } from '../contexts/AuthContext';
import { ASSISTANT_IDS, VECTOR_STORE_IDS } from '../config/constants';
import { CHAT_TYPES } from '../config/chatTypes';
import ReactMarkdown from 'react-markdown';
import styles from './SundayGuide.module.css';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ProcessedContent {
  summary: string;
  fullText: string;
  devotional: string;
  bibleStudy: string;
}

interface PromoShot {
  tStart: number;
  tEnd: number;
  visual: string;
  overlayText: string;
  camera: string;
}

interface PromoScript {
  hook: string;
  body: string;
  cta: string;
  voiceover: string;
  shots: PromoShot[];
}

interface PromoVideoResult {
  renderPrompt: string;
  recommendedTools: string[];
  videoUrl: string | null;
  audioUrl?: string | null;
  thumbnailUrl: string | null;
  exportSpec: {
    aspectRatio: string;
    resolution: string;
    width: number;
    height: number;
    durationSec: number;
    fps: number;
  };
}

interface PromoSegment {
  segmentIndex: number;
  durationSec: number;
  aspectRatio: '16:9';
  chineseCaption: string;
  voiceoverText: string;
  soraPrompt: string;
  editableFields: {
    caption?: string;
    voiceover?: string;
    soraPrompt?: string;
  };
}

type GuideMode = 'summary' | 'text' | 'devotional' | 'bible' | null;

// ---------------------------------------------------------------------------
// Main Content Component
// ---------------------------------------------------------------------------

function SundayGuideContent() {
  const { refreshUsage, hasInsufficientTokens, remainingCredits } = useCredit();
  const { user, canUploadFiles } = useAuth();

  // ---- Upload states ----
  const [isProcessing, setIsProcessing] = useState(false);
  const [processedContent, setProcessedContent] = useState<ProcessedContent | null>(null);
  const [uploadProgress, setUploadProgress] = useState<number>(0);
  const [uploadTime, setUploadTime] = useState<string>('');
  const [isUploadDisabled, setIsUploadDisabled] = useState(false);

  // ---- Documents list states ----
  const [allFiles, setAllFiles] = useState<
    Array<{ fileName: string; sermonTitle?: string | null; uploadDate: string; fileId: string; uploaderId?: string }>
  >([]);
  const [selectedFileId, setSelectedFileId] = useState<string | null>(null);
  const [selectedFileName, setSelectedFileName] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [editingFileId, setEditingFileId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState('');
  const [allowedUploaders, setAllowedUploaders] = useState<string[]>([]);
  const [currentPage, setCurrentPage] = useState(1);
  const filesPerPage = 10;
  const totalPages = Math.ceil(allFiles.length / filesPerPage);
  const recentFiles = allFiles.slice((currentPage - 1) * filesPerPage, currentPage * filesPerPage);

  // ---- Guide navigator states ----
  const [selectedMode, setSelectedMode] = useState<GuideMode>(null);
  const [sermonContent, setSermonContent] = useState<string | null>(null);
  const [contentLoading, setContentLoading] = useState(false);
  const [pdfLoading, setPdfLoading] = useState(false);
  const [pdfError, setPdfError] = useState<string | null>(null);
  const [promoScriptLoading, setPromoScriptLoading] = useState(false);
  const [promoScriptError, setPromoScriptError] = useState<string | null>(null);
  const [promoScript, setPromoScript] = useState<PromoScript | null>(null);
  const [promoVideoCreating, setPromoVideoCreating] = useState(false);
  const [promoVideoPolling, setPromoVideoPolling] = useState(false);
  const [promoVideoStatus, setPromoVideoStatus] = useState<string | null>(null);
  const [promoVideoError, setPromoVideoError] = useState<string | null>(null);
  const [promoVideoJobId, setPromoVideoJobId] = useState<string | null>(null);
  const [promoVideoResult, setPromoVideoResult] = useState<PromoVideoResult | null>(null);

  // ---- Promo segment states (新增) ----
  const [promoSegments, setPromoSegments] = useState<PromoSegment[]>([]);
  const [promoSegmentsLoading, setPromoSegmentsLoading] = useState(false);
  const [segmentResults, setSegmentResults] = useState<Record<number, PromoVideoResult | null>>({});
  const [segmentLoadings, setSegmentLoadings] = useState<Record<number, boolean>>({});
  const [segmentGeneratingJobIds, setSegmentGeneratingJobIds] = useState<Record<number, string>>({});
  const [segmentAudioUrls, setSegmentAudioUrls] = useState<Record<number, string | null>>({});
  const segmentPollingTimersRef = useRef<Record<number, ReturnType<typeof setInterval>>>({});
  const contentRef = useRef<HTMLDivElement>(null);
  const promoPollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const devSkip = process.env.NEXT_PUBLIC_DEV_SKIP_AUTH === 'true';
  const enablePromo = process.env.NEXT_PUBLIC_ENABLE_PROMO === 'true';
  const promoProvider = (process.env.NEXT_PUBLIC_PROMO_VIDEO_PROVIDER || 'sora') as 'mock' | 'runway' | 'luma' | 'sora' | 'openai';
  const hasUploadPermission = devSkip || !!user;

  // Whether any file is selected (controls guide section visibility)
  const hasFileSelected = !!selectedFileId;

  const resetPromoState = () => {
    if (promoPollTimerRef.current) {
      clearInterval(promoPollTimerRef.current);
      promoPollTimerRef.current = null;
    }
    setPromoScriptError(null);
    setPromoScript(null);
    setPromoVideoError(null);
    setPromoVideoStatus(null);
    setPromoVideoResult(null);
    setPromoVideoJobId(null);
    setPromoVideoCreating(false);
    setPromoVideoPolling(false);
  };

  // ---- Promo Segments (新增) ----
  const handleGeneratePromoSegments = async () => {
    if (!sermonContent || selectedMode !== 'summary') return;

    setPromoSegmentsLoading(true);
    setPromoSegments([]);
    setSegmentResults({});
    setSegmentLoadings({});
    setSegmentGeneratingJobIds({});

    try {
      const res = await fetch('/api/sunday-guide/promo-video-segments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          summary: sermonContent,
          tone: 'inspiring',
          durationSec: 60, // 5 segments × 12s each (minimum 8s per segment)
        }),
      });

      const data = await res.json().catch(() => ({}));

      if (!res.ok || !data?.segments) {
        throw new Error(data?.message || data?.error || `生成分段失败（${res.status}）`);
      }

      setPromoSegments(data.segments);
    } catch (error) {
      alert(error instanceof Error ? error.message : '生成分段失败');
    } finally {
      setPromoSegmentsLoading(false);
    }
  };

  const handleSegmentChange = (index: number, field: string, value: string) => {
    setPromoSegments((prev) =>
      prev.map((segment, idx) =>
        idx === index
          ? {
              ...segment,
              editableFields: { ...segment.editableFields, [field]: value },
            }
          : segment
      )
    );
  };

  const startSegmentPolling = (segmentIndex: number, jobId: string) => {
    if (segmentPollingTimersRef.current[segmentIndex]) {
      clearInterval(segmentPollingTimersRef.current[segmentIndex]);
    }

    setSegmentLoadings((prev) => ({ ...prev, [segmentIndex]: true }));

    segmentPollingTimersRef.current[segmentIndex] = setInterval(async () => {
      try {
        const statusRes = await fetch(`/api/sunday-guide/promo-video?jobId=${encodeURIComponent(jobId)}`);
        const statusData = await statusRes.json().catch(() => ({}));

        if (!statusRes.ok) {
          clearInterval(segmentPollingTimersRef.current[segmentIndex]);
          delete segmentPollingTimersRef.current[segmentIndex];
          setSegmentLoadings((prev) => ({ ...prev, [segmentIndex]: false }));
          return;
        }

        const status = statusData?.status as string | undefined;
        if (status === 'done') {
          setSegmentResults((prev) => ({
            ...prev,
            [segmentIndex]: statusData?.result || null,
          }));
          if (statusData?.result?.audioUrl) {
            setSegmentAudioUrls((prev) => ({
              ...prev,
              [segmentIndex]: statusData.result.audioUrl,
            }));
          }
          clearInterval(segmentPollingTimersRef.current[segmentIndex]);
          delete segmentPollingTimersRef.current[segmentIndex];
          setSegmentLoadings((prev) => ({ ...prev, [segmentIndex]: false }));
        } else if (status === 'error') {
          clearInterval(segmentPollingTimersRef.current[segmentIndex]);
          delete segmentPollingTimersRef.current[segmentIndex];
          setSegmentLoadings((prev) => ({ ...prev, [segmentIndex]: false }));
        }
      } catch (error) {
        console.error(`[segment ${segmentIndex}] polling error:`, error);
      }
    }, 5000); // Poll every 5 seconds
  };

  const handleGenerateSegmentVideo = async (segmentIndex: number) => {
    const segment = promoSegments[segmentIndex];
    if (!segment) return;

    setSegmentLoadings((prev) => ({ ...prev, [segmentIndex]: true }));

    const segmentPrompt = (segment.editableFields.soraPrompt || segment.soraPrompt || '').trim();
    const safeSegmentPrompt =
      segmentPrompt ||
      `Cinematic church promo segment, inspiring tone, 16:9, 1280x720, ${segment.durationSec}s, Chinese subtitle: ${(segment.editableFields.caption || segment.chineseCaption || '本週主日重點').slice(0, 20)}`;

    try {
      const res = await fetch('/api/sunday-guide/promo-video', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: 'sora',
          durationSec: segment.durationSec,
          segmentIndex,
          segmentPrompt: safeSegmentPrompt,
          voiceoverText: segment.editableFields.voiceover || segment.voiceoverText,
        }),
      });

      const data = await res.json().catch(() => ({}));

      if (!res.ok || !data?.jobId) {
        throw new Error(data?.message || data?.error || `建立影片任務失敗（${res.status}）`);
      }

      setSegmentGeneratingJobIds((prev) => ({
        ...prev,
        [segmentIndex]: data.jobId,
      }));
      startSegmentPolling(segmentIndex, data.jobId);
    } catch (error) {
      alert(error instanceof Error ? error.message : '建立影片任務失敗');
      setSegmentLoadings((prev) => ({ ...prev, [segmentIndex]: false }));
    }
  };

  // ---- Credit check ----
  useEffect(() => {
    setIsUploadDisabled(remainingCredits <= 0);
  }, [remainingCredits, hasInsufficientTokens]);

  // ---- Fetch browsable documents (all at once, client-side pagination) ----
  const fetchAllFileRecords = async () => {
    try {
      const response = await fetch(
        `/api/sunday-guide/documents?assistantId=${ASSISTANT_IDS.SUNDAY_GUIDE}&allUsers=true`
      );
      if (!response.ok) throw new Error('獲取文件記錄失敗');
      const data = await response.json();
      if (data.success && data.records) {
        const sortedFiles = data.records.sort(
          (a: any, b: any) =>
            new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
        );
        setAllFiles(sortedFiles.map((rec: any) => ({
          fileName: rec.fileName || '未命名文件',
          sermonTitle: rec.sermonTitle || null,
          uploadDate: new Date(rec.createdAt).toLocaleDateString('zh-TW'),
          fileId: rec.fileId || '',
          uploaderId: rec.userId || '未知用戶',
        })));
        setCurrentPage(1);
      } else {
        setAllFiles([]);
      }
    } catch (error) {
      console.error('獲取文件記錄失敗:', error);
      setAllFiles([]);
    }
  };

  const handleRenameTitle = async (fileId: string, newTitle: string) => {
    if (!user?.user_id || !newTitle.trim()) { setEditingFileId(null); return; }
    const file = allFiles.find(f => f.fileId === fileId);
    const currentTitle = file?.sermonTitle || file?.fileName || '';
    if (newTitle.trim() === currentTitle) { setEditingFileId(null); return; }
    try {
      const res = await fetch('/api/sunday-guide/documents', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileId, unitId: 'default', userId: user.user_id, sermonTitle: newTitle.trim() }),
      });
      const data = await res.json();
      if (res.ok && data.success) {
        setAllFiles(prev => prev.map(f => f.fileId === fileId ? { ...f, sermonTitle: data.sermonTitle } : f));
      } else {
        alert('更新失敗: ' + (data.error || res.status));
      }
    } catch (e: any) {
      alert('更新時發生錯誤: ' + (e.message || '未知錯誤'));
    } finally {
      setEditingFileId(null);
    }
  };

  // ---- Initial load ----
  useEffect(() => {
    fetchAllFileRecords();
    fetch('/api/admin/sunday-guide-units')
      .then(r => r.json())
      .then(data => { if (data.success) setAllowedUploaders(data.data.units.default.allowedUploaders ?? []); })
      .catch(() => {});
  }, [user]);

  useEffect(() => {
    return () => {
      if (promoPollTimerRef.current) {
        clearInterval(promoPollTimerRef.current);
        promoPollTimerRef.current = null;
      }
      // Cleanup segment polling timers
      Object.values(segmentPollingTimersRef.current).forEach((timer) => {
        clearInterval(timer);
      });
      segmentPollingTimersRef.current = {};
    };
  }, []);

  // ---- Upload completed callback ----
  const handleFileProcessed = async (content: ProcessedContent) => {
    setProcessedContent(content);
    setIsProcessing(false);
    await fetchAllFileRecords();
    await refreshUsage();
  };

  // ---- Delete file ----
  const handleDelete = async (fileId: string, uploaderId?: string) => {
    if (!user?.user_id || !fileId) return;
    if (!confirm('確定刪除此文件記錄？此操作不可回復。')) return;

    try {
      setDeletingId(fileId);
      const qs = new URLSearchParams({ fileId, unitId: 'default', userId: user.user_id });
      const res = await fetch(`/api/sunday-guide/documents?${qs.toString()}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok || !data.success) {
        alert('刪除失敗: ' + (data.error || res.status));
      } else {
        await fetchAllFileRecords();
        if (selectedFileId === fileId) {
          setSelectedFileId(null);
          setSelectedFileName(null);
          setSermonContent(null);
          setSelectedMode(null);
        }
      }
    } catch (e: any) {
      alert('刪除時發生錯誤: ' + (e.message || '未知錯誤'));
    } finally {
      setDeletingId(null);
    }
  };

  // ---- Select file from list ----
  const handleSelectFile = (fileId: string, fileName: string) => {
    setSelectedFileId(fileId);
    setSelectedFileName(fileName);
    // Reset content when switching files
    setSermonContent(null);
    setSelectedMode(null);
    resetPromoState();
  };

  // ---- Guide mode selection ----
  const handleModeSelect = async (mode: GuideMode) => {
    if (!selectedFileId) return;
    if (mode !== 'summary') resetPromoState();
    setSelectedMode(mode);
    setContentLoading(true);
    try {
      const userId = user?.user_id || '';
      const apiUrl = `/api/sunday-guide/content/${ASSISTANT_IDS.SUNDAY_GUIDE}?type=${mode}&userId=${encodeURIComponent(userId)}&fileId=${encodeURIComponent(selectedFileId)}`;
      const response = await fetch(apiUrl);

      if (response.status === 202) {
        const data = await response.json();
        alert(data.error || '內容正在生成中，請稍候...');
        return;
      }
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ error: '未知錯誤' }));
        throw new Error(errorData.error || `獲取內容失敗: ${response.status}`);
      }

      const data = await response.json();
      setSermonContent(data.content);
      await refreshUsage();
    } catch (error) {
      console.error('獲取內容失敗:', error);
      alert(`獲取內容失敗: ${error instanceof Error ? error.message : '請稍後重試'}`);
    } finally {
      setContentLoading(false);
    }
  };

  // ---- Download full version ----
  const handleDownloadPDF = () => {
    setPdfError(null);
    setPdfLoading(true);
    try {
      const userId = user?.user_id || '';
      let downloadUrl = `/api/sunday-guide/download-pdf?includeAll=true&userId=${encodeURIComponent(userId)}&assistantId=${ASSISTANT_IDS.SUNDAY_GUIDE}`;
      if (selectedFileId) {
        downloadUrl += `&fileId=${encodeURIComponent(selectedFileId)}`;
      }
      window.open(downloadUrl, '_blank');
      setTimeout(() => setPdfLoading(false), 1000);
    } catch (error) {
      setPdfError(error instanceof Error ? error.message : '下載完整版PDF時發生錯誤，請重試');
      setPdfLoading(false);
    }
  };

  const handleGeneratePromoScript = async () => {
    if (!sermonContent || selectedMode !== 'summary') return;

    setPromoScriptLoading(true);
    setPromoScriptError(null);
    setPromoVideoError(null);
    setPromoVideoResult(null);
    setPromoVideoJobId(null);
    setPromoVideoStatus(null);

    try {
      const res = await fetch('/api/sunday-guide/promo-script', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          summary: sermonContent,
          tone: 'inspiring',
          durationSec: 5,
          aspectRatio: '16:9',
          resolution: '720p',
        }),
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok || !data?.script) {
        throw new Error(data?.message || data?.error || `生成脚本失败（${res.status}）`);
      }

      setPromoScript(data.script as PromoScript);
    } catch (error) {
      setPromoScriptError(error instanceof Error ? error.message : '生成脚本失败');
    } finally {
      setPromoScriptLoading(false);
    }
  };

  const stopPromoPolling = () => {
    if (promoPollTimerRef.current) {
      clearInterval(promoPollTimerRef.current);
      promoPollTimerRef.current = null;
    }
    setPromoVideoPolling(false);
  };

  const startPromoPolling = (jobId: string) => {
    if (promoPollTimerRef.current) {
      clearInterval(promoPollTimerRef.current);
      promoPollTimerRef.current = null;
    }

    setPromoVideoPolling(true);
    promoPollTimerRef.current = setInterval(async () => {
      try {
        const statusRes = await fetch(`/api/sunday-guide/promo-video?jobId=${encodeURIComponent(jobId)}`);
        const statusData = await statusRes.json().catch(() => ({}));

        if (!statusRes.ok) {
          setPromoVideoError(statusData?.message || statusData?.error || '查询影片状态失败');
          setPromoVideoStatus('error');
          stopPromoPolling();
          return;
        }

        const status = statusData?.status as string | undefined;
        if (!status) {
          setPromoVideoError('影片状态响应异常');
          setPromoVideoStatus('error');
          stopPromoPolling();
          return;
        }

        setPromoVideoStatus(status);

        if (status === 'done') {
          setPromoVideoResult((statusData?.result || null) as PromoVideoResult | null);
          stopPromoPolling();
          return;
        }

        if (status === 'error') {
          setPromoVideoError(statusData?.error || '影片生成失败');
          stopPromoPolling();
        }
      } catch (error) {
        setPromoVideoError(error instanceof Error ? error.message : '查询影片状态失败');
        setPromoVideoStatus('error');
        stopPromoPolling();
      }
    }, 2000);
  };

  const handleGeneratePromoVideo = async () => {
    if (!sermonContent || selectedMode !== 'summary') return;

    setPromoVideoCreating(true);
    setPromoVideoError(null);
    setPromoVideoResult(null);
    setPromoVideoStatus('queued');
    setPromoVideoJobId(null);

    try {
      const res = await fetch('/api/sunday-guide/promo-video', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          summary: sermonContent,
          script: promoScript,
          provider: promoProvider,
          durationSec: 5,
          aspectRatio: '16:9',
          resolution: '720p',
        }),
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok || !data?.jobId) {
        throw new Error(data?.message || data?.error || `建立影片任务失败（${res.status}）`);
      }

      const jobId = String(data.jobId);
      setPromoVideoJobId(jobId);
      setPromoVideoStatus(String(data.status || 'queued'));
      startPromoPolling(jobId);
    } catch (error) {
      setPromoVideoError(error instanceof Error ? error.message : '建立影片任务失败');
      setPromoVideoStatus('error');
      stopPromoPolling();
    } finally {
      setPromoVideoCreating(false);
    }
  };

  // ---- Render guide content ----
  const renderContent = () => {
    if (contentLoading) return <div className={styles.loading}>載入中，請稍候...</div>;
    if (!sermonContent) return null;
    const titles: Record<string, string> = {
      summary: '讲道总结',
      text: '信息文字',
      devotional: '每日灵修',
      bible: '查经指引',
    };
    return (
      <div className={styles.contentBox}>
        <div className={styles.contentHeader}>
          <h2>{titles[selectedMode!]}</h2>
          <button className={styles.downloadButton} onClick={handleDownloadPDF} disabled={pdfLoading}>
            {pdfLoading ? '生成預覽中...' : '下载完整版(简体中文)'}
          </button>
        </div>
        {pdfError && <div className={styles.errorMessage}>{pdfError}</div>}
        <div className={styles.markdownContent} ref={contentRef}>
          <ReactMarkdown>{sermonContent}</ReactMarkdown>
        </div>

        {selectedMode === 'summary' && enablePromo && (
          <div className={styles.promoPanel}>
          <div className={styles.promoHeader}>
              <h3 className={styles.promoTitle}>短影音 Promo（16:9 / 720p）</h3>
              <p className={styles.promoHint}>拆分為 5 段影片，預設各約 12 秒，且每一片段至少 8 秒。支援 Sora 生成、中文字幕與配音。</p>
            </div>

            <div className={styles.promoActions}>
              <button
                className={styles.promoPrimaryBtn}
                onClick={handleGeneratePromoSegments}
                disabled={promoSegmentsLoading || contentLoading || !sermonContent}
              >
                {promoSegmentsLoading ? '拆分中...' : '📋 拆分成 5 段'}
              </button>
            </div>

            {promoScriptError && <div className={styles.errorMessage}>{promoScriptError}</div>}
            {promoVideoError && <div className={styles.errorMessage}>{promoVideoError}</div>}

            {(promoVideoStatus || promoVideoJobId) && (
              <div className={styles.promoStatusBar}>
                <span>任务状态：{promoVideoStatus || 'queued'}</span>
                {promoVideoJobId && <span>Job ID：{promoVideoJobId}</span>}
              </div>
            )}

            {promoScript && (
              <div className={styles.promoCard}>
                <h4 className={styles.promoCardTitle}>脚本预览</h4>
                <div className={styles.promoScriptLine}><strong>Hook：</strong>{promoScript.hook}</div>
                <div className={styles.promoScriptLine}><strong>Body：</strong>{promoScript.body}</div>
                <div className={styles.promoScriptLine}><strong>CTA：</strong>{promoScript.cta}</div>
                <div className={styles.promoScriptLine}><strong>旁白：</strong>{promoScript.voiceover}</div>

                {promoScript.shots?.length > 0 && (
                  <div className={styles.promoShotList}>
                    {promoScript.shots.map((shot, idx) => (
                      <div key={`${shot.tStart}-${shot.tEnd}-${idx}`} className={styles.promoShotItem}>
                        <div className={styles.promoShotTime}>{shot.tStart}s - {shot.tEnd}s</div>
                        <div className={styles.promoShotText}>{shot.visual}</div>
                        <div className={styles.promoShotOverlay}>字幕：{shot.overlayText}</div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {promoVideoResult && (
              <div className={styles.promoCard}>
                <h4 className={styles.promoCardTitle}>影片任务结果</h4>
                <div className={styles.promoScriptLine}>
                  <strong>建议工具：</strong>{promoVideoResult.recommendedTools.join(' / ')}
                </div>
                <div className={styles.promoScriptLine}>
                  <strong>输出规格：</strong>
                  {promoVideoResult.exportSpec.aspectRatio}，
                  {promoVideoResult.exportSpec.resolution}（{promoVideoResult.exportSpec.width}x{promoVideoResult.exportSpec.height}），
                  {promoVideoResult.exportSpec.durationSec}s @ {promoVideoResult.exportSpec.fps}fps
                </div>
                <pre className={styles.promoPrompt}>{promoVideoResult.renderPrompt}</pre>
                {!promoVideoResult.videoUrl && (
                  <div className={styles.promoPlaceholder}>
                    当前为 skeleton 模式（mock provider），已回传可直接用于 Runway/Luma 的 prompt。
                  </div>
                )}
                {promoVideoResult.videoUrl && (
                  <video className={styles.promoVideo} controls src={promoVideoResult.videoUrl} />
                )}
              </div>
            )}

            {/* ---- 分段編輯器 ---- */}
            {promoSegments.length > 0 && (
              <div className={styles.promoCard}>
                <h4 className={styles.promoCardTitle}>📺 5 段影片編輯器</h4>
                <p style={{ fontSize: '12px', color: '#6b7280', marginBottom: '16px' }}>
                  編輯每段的字幕、旁白和 Sora 提示符，然後逐段點擊「生成此段影片」
                </p>
                <PromoSegmentEditor
                  segments={promoSegments}
                  onSegmentChange={handleSegmentChange}
                  onGenerateSegment={handleGenerateSegmentVideo}
                  segmentResults={segmentResults}
                  loadingSegments={segmentLoadings}
                  audioUrls={segmentAudioUrls}
                />
              </div>
            )}
          </div>
        )}
      </div>
    );
  };

  // =========================================================================
  // RENDER
  // =========================================================================
  return (
    <div className={styles.container}>
      <Script src="https://cdn.platform.openai.com/deployments/chatkit/chatkit.js" strategy="afterInteractive" />
      <UserIdDisplay />

      {/* =============== 1. Upload Section =============== */}
      {hasUploadPermission && (
        <section className={styles.uploadHero}>
          <h2 className={styles.uploadHeroTitle}>上传讲章</h2>
          <p className={styles.uploadHeroDesc}>
            上传主日讲章文件，系统将自动生成<strong>信息总结</strong>、<strong>每日灵修</strong>与<strong>查经指引</strong>。
            <br />
            支持格式：<strong>PDF / 文件</strong>、<strong>YouTube 链接</strong>、<strong>音频文件</strong>
          </p>

          {isUploadDisabled && (
            <span className={styles.creditWarningInline}>额度不足，无法上传</span>
          )}
          {!isUploadDisabled && remainingCredits > 0 && remainingCredits < 20 && (
            <span className={styles.creditWarningInline} style={{ background: '#fef3c7', color: '#92400e' }}>
              余额较低 ({remainingCredits})
            </span>
          )}

          <div className={styles.uploadArea}>
            <SermonInputTabs
              onFileProcessed={handleFileProcessed}
              setIsProcessing={setIsProcessing}
              setUploadProgress={setUploadProgress}
              setUploadTime={setUploadTime}
              disabled={isUploadDisabled}
              unitId="default"
            />
          </div>

          {isProcessing && (
            <div className={styles.processingAlert}>
              <p>处理中，约需 3-5 分钟，请勿关闭页面...</p>
            </div>
          )}
          {uploadTime && (
            <span className={styles.uploadTimeBadge}>✓ 完成于 {uploadTime}</span>
          )}
        </section>
      )}

      {/* =============== 2. Sidebar + Main Layout =============== */}
      <div className={styles.mainLayout}>
        {/* ---- Left Sidebar: 文檔列表 ---- */}
        <aside className={styles.docsSection}>
          <h4 className={styles.docsSectionTitle}>
            📚 文档列表
            <span className={styles.docsSectionHint}>— 选择一份讲章</span>
            <span style={{ fontSize: '0.7em', fontWeight: 'normal', color: '#888', marginLeft: '6px' }}>按上传日期↓</span>
          </h4>

          {recentFiles.length === 0 ? (
            <div className={styles.noDocs}>暂无文档</div>
          ) : (
            <>
              <ul className={styles.docsListScrollable}>
                {recentFiles.map((file, idx) => (
                  <li
                    key={file.fileId || idx}
                    className={`${styles.docItem} ${selectedFileId === file.fileId ? styles.docItemSelected : ''}`}
                    onClick={() => handleSelectFile(file.fileId, file.fileName.toLowerCase().endsWith('.pdf') ? file.fileName : (file.sermonTitle || file.fileName))}
                    title="点击选择此文档"
                  >
                    {/* Delete button: only visible for own uploads, placed first */}
                    {file.uploaderId &&
                      user?.user_id &&
                      file.uploaderId.toString() === user.user_id.toString() ? (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDelete(file.fileId, file.uploaderId);
                          }}
                          disabled={deletingId === file.fileId}
                          className={styles.deleteButton}
                          title="删除此文档"
                        >
                          {deletingId === file.fileId ? '...' : '×'}
                        </button>
                      ) : (
                        <span className={styles.deleteButtonPlaceholder} />
                      )}
                    <span className={styles.docIndex}>
                      {(currentPage - 1) * filesPerPage + idx + 1}.
                    </span>
                    {editingFileId === file.fileId ? (
                      <input
                        className={styles.docTitleInput}
                        value={editingTitle}
                        autoFocus
                        onChange={e => setEditingTitle(e.target.value)}
                        onBlur={() => handleRenameTitle(file.fileId, editingTitle)}
                        onKeyDown={e => {
                          if (e.key === 'Enter') handleRenameTitle(file.fileId, editingTitle);
                          if (e.key === 'Escape') setEditingFileId(null);
                        }}
                        onClick={e => e.stopPropagation()}
                      />
                    ) : (
                      <>
                        <span className={styles.docFileName}>{file.fileName.toLowerCase().endsWith('.pdf') ? file.fileName : (file.sermonTitle || file.fileName)}</span>
                        {user?.user_id && (file.uploaderId?.toString() === user.user_id.toString() || allowedUploaders.includes(user.user_id)) && (
                          <button
                            className={styles.editTitleButton}
                            title="編輯標題"
                            onClick={e => {
                              e.stopPropagation();
                              setEditingTitle(file.sermonTitle || file.fileName);
                              setEditingFileId(file.fileId);
                            }}
                          >✎</button>
                        )}
                      </>
                    )}
                    <span className={styles.docDate}>{file.uploadDate}</span>
                  </li>
                ))}
              </ul>

              {/* Pagination */}
              {allFiles.length > 0 && (
                <div className={styles.pagination}>
                  <button
                    onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                    disabled={currentPage === 1}
                    className={styles.paginationButton}
                  >
                    ←
                  </button>
                  <span className={styles.paginationInfo}>
                    {currentPage} / {totalPages}
                  </span>
                  <button
                    onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                    disabled={currentPage === totalPages}
                    className={styles.paginationButton}
                  >
                    →
                  </button>
                </div>
              )}
            </>
          )}
        </aside>

        {/* ---- Right Main: 導航內容 ---- */}
        {hasFileSelected ? (
        <section className={styles.guideSection}>
          <h2 className={styles.guideTitle}>主日信息导航</h2>
          <p className={styles.guideSubtitle}>
            当前讲章：{selectedFileName || '未知'}
          </p>

          {/* Mode buttons */}
          <div className={styles.buttonGroup}>
            <button
              className={`${styles.modeButton} ${selectedMode === 'summary' ? styles.active : ''}`}
              onClick={() => handleModeSelect('summary')}
            >
              信息总结
            </button>
            <button
              className={`${styles.modeButton} ${selectedMode === 'devotional' ? styles.active : ''}`}
              onClick={() => handleModeSelect('devotional')}
            >
              每日灵修
            </button>
            <button
              className={`${styles.modeButton} ${selectedMode === 'bible' ? styles.active : ''}`}
              onClick={() => handleModeSelect('bible')}
            >
              查经指引
            </button>
          </div>

          {/* Content */}
          {sermonContent ? (
            <div className={styles.contentWrapper}>
              <div className={`${styles.contentArea} ${styles.hasContent}`}>
                {renderContent()}
              </div>
            </div>
          ) : null}

          {/* ChatKit */}
          {user && (
            <div className={styles.chatSection}>
              <ChatkitEmbed userId={user.user_id} />
            </div>
          )}
        </section>
        ) : (
          <div className={styles.guidePlaceholder}>
            <div className={styles.guidePlaceholderIcon}>👈</div>
            <p className={styles.guidePlaceholderText}>
              请从左侧选择一份讲章<br />以开启主日信息导航
            </p>
          </div>
        )}
      </div>{/* end mainLayout */}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page Export
// ---------------------------------------------------------------------------

export default function SundayGuideV2() {
  const { user, loading } = useAuth();

  // NEXT_PUBLIC_DEV_SKIP_AUTH=true in .env.local bypasses the auth gate for
  // local development. This flag is NOT set in amplify.yml, so production is
  // unaffected. It is baked at build time (NEXT_PUBLIC_*), so no runtime overhead.
  const devSkip = process.env.NEXT_PUBLIC_DEV_SKIP_AUTH === 'true';

  if (loading && !devSkip) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '100vh', fontSize: '1rem', color: '#64748b' }}>
        載入中...
      </div>
    );
  }

  if (!user && !devSkip) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '100vh', fontSize: '1rem', color: '#64748b' }}>
        請先登入
      </div>
    );
  }

  return (
    <WithChat chatType={CHAT_TYPES.SUNDAY_GUIDE} disableChatContext>
      <SundayGuideContent />
    </WithChat>
  );
}
