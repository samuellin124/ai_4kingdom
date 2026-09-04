"use client";

import { useState, useEffect, useRef } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { useCredit } from '../../contexts/CreditContext';
import { ChatProvider, useChat } from '../../contexts/ChatContext';
import ConversationList from '../../components/ConversationList';
import MessageList from '../../components/Chat/MessageList';
import ChatInput from '../../components/Chat/ChatInput';
import styles from '../../user-sunday-guide/page.module.css';
import chatStyles from './chat.module.css';
import { getSundayGuideUnitConfig } from '../../config/constants';
import { ASSISTANT_IDS, VECTOR_STORE_IDS } from '../../config/constants';
import ReactMarkdown from 'react-markdown';

type GuideMode = 'summary' | 'devotional' | 'bible' | null;

interface CfscChurchRecord {
  fileName: string;
  sermonTitle?: string | null;
  uploadTime: string;
  fileUniqueId: string;
  fileId?: string;
}

function CfscChurchNavigatorContent() {
  const cfscChurchUnit = getSundayGuideUnitConfig('cfscChurch');
  const [fileList, setFileList] = useState<CfscChurchRecord[]>([]);
  const [selectedFileUniqueId, setSelectedFileUniqueId] = useState<string | null>(null);
  const { user } = useAuth();
  const { refreshUsage } = useCredit();
  const [selectedMode, setSelectedMode] = useState<GuideMode>(null);
  const [sermonContent, setSermonContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const [fileName, setFileName] = useState<string>('');
  const [uploadTime, setUploadTime] = useState<string>('');
  const [pdfLoading, setPdfLoading] = useState(false);
  const [pdfError, setPdfError] = useState<string | null>(null);
  // 手機版 sidebar 展開/折疊
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // Chat 狀態
  const { messages, currentThreadId, setCurrentThreadId, sendMessage, isLoading: chatLoading, error: chatError, setError: setChatError, setMessages, loadChatHistory } = useChat();
  const shouldLoadHistory = useRef(false);

  useEffect(() => {
    if (chatError) {
      const t = setTimeout(() => setChatError(''), 8000);
      return () => clearTimeout(t);
    }
  }, [chatError, setChatError]);

  useEffect(() => {
    if (currentThreadId && user && shouldLoadHistory.current) {
      shouldLoadHistory.current = false;
      loadChatHistory(user.user_id);
    }
  }, [currentThreadId]);

  const handleCreateNewThread = () => {
    setCurrentThreadId(null);
    setMessages([]);
  };

  const handleSelectThread = (threadId: string) => {
    if (threadId === currentThreadId) return;
    shouldLoadHistory.current = true;
    setChatError('');
    setMessages([]);
    setCurrentThreadId(threadId);
    setSidebarOpen(false);
  };

  const handleSendMessage = async (message: string) => {
    await sendMessage(message);
    window.dispatchEvent(new CustomEvent('refreshConversations'));
  };

  useEffect(() => {
    if (user?.user_id) {
      fetchCfscFiles();
    }
  }, [user]);

  const fetchCfscFiles = async () => {
    try {
      const res = await fetch(`/api/sunday-guide/documents?unitId=cfscChurch&allUsers=true`);
      if (!res.ok) throw new Error('获取文件记录失败');
      const data = await res.json();
      if (data.success && data.records?.length) {
        const sorted = [...data.records].sort((a: any, b: any) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
        const mapped: CfscChurchRecord[] = sorted.map((r: any) => ({
          fileName: r.fileName || '未命名文件',
          sermonTitle: r.sermonTitle || null,
          uploadTime: r.updatedAt,
          fileUniqueId: r.fileId,
          fileId: r.fileId
        }));
        setFileList(mapped);
        const storedId = typeof window !== 'undefined' ? localStorage.getItem('selectedFileId') : null;
        const storedName = typeof window !== 'undefined' ? localStorage.getItem('selectedFileName') : null;
        const storedItem = storedId ? mapped.find(m => m.fileUniqueId === storedId) : null;
        const target = storedItem || mapped[0];
        const displayName = (f: CfscChurchRecord) => f.fileName || f.sermonTitle || '';
        setSelectedFileUniqueId(target.fileUniqueId);
        // localStorage 反映清單目前選中的講章（含載入預設）；Chat 以此為檢索範圍
        if (typeof window !== 'undefined') localStorage.setItem('selectedFileId', target.fileUniqueId);
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

  const broadcastSelection = (fileId: string, name: string) => {
    try {
      localStorage.setItem('selectedFileId', fileId);
      localStorage.setItem('selectedFileName', name);
      localStorage.setItem('currentUnitId', 'cfscChurch');
      const channel = new BroadcastChannel('file-selection');
      channel.postMessage({
        type: 'FILE_SELECTED',
        assistantId: cfscChurchUnit.assistantId,
        fileId,
        fileName: name,
        ts: Date.now()
      });
      channel.close();
    } catch (err) {
      console.warn('broadcastSelection error', err);
    }
  };

  useEffect(() => {
    const channel = new BroadcastChannel('file-selection');
    const handler = (e: MessageEvent) => {
      const data = e.data;
      if (data?.type === 'FILE_SELECTED' && data.assistantId === cfscChurchUnit.assistantId) {
        setSelectedFileUniqueId(data.fileId);
        setFileName(data.fileName);
        setUploadTime('');
        setSermonContent(null);
        setSelectedMode(null);
      }
    };
    channel.addEventListener('message', handler);
    return () => { channel.removeEventListener('message', handler); channel.close(); };
  }, [cfscChurchUnit.assistantId]);

  const handleModeSelect = async (mode: GuideMode) => {
    if (!selectedFileUniqueId) return;
    setSelectedMode(mode);
    setLoading(true);
    try {
      const userId = user?.user_id || '';
      const apiUrl = `/api/sunday-guide/content/${cfscChurchUnit.assistantId}?type=${mode}&userId=${encodeURIComponent(userId)}&fileId=${encodeURIComponent(selectedFileUniqueId)}`;
      const response = await fetch(apiUrl);
      if (response.status === 202) {
        const data = await response.json().catch(() => ({}));
        setSelectedMode(null);
        alert(data.error || '內容正在生成中，請稍候再試');
        return;
      }
      if (!response.ok) {
        const errData = await response.json().catch(() => ({ error: '未知錯誤' }));
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
    const titles: Record<string, string> = { summary: '讲道总结', devotional: '每日灵修', bible: '查经指引' };
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

  const handleDownloadPDF = () => {
    setPdfError(null);
    setPdfLoading(true);
    try {
      const userId = user?.user_id || '';
      const base = '/api/sunday-guide/download-pdf';
      const params = new URLSearchParams();
      params.set('assistantId', cfscChurchUnit.assistantId);
      params.set('userId', userId);
      params.set('includeAll', 'true');
      window.open(`${base}?${params.toString()}`, '_blank');
      setTimeout(() => setPdfLoading(false), 1200);
    } catch (err) {
      console.error('PDF 下載失敗', err);
      setPdfError(err instanceof Error ? err.message : '下載失敗');
      setPdfLoading(false);
    }
  };

  if (!user) {
    return <div>請先登錄</div>;
  }

  return (
    <div className={styles.container}>
      <h1 className={styles.title}>主日信息导航</h1>
      {fileName && fileName !== '尚未上傳文件' && fileName !== '獲取文件資訊失敗' && (
        <div style={{ fontSize: '13px', color: '#0070f3', marginBottom: 12, textAlign: 'center' }}>
          当前文件: {fileName} {uploadTime && `(上传时间: ${uploadTime})`}
        </div>
      )}
      <div className={styles.buttonGroup}>
        <button className={`${styles.modeButton} ${selectedMode === 'summary' ? styles.active : ''}`} onClick={() => handleModeSelect('summary')} disabled={!selectedFileUniqueId}>信息总结</button>
        <button className={`${styles.modeButton} ${selectedMode === 'devotional' ? styles.active : ''}`} onClick={() => handleModeSelect('devotional')} disabled={!selectedFileUniqueId}>每日灵修</button>
        <button className={`${styles.modeButton} ${selectedMode === 'bible' ? styles.active : ''}`} onClick={() => handleModeSelect('bible')} disabled={!selectedFileUniqueId}>查经指引</button>
      </div>
      {(!fileName || fileName === '尚未上傳文件' || fileName === '獲取文件資訊失敗') && (
        <div style={{ fontSize: '14px', color: '#ff6b6b', marginTop: 8, marginBottom: 16, textAlign: 'center', padding: '12px', backgroundColor: '#fff5f5', borderRadius: '8px', border: '1px solid #ffebee' }}>
          {fileName === '获取文件信息失败' ? '无法获取文件信息，请稍后重试' : '目前尚无可用文件'}
        </div>
      )}
      <div className={styles.contentWrapper}>
        {sermonContent ? (
          <>
            <div className={`${styles.contentArea} ${styles.hasContent}`}>{renderContent()}</div>
            <div className={styles.chatSection}>
              <div className={chatStyles.chatWrapper}>
                <div className={`${chatStyles.sidebar}${sidebarOpen ? ' ' + chatStyles.sidebarOpen : ''}`}>
                  <button
                    className={chatStyles.sidebarToggle}
                    onClick={() => setSidebarOpen(v => !v)}
                  >
                    <span>📋 對話記錄</span>
                    <span>{sidebarOpen ? '▲' : '▼'}</span>
                  </button>
                  <ConversationList
                    userId={user.user_id}
                    type="cfsc-church"
                    currentThreadId={currentThreadId}
                    onSelectThread={handleSelectThread}
                    isCreating={false}
                    onCreateNewThread={handleCreateNewThread}
                    sidebarMode={true}
                  />
                </div>
                <div className={chatStyles.main}>
                  <MessageList messages={messages} isLoading={chatLoading} />
                  {chatError && (
                    <div style={{ color: '#f55', padding: '6px 16px', background: '#3a0000' }}>
                      {chatError}
                    </div>
                  )}
                  <ChatInput onSend={handleSendMessage} isLoading={chatLoading} />
                </div>
              </div>
            </div>
          </>
        ) : (
          <div className={styles.emptyState} style={{ textAlign: 'center', width: '100%' }}><p>请先选择要查看的内容类型</p></div>
        )}
      </div>
    </div>
  );
}

export default function CfscChurchNavigatorPage() {
  const [mounted, setMounted] = useState(false);
  const { user, loading } = useAuth();
  useEffect(() => setMounted(true), []);
  if (!mounted || loading) return null;
  if (!user) return <div>请先登录</div>;
  return (
    <ChatProvider
      initialConfig={{
        type: 'cfsc-church',
        assistantId: ASSISTANT_IDS.CFSC_CHURCH,
        vectorStoreId: VECTOR_STORE_IDS.CFSC_CHURCH,
        userId: user.user_id,
      }}
    >
      <CfscChurchNavigatorContent />
    </ChatProvider>
  );
}
