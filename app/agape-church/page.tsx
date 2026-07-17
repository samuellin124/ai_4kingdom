"use client";

import { useState, useEffect, useRef } from 'react';
import SermonInputTabs from '../components/SermonInputTabs';
import WithChat from '../components/layouts/WithChat';
import UserIdDisplay from '../components/UserIdDisplay';
import { useCredit } from '../contexts/CreditContext';
import { useAuth } from '../contexts/AuthContext';
import { useChat } from '../contexts/ChatContext';
import ConversationList from '../components/ConversationList';
import MessageList from '../components/Chat/MessageList';
import ChatInput from '../components/Chat/ChatInput';
import ReactMarkdown from 'react-markdown';
import styles from '../sunday-guide-v2/SundayGuide.module.css';
import chatStyles from './navigator/chat.module.css';
import { ASSISTANT_IDS, VECTOR_STORE_IDS } from '../config/constants';

interface ProcessedContent {
  summary: string;
  fullText: string;
  devotional: string;
  bibleStudy: string;
}

type GuideMode = 'summary' | 'devotional' | 'bible' | null;

// ─────────────────────────────────────────────────────────────────
// Inner component — runs inside WithChat's ChatProvider
// ─────────────────────────────────────────────────────────────────
function AgapeChurchContent() {
  const { refreshUsage, hasInsufficientTokens, remainingCredits } = useCredit();
  const { user } = useAuth();
  const [isProcessing, setIsProcessing] = useState(false);
  const [processedContent, setProcessedContent] = useState<ProcessedContent | null>(null);
  const [uploadProgress, setUploadProgress] = useState<number>(0);
  const [uploadTime, setUploadTime] = useState<string>('');
  const [isUploadDisabled, setIsUploadDisabled] = useState(false);
  const [allFiles, setAllFiles] = useState<Array<{ fileName: string; sermonTitle?: string | null; uploadDate: string; fileId: string; uploaderId?: string }>>([]);
  const [selectedFileId, setSelectedFileId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [editingFileId, setEditingFileId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState('');
  const [currentPage, setCurrentPage] = useState(1);
  const filesPerPage = 10;
  const totalPages = Math.ceil(allFiles.length / filesPerPage);
  const recentFiles = allFiles.slice((currentPage - 1) * filesPerPage, currentPage * filesPerPage);

  const [allowedUploaders, setAllowedUploaders] = useState<string[]>([]);
  const hasUploadPermission = !!user?.user_id && allowedUploaders.includes(user.user_id);

  // ── Navigator states ─────────────────────────────────────────
  const [selectedMode, setSelectedMode] = useState<GuideMode>(null);
  const [sermonContent, setSermonContent] = useState<string | null>(null);
  const [navLoading, setNavLoading] = useState(false);
  const [navFileName, setNavFileName] = useState<string>('');
  const [navUploadTime, setNavUploadTime] = useState<string>('');
  const [pdfLoading, setPdfLoading] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [pdfError, setPdfError] = useState<string | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  // ── Chat context (provided by WithChat) ──────────────────────
  const {
    messages,
    currentThreadId,
    setCurrentThreadId,
    sendMessage,
    isLoading: chatLoading,
    error: chatError,
    setError: setChatError,
    setMessages,
    loadChatHistory,
  } = useChat();
  const shouldLoadHistory = useRef(false);

  useEffect(() => {
    fetch('/api/admin/sunday-guide-units')
      .then((r) => r.json())
      .then((data) => {
        if (data.success) setAllowedUploaders(data.data.units.agape.allowedUploaders ?? []);
      })
      .catch(() => {});
  }, []);

  useEffect(() => { setIsUploadDisabled(remainingCredits <= 0); }, [remainingCredits, hasInsufficientTokens]);

  // ── Chat error auto-clear ─────────────────────────────────────
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

  // Restore selected file from localStorage once files load
  useEffect(() => {
    if (allFiles.length === 0) return;
    const storedId = typeof window !== 'undefined' ? localStorage.getItem('selectedFileId') : null;
    const storedName = typeof window !== 'undefined' ? localStorage.getItem('selectedFileName') : null;
    const target = (storedId ? allFiles.find(f => f.fileId === storedId) : null) || allFiles[0];
    if (!target) return;
    if (!selectedFileId) setSelectedFileId(target.fileId);
    const displayName = (!target.fileName.toLowerCase().endsWith('.pdf') && target.sermonTitle)
      ? target.sermonTitle : target.fileName;
    setNavFileName(storedName || displayName);
    setNavUploadTime(target.uploadDate);
  }, [allFiles]);

  const fetchAllFileRecords = async () => {
    try {
      const res = await fetch(`/api/sunday-guide/documents?unitId=agape&allUsers=true`);
      if (!res.ok) throw new Error('獲取文件記錄失敗');
      const data = await res.json();
      if (data.success && data.records) {
        const sorted = data.records.sort((a: any, b: any) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
        setAllFiles(sorted.map((rec: any) => ({
          fileName: rec.fileName || '未命名文件',
          sermonTitle: rec.sermonTitle || null,
          uploadDate: new Date(rec.createdAt).toLocaleDateString('zh-TW'),
          fileId: rec.fileId || '',
          uploaderId: rec.userId || '未知',
        })));
        setCurrentPage(1);
      } else {
        setAllFiles([]);
      }
    } catch {
      setAllFiles([]);
    }
  };

  const handleDelete = async (fileId: string, uploaderId?: string) => {
    if (!fileId) return;
    
    // 必須是已登入的本人，不允許回退到 uploaderId（避免任意人偽造刪除）
    const currentUserId = user?.user_id;
    
    if (!currentUserId) return;
    if (!confirm('確定刪除此文件記錄？此操作不可回復。')) return;
    try {
      setDeletingId(fileId);
      const qs = new URLSearchParams({ fileId, unitId: 'agape', userId: currentUserId });
      const res = await fetch(`/api/sunday-guide/documents?${qs.toString()}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok || !data.success) {
        alert('刪除失敗: ' + (data.error || res.status));
      } else {
        await fetchAllFileRecords();
        if (selectedFileId === fileId) {
          setSelectedFileId(null);
          setNavFileName('');
          setNavUploadTime('');
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

  const handleRenameTitle = async (fileId: string, newTitle: string) => {
    if (!user?.user_id || !newTitle.trim()) { setEditingFileId(null); return; }
    const file = allFiles.find(f => f.fileId === fileId);
    const currentTitle = file?.sermonTitle || file?.fileName || '';
    if (newTitle.trim() === currentTitle) { setEditingFileId(null); return; }
    try {
      const res = await fetch('/api/sunday-guide/documents', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileId, unitId: 'agape', userId: user.user_id, sermonTitle: newTitle.trim() }),
      });
      const data = await res.json();
      if (res.ok && data.success) {
        setAllFiles(prev => prev.map(f => f.fileId === fileId ? { ...f, sermonTitle: data.sermonTitle } : f));
        if (selectedFileId === fileId) setNavFileName(data.sermonTitle || newTitle.trim());
      } else {
        alert('更新失敗: ' + (data.error || res.status));
      }
    } catch (e: any) {
      alert('更新時發生錯誤: ' + (e.message || '未知錯誤'));
    } finally {
      setEditingFileId(null);
    }
  };

  useEffect(() => { fetchAllFileRecords(); }, [user]);

  const handleFileProcessed = async (content: ProcessedContent) => {
    setProcessedContent(content);
    setIsProcessing(false);
    await fetchAllFileRecords();
    await refreshUsage();
  };

  const handleSelectFile = (fileId: string) => {
    setSelectedFileId(fileId);
    // Reset navigator content when a new file is chosen
    setSermonContent(null);
    setSelectedMode(null);
    const file = recentFiles.find(f => f.fileId === fileId);
    const displayName = file
      ? ((!file.fileName.toLowerCase().endsWith('.pdf') && file.sermonTitle) ? file.sermonTitle : file.fileName)
      : '';
    setNavFileName(displayName);
    setNavUploadTime(file?.uploadDate || '');
    try {
      localStorage.setItem('selectedFileId', fileId);
      if (file) localStorage.setItem('selectedFileName', file.fileName);
      const channel = new BroadcastChannel('file-selection');
      channel.postMessage({
        type: 'FILE_SELECTED',
        assistantId: ASSISTANT_IDS.AGAPE_CHURCH,
        fileId,
        fileName: file?.fileName || '',
        ts: Date.now(),
      });
      channel.close();
    } catch (err) {
      console.warn('broadcast file selection failed', err);
    }
  };

  // ── Navigator functions ──────────────────────────────────────
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

  const handleModeSelect = async (mode: GuideMode) => {
    if (!selectedFileId) return;
    setSelectedMode(mode);
    setNavLoading(true);
    try {
      const userId = user?.user_id || '';
      const apiUrl = `/api/sunday-guide/content/${ASSISTANT_IDS.AGAPE_CHURCH}?type=${mode}&userId=${encodeURIComponent(userId)}&fileId=${encodeURIComponent(selectedFileId)}`;
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
      setNavLoading(false);
    }
  };

  const handleDownloadPDF = () => {
    setPdfError(null);
    setPdfLoading(true);
    try {
      const userId = user?.user_id || '';
      const params = new URLSearchParams();
      params.set('assistantId', ASSISTANT_IDS.AGAPE_CHURCH);
      params.set('userId', userId);
      params.set('includeAll', 'true');
      window.open(`/api/sunday-guide/download-pdf?${params.toString()}`, '_blank');
      setTimeout(() => setPdfLoading(false), 1200);
    } catch (err) {
      console.error('PDF 下載失敗', err);
      setPdfError(err instanceof Error ? err.message : '下載失敗');
      setPdfLoading(false);
    }
  };

  const renderNavContent = () => {
    if (navLoading) return <div className={styles.loading}>加载中，请稍候...</div>;
    if (!sermonContent) return null;
    const titles: Record<string, string> = { summary: '讲道总结', devotional: '每日灵修', bible: '查经指引' };
    return (
      <div className={styles.contentBox}>
        <div className={styles.contentHeader}>
          <h2>{titles[selectedMode!]}</h2>
          <button
            className={styles.downloadButton}
            onClick={handleDownloadPDF}
            disabled={pdfLoading}
          >
            {pdfLoading ? '生成中...' : '下载完整版'}
          </button>
        </div>
        {pdfError && <div className={styles.errorMessage}>{pdfError}</div>}
        <div className={styles.markdownContent} ref={contentRef}>
          <ReactMarkdown>{sermonContent}</ReactMarkdown>
        </div>
      </div>
    );
  };

  return (
    <div className={styles.container}>
      <UserIdDisplay />

        {/* =============== 1. Upload Section =============== */}
        {hasUploadPermission && (
          <section className={styles.uploadHero}>
            <h2 className={styles.uploadHeroTitle}>上传讲章</h2>
            <p className={styles.uploadHeroDesc}>
              上传愛加倍教會主日讲章文件，系统将自动生成<strong>信息总结</strong>、<strong>每日灵修</strong>与<strong>查经指引</strong>。
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
                assistantId={ASSISTANT_IDS.AGAPE_CHURCH}
                vectorStoreId={VECTOR_STORE_IDS.AGAPE_CHURCH}
                unitId="agape"
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

        {/* =============== 2. Sidebar: 文檔列表 =============== */}
        <div className={styles.mainLayout}>
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
                      onClick={() => handleSelectFile(file.fileId)}
                      title="点击选择此文档"
                    >
                      {(user?.user_id && (user.user_id === file.uploaderId || allowedUploaders.includes(user.user_id))) ? (
                        <button
                          onClick={(e) => { e.stopPropagation(); handleDelete(file.fileId, file.uploaderId); }}
                          disabled={deletingId === file.fileId}
                          className={styles.deleteButton}
                          title="删除此文档"
                        >
                          {deletingId === file.fileId ? '...' : '×'}
                        </button>
                      ) : (
                        <span className={styles.deleteButtonPlaceholder} />
                      )}
                      <span className={styles.docIndex}>{(currentPage - 1) * filesPerPage + idx + 1}.</span>
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
                          {user?.user_id && (user.user_id === file.uploaderId || allowedUploaders.includes(user.user_id)) && (
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

                {allFiles.length > 0 && (
                  <div className={styles.pagination}>
                    <button
                      onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                      disabled={currentPage === 1}
                      className={styles.paginationButton}
                    >
                      ←
                    </button>
                    <span className={styles.paginationInfo}>{currentPage} / {totalPages}</span>
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

          {/* ── Right: Navigator Panel (hidden on mobile ≤900px) ── */}
          <div className={styles.navigatorPanel}>
            <h2 style={{ textAlign: 'center', fontSize: '1.1rem', fontWeight: 700, color: '#1e293b', margin: '0 0 0.5rem' }}>
              主日信息导航
            </h2>

            {navFileName && (
              <div style={{ fontSize: '13px', color: '#0070f3', marginBottom: 8, textAlign: 'center' }}>
                当前文件: {navFileName}{navUploadTime && ` (上传时间: ${navUploadTime})`}
              </div>
            )}

            <div className={styles.buttonGroup}>
              <button
                className={`${styles.modeButton} ${selectedMode === 'summary' ? styles.active : ''}`}
                onClick={() => handleModeSelect('summary')}
                disabled={!selectedFileId}
              >信息总结</button>
              <button
                className={`${styles.modeButton} ${selectedMode === 'devotional' ? styles.active : ''}`}
                onClick={() => handleModeSelect('devotional')}
                disabled={!selectedFileId}
              >每日灵修</button>
              <button
                className={`${styles.modeButton} ${selectedMode === 'bible' ? styles.active : ''}`}
                onClick={() => handleModeSelect('bible')}
                disabled={!selectedFileId}
              >查经指引</button>
            </div>

            {allFiles.length === 0 && (
              <div style={{ fontSize: '14px', color: '#ff6b6b', textAlign: 'center', padding: '12px', background: '#fff5f5', borderRadius: '8px', border: '1px solid #ffebee' }}>
                目前尚无可用文件
              </div>
            )}

            <div className={styles.contentWrapper}>
              {sermonContent ? (
                <div className={`${styles.contentArea} ${styles.hasContent}`}>
                  {renderNavContent()}
                </div>
              ) : (
                <div style={{ textAlign: 'center', width: '100%', padding: '2rem 0', color: '#94a3b8' }}>
                  <p>请先选择要查看的内容类型</p>
                </div>
              )}
            </div>
          </div>

        </div>

      {/* ── Floating chat bubble + panel ── */}
      {user && (
        <>
          <div className={`${chatStyles.floatingPanel}${chatOpen ? ' ' + chatStyles.panelOpen : ''}`}>
            <div className={chatStyles.panelHeader}>
              <span className={chatStyles.panelTitle}>Agape 教會 AI 助手</span>
              <button className={chatStyles.panelClose} onClick={() => setChatOpen(false)}>✕</button>
            </div>
            <div className={chatStyles.chatWrapper}>
              <div className={`${chatStyles.sidebar}${sidebarOpen ? ' ' + chatStyles.sidebarOpen : ''}`}>
                <button className={chatStyles.sidebarToggle} onClick={() => setSidebarOpen(v => !v)}>
                  <span>📋 對話記錄</span><span>{sidebarOpen ? '▲' : '▼'}</span>
                </button>
                <ConversationList userId={user.user_id} type="agape-church" currentThreadId={currentThreadId}
                  onSelectThread={handleSelectThread} isCreating={false} onCreateNewThread={handleCreateNewThread} sidebarMode={true} />
              </div>
              <div className={chatStyles.main}>
                <MessageList messages={messages} isLoading={chatLoading} />
                {chatError && <div style={{ color: '#f55', padding: '6px 16px', background: '#3a0000' }}>{chatError}</div>}
                <ChatInput onSend={handleSendMessage} isLoading={chatLoading} />
              </div>
            </div>
          </div>
          <button className={chatStyles.floatingBubble} onClick={() => { setChatOpen(v => !v); setSidebarOpen(false); }} title="AI 對話助手">
            <svg className={chatStyles.bubbleIcon} viewBox="0 0 24 24" fill="none">
              <path d="M6 4H18C19.6569 4 21 5.34315 21 7V14C21 15.6569 19.6569 17 18 17H10.5L6.5 21V17H6C4.34315 17 3 15.6569 3 14V7C3 5.34315 4.34315 4 6 4Z" stroke="#ffffff" strokeWidth="1.6" strokeLinejoin="round" />
              <line x1="7.5" y1="8.4" x2="16.5" y2="8.4" stroke="#ffffff" strokeWidth="1.5" strokeLinecap="round" />
              <line x1="7.5" y1="11" x2="16.5" y2="11" stroke="#ffffff" strokeWidth="1.5" strokeLinecap="round" />
              <line x1="7.5" y1="13.6" x2="13" y2="13.6" stroke="#ffffff" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// Page entry — wraps content with ChatProvider via WithChat
// ─────────────────────────────────────────────────────────────────
export default function AgapeChurchPage() {
  return (
    <WithChat chatType="agape-church">
      <AgapeChurchContent />
    </WithChat>
  );
}
