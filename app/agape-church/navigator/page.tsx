"use client";

import { useState, useEffect, useRef } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { useCredit } from '../../contexts/CreditContext';
import WithChat from '../../components/layouts/WithChat';
import styles from '../../user-sunday-guide/page.module.css';
import { CHAT_TYPES } from '../../config/chatTypes';
import { ASSISTANT_IDS } from '../../config/constants';
import ReactMarkdown from 'react-markdown';
import ChatkitEmbed from '../../components/ChatkitEmbed';
import Script from 'next/script';

// Reuse same type of modes
type GuideMode = 'summary' | 'devotional' | 'bible' | null;

interface AgapeRecord {
  fileName: string;
  sermonTitle?: string | null;
  uploadTime: string;
  fileUniqueId: string; // reuse fileId
  fileId?: string;
}

function AgapeNavigatorContent() {
  const [fileList, setFileList] = useState<AgapeRecord[]>([]);
  const [selectedFileUniqueId, setSelectedFileUniqueId] = useState<string | null>(null);
  const { user } = useAuth();
  const { refreshUsage } = useCredit();
  const [selectedMode, setSelectedMode] = useState<GuideMode>(null);
  const [sermonContent, setSermonContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const [fileName, setFileName] = useState<string>('');
  const [uploadTime, setUploadTime] = useState<string>('');
  // PDF 下載相關狀態
  const [pdfLoading, setPdfLoading] = useState(false);
  const [pdfError, setPdfError] = useState<string | null>(null);

  // 初始化：取得檔案列表
  useEffect(() => {
    if (user?.user_id) {
      fetchAgapeFiles();
    }
  }, [user]);

  const fetchAgapeFiles = async () => {
    try {
  const res = await fetch(`/api/sunday-guide/documents?unitId=agape&allUsers=true`);
  if (!res.ok) throw new Error('获取文件记录失败');
      const data = await res.json();
      if (data.success && data.records?.length) {
        const sorted = [...data.records].sort((a: any, b: any) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
        const mapped: AgapeRecord[] = sorted.map((r: any) => ({
          fileName: r.fileName || '未命名文件',
            sermonTitle: r.sermonTitle || null,
            uploadTime: r.createdAt,
            fileUniqueId: r.fileId,
            fileId: r.fileId
          }));
        setFileList(mapped);
        // 先嘗試從 localStorage 恢復選擇
        const storedId = typeof window !== 'undefined' ? localStorage.getItem('selectedFileId') : null;
        const storedName = typeof window !== 'undefined' ? localStorage.getItem('selectedFileName') : null;
        const storedItem = storedId ? mapped.find(m => m.fileUniqueId === storedId) : null;
        const target = storedItem || mapped[0];
        setSelectedFileUniqueId(target.fileUniqueId);
        const displayName = (f: AgapeRecord) => (!f.fileName.toLowerCase().endsWith('.pdf') && f.sermonTitle) ? f.sermonTitle : f.fileName;
        setFileName(storedItem ? (storedName || displayName(storedItem)) : displayName(target));
        setUploadTime(new Date(target.uploadTime).toLocaleDateString('zh-TW'));
      } else {
        setFileList([]);
  setFileName('尚未上传文件');
        setUploadTime('');
        setSelectedFileUniqueId(null);
      }
    } catch (e) {
      console.error(e);
      setFileList([]);
  setFileName('获取文件信息失败');
      setUploadTime('');
      setSelectedFileUniqueId(null);
    }
  };

  // 廣播選擇函數
  const broadcastSelection = (fileId: string, name: string) => {
    try {
      localStorage.setItem('selectedFileId', fileId);
      localStorage.setItem('selectedFileName', name);
      const channel = new BroadcastChannel('file-selection');
      channel.postMessage({
        type: 'FILE_SELECTED',
  assistantId: ASSISTANT_IDS.AGAPE_CHURCH,
        fileId,
        fileName: name,
        ts: Date.now()
      });
      channel.close();
    } catch (err) {
      console.warn('broadcastSelection error', err);
    }
  };

  // 監聽其他頁面（例如上傳頁）選擇的文件
  useEffect(() => {
    const channel = new BroadcastChannel('file-selection');
    const handler = (e: MessageEvent) => {
      const data = e.data;
  if (data?.type === 'FILE_SELECTED' && data.assistantId === ASSISTANT_IDS.AGAPE_CHURCH) {
        setSelectedFileUniqueId(data.fileId);
        setFileName(data.fileName);
        setUploadTime('');
        setSermonContent(null);
        setSelectedMode(null);
      }
    };
    channel.addEventListener('message', handler);
    return () => { channel.removeEventListener('message', handler); channel.close(); };
  }, []);

  const handleModeSelect = async (mode: GuideMode) => {
    if (!selectedFileUniqueId) return;
    setSelectedMode(mode);
    setLoading(true);
    try {
      const userId = user?.user_id || '';
  const apiUrl = `/api/sunday-guide/content/${ASSISTANT_IDS.AGAPE_CHURCH}?type=${mode}&userId=${encodeURIComponent(userId)}&fileId=${encodeURIComponent(selectedFileUniqueId)}`;
      const response = await fetch(apiUrl);
      if (!response.ok) {
        const errData = await response.json().catch(()=>({error:'未知錯誤'}));
  throw new Error(`获取内容失败: ${response.status} - ${errData.error || response.statusText}`);
      }
      const data = await response.json();
      setSermonContent(data.content);
      await refreshUsage();
    } catch (e) {
      console.error(e);
      alert(e instanceof Error ? e.message : '請稍後重試');
    } finally {
      setLoading(false);
    }
  };

  const renderContent = () => {
  if (loading) return <div className={styles.loading}>加载中，请稍候...</div>;
    if (!sermonContent) return null;
  const titles: Record<string,string> = { summary: '讲道总结', devotional: '每日灵修', bible: '查经指引' };
    return (
      <div className={styles.contentBox}>
        <div className={styles.contentHeader}>
          <h2>{titles[selectedMode!]}</h2>
      {sermonContent && (
            <button
              style={{ marginLeft: 8 }}
              className={styles.downloadButton}
        onClick={() => handleDownloadPDF()}
              disabled={pdfLoading}
            >
              {pdfLoading ? '生成中...' : '下载完整版'}
            </button>
          )}
        </div>
        {pdfError && <div className={styles.errorMessage}>{pdfError}</div>}
        <div className={styles.markdownContent} ref={contentRef}>
          <ReactMarkdown>{sermonContent}</ReactMarkdown>
        </div>
      </div>
    );
  };

  // PDF 下載：僅保留完整版
  const handleDownloadPDF = () => {
    setPdfError(null);
    setPdfLoading(true);
    try {
      const userId = user?.user_id || '';
      // 若要僅下載當前顯示模式內容，可加上 type & fileId；完整版使用 includeAll
      const base = '/api/sunday-guide/download-pdf';
      const params = new URLSearchParams();
  params.set('assistantId', ASSISTANT_IDS.AGAPE_CHURCH);
      params.set('userId', userId);
      params.set('includeAll', 'true');
      const url = `${base}?${params.toString()}`;
      window.open(url, '_blank');
      setTimeout(()=> setPdfLoading(false), 1200);
    } catch (err) {
      console.error('PDF 下載失敗', err);
      setPdfError(err instanceof Error ? err.message : '下載失敗');
      setPdfLoading(false);
    }
  };

  return (
    <div className={styles.container}>
  <h1 className={styles.title}>主日信息导航</h1>
      {fileName && fileName !== '尚未上傳文件' && fileName !== '獲取文件資訊失敗' && (
        <div style={{ fontSize: '13px', color: '#0070f3', marginBottom: 12, textAlign: 'center' }}>
          当前文件: {fileName} {uploadTime && `(上传时间: ${uploadTime})`}
        </div>
      )}
      <div className={styles.buttonGroup}>
  <button className={`${styles.modeButton} ${selectedMode === 'summary' ? styles.active : ''}`} onClick={()=>handleModeSelect('summary')} disabled={!selectedFileUniqueId}>信息总结</button>
  <button className={`${styles.modeButton} ${selectedMode === 'devotional' ? styles.active : ''}`} onClick={()=>handleModeSelect('devotional')} disabled={!selectedFileUniqueId}>每日灵修</button>
  <button className={`${styles.modeButton} ${selectedMode === 'bible' ? styles.active : ''}`} onClick={()=>handleModeSelect('bible')} disabled={!selectedFileUniqueId}>查经指引</button>
      </div>
      {(!fileName || fileName === '尚未上傳文件' || fileName === '獲取文件資訊失敗') && (
        <div style={{ fontSize: '14px', color: '#ff6b6b', marginTop: 8, marginBottom: 16, textAlign: 'center', padding: '12px', backgroundColor: '#fff5f5', borderRadius: '8px', border: '1px solid #ffebee' }}>
          {fileName === '获取文件信息失败' ? '无法获取文件信息，请稍后重试' : '目前尚无可用文件'}
        </div>
      )}
      {sermonContent ? (
        <div className={styles.contentWrapper}>
          <div className={`${styles.contentArea} ${styles.hasContent}`}>{renderContent()}</div>
          <div className={styles.chatSection}>
            {/* ChatKit 前端 SDK 腳本（必要） */}
            <Script src="https://cdn.platform.openai.com/deployments/chatkit/chatkit.js" strategy="afterInteractive" />
            {user && (
              <ChatkitEmbed userId={user.user_id} module="agape-church-navigator" />
            )}
          </div>
        </div>
      ) : (
  <div className={styles.emptyState}><p>请先选择要查看的内容类型</p></div>
      )}
      {/* 簡易文件清單（同頁面底部顯示，可擴充為可切換） */}
  {/* 已移除底部 Agape 文件列表 */}
    </div>
  );
}

export default function AgapeNavigatorPage() {
  const { user, loading } = useAuth();
  if (loading) return <div>Loading...</div>;
  if (!user) return <div>请先登录</div>;
  return (
    <WithChat chatType={CHAT_TYPES.SUNDAY_GUIDE}>
      <AgapeNavigatorContent />
    </WithChat>
  );
}
