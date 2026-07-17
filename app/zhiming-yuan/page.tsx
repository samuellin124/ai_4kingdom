"use client";

import { useState, useEffect, useRef } from 'react';
import WithChat from '../components/layouts/WithChat';
import { useAuth } from '../contexts/AuthContext';
import { useChat } from '../contexts/ChatContext';
import { useCredit } from '../contexts/CreditContext';
import ConversationList from '../components/ConversationList';
import MessageList from '../components/Chat/MessageList';
import ChatInput from '../components/Chat/ChatInput';
import ReactMarkdown from 'react-markdown';
import type { Components } from 'react-markdown';
import styles from '../sunday-guide-v2/SundayGuide.module.css';
import chatStyles from './navigator/chat.module.css';
import { ASSISTANT_IDS } from '../config/constants';

// DynamoDB 內容讀取：批次腳本以 SUNDAY_GUIDE 助手 ID 寫入，待遷移後改為 ZHIMING_YUAN
const ZHIMING_CONTENT_ASSISTANT = ASSISTANT_IDS.SUNDAY_GUIDE;

type GuideMode = 'summary' | 'devotional' | 'bible' | null;

interface FileRecord {
  fileName: string;
  fileId: string;
  uploadDate: string;
}

// 清除 OpenAI file_search RAG 引用標記：【X:Y†filename】
function stripCitations(text: string): string {
  // 只移除引用標記，保留所有換行（\s{2,} 會誤殺段落分隔）
  return text.replace(/【\d+:\d+†[^】]*】/g, '').trim();
}

// 自定義 ReactMarkdown 組件：讓「只含 <strong> 的段落」呈現為子標題樣式
const mdComponents: Components = {
  p({ node, children }) {
    const kids = node?.children ?? [];
    // 僅含單一 element 且為 strong → 視為段落子標題
    const isSubheading =
      kids.length === 1 &&
      kids[0].type === 'element' &&
      (kids[0] as any).tagName === 'strong';
    if (isSubheading) {
      return (
        <p style={{
          marginTop: '1.1em',
          marginBottom: '0.2em',
          paddingBottom: '0.3em',
          borderBottom: '1px solid #e2e8f0',
        }}>
          <strong style={{ fontWeight: 700, color: '#1e293b', fontSize: '0.95rem' }}>
            {children}
          </strong>
        </p>
      );
    }
    return <p>{children}</p>;
  },
};

// ─────────────────────────────────────────────────────────────────
function ZhimingYuanContent() {
  const { user } = useAuth();
  const { refreshUsage } = useCredit();

  // ── Document list ─────────────────────────────────────────────
  const [allFiles, setAllFiles] = useState<FileRecord[]>([]);
  const [selectedFileId, setSelectedFileId] = useState<string | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const filesPerPage = 10;
  const totalPages = Math.ceil(allFiles.length / filesPerPage);
  const pagedFiles = allFiles.slice((currentPage - 1) * filesPerPage, currentPage * filesPerPage);

  // ── Navigator (content panel) ─────────────────────────────────
  const [selectedMode, setSelectedMode] = useState<GuideMode>(null);
  const [sermonContent, setSermonContent] = useState<string | null>(null);
  const [navLoading, setNavLoading] = useState(false);
  const [navFileName, setNavFileName] = useState('');
  const [navUploadTime, setNavUploadTime] = useState('');
  const contentRef = useRef<HTMLDivElement>(null);

  // ── Floating chat widget ──────────────────────────────────────
  const [chatOpen, setChatOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // ── Chat context ──────────────────────────────────────────────
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

  // ── Auto-clear chat error ─────────────────────────────────────
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

  // ── Restore selected file from localStorage once list loads ──
  useEffect(() => {
    if (allFiles.length === 0) return;
    const storedId = typeof window !== 'undefined' ? localStorage.getItem('zhiming_selectedFileId') : null;
    const target = (storedId ? allFiles.find(f => f.fileId === storedId) : null) || allFiles[0];
    if (!target) return;
    if (!selectedFileId) setSelectedFileId(target.fileId);
    setNavFileName(target.fileName.replace(/\.pdf$/i, ''));
    setNavUploadTime(target.uploadDate);
  }, [allFiles]);

  // ── Fetch document list from DynamoDB (unitId=zhiming-yuan) ───
  const fetchAllFileRecords = async () => {
    try {
      const res = await fetch('/api/sunday-guide/documents?unitId=zhiming-yuan&allUsers=true');
      if (!res.ok) throw new Error('獲取文件記錄失敗');
      const data = await res.json();
      if (data.success && data.records) {
        const sorted: FileRecord[] = data.records
          .sort((a: any, b: any) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
          .map((rec: any) => ({
            fileName: rec.fileName || '未命名文件',
            fileId: rec.fileId || '',
            uploadDate: new Date(rec.createdAt).toLocaleDateString('zh-TW'),
          }));
        setAllFiles(sorted);
        setCurrentPage(1);
      } else {
        setAllFiles([]);
      }
    } catch {
      setAllFiles([]);
    }
  };

  useEffect(() => { fetchAllFileRecords(); }, [user]);

  // ── Select file ───────────────────────────────────────────────
  const handleSelectFile = (fileId: string) => {
    setSelectedFileId(fileId);
    setSermonContent(null);
    setSelectedMode(null);
    const file = pagedFiles.find(f => f.fileId === fileId);
    if (file) {
      const displayName = file.fileName.replace(/\.pdf$/i, '');
      setNavFileName(displayName);
      setNavUploadTime(file.uploadDate);
      try {
        localStorage.setItem('zhiming_selectedFileId', fileId);
      } catch {
        // ignore
      }
    }
  };

  // ── Load pre-generated content ────────────────────────────────
  const handleModeSelect = async (mode: GuideMode) => {
    if (!selectedFileId) return;
    setSelectedMode(mode);
    setNavLoading(true);
    try {
      const userId = user?.user_id || '';
      // ZHIMING_CONTENT_ASSISTANT = SUNDAY_GUIDE: batch wrote records under this ID
      const url = `/api/sunday-guide/content/${ZHIMING_CONTENT_ASSISTANT}?type=${mode}&userId=${encodeURIComponent(userId)}&fileId=${encodeURIComponent(selectedFileId)}`;
      const res = await fetch(url);
      if (res.status === 202) {
        const d = await res.json().catch(() => ({}));
        setSelectedMode(null);
        alert(d.error || '內容正在生成中，請稍候再試');
        return;
      }
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: '未知錯誤' }));
        throw new Error(`獲取內容失敗: ${res.status} - ${err.error || res.statusText}`);
      }
      const data = await res.json();
      setSermonContent(stripCitations(data.content || ''));
      await refreshUsage();
    } catch (e) {
      console.error(e);
      alert(e instanceof Error ? e.message : '請稍後重試');
      setSelectedMode(null);
    } finally {
      setNavLoading(false);
    }
  };

  // ── Chat callbacks ────────────────────────────────────────────
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

  // ── Render content panel ──────────────────────────────────────
  const renderNavContent = () => {
    if (navLoading) return <div className={styles.loading}>加载中，请稍候...</div>;
    if (!sermonContent) return null;
    const titles: Record<string, string> = {
      summary: '信息总结',
      devotional: '每日灵修',
      bible: '查经指引',
    };
    return (
      <div className={styles.contentBox}>
        <div className={styles.contentHeader}>
          <h2 style={{ textShadow: 'none', color: '#1e293b', fontSize: '1.1rem', fontWeight: 700, margin: 0, fontFamily: 'inherit', letterSpacing: 'normal' }}>
            {titles[selectedMode!]}
          </h2>
        </div>
        <div className={styles.markdownContent} ref={contentRef}>
          <ReactMarkdown components={mdComponents}>{sermonContent}</ReactMarkdown>
        </div>
      </div>
    );
  };

  return (
    <div className={styles.container}>

      {/* ── Page header ── */}
      <div style={{ textAlign: 'center', padding: '1rem 0 0.5rem', borderBottom: '1px solid #e2e8f0', marginBottom: '1rem' }}>
        <h1 style={{ fontSize: '1.4rem', fontWeight: 700, color: '#1e293b', margin: 0, textShadow: 'none', letterSpacing: 'normal', fontFamily: 'inherit' }}>
          遠志明耶穌頌 AI 助手
        </h1>
        <p style={{ fontSize: '0.85rem', color: '#64748b', margin: '4px 0 0' }}>
          神學問答集 · 信息總結 · 靈修指引 · 查經引導
        </p>
      </div>

      {/* ── Main two-column layout ── */}
      <div className={styles.mainLayout}>

        {/* ── Left: Document list ── */}
        <aside className={styles.docsSection}>
          <h4 className={styles.docsSectionTitle}>
            📚 文档列表
            <span className={styles.docsSectionHint}>— 选择一篇文章</span>
          </h4>

          {pagedFiles.length === 0 ? (
            <div className={styles.noDocs}>載入中...</div>
          ) : (
            <>
              <ul className={styles.docsListScrollable}>
                {pagedFiles.map((file, idx) => (
                  <li
                    key={file.fileId || idx}
                    className={`${styles.docItem} ${selectedFileId === file.fileId ? styles.docItemSelected : ''}`}
                    onClick={() => handleSelectFile(file.fileId)}
                    title={file.fileName}
                  >
                    <span className={styles.deleteButtonPlaceholder} />
                    <span className={styles.docIndex}>{(currentPage - 1) * filesPerPage + idx + 1}.</span>
                    <span className={styles.docFileName}>
                      {file.fileName.replace(/\.pdf$/i, '')}
                    </span>
                    <span className={styles.docDate}>{file.uploadDate}</span>
                  </li>
                ))}
              </ul>

              {totalPages > 1 && (
                <div className={styles.pagination}>
                  <button
                    onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                    disabled={currentPage === 1}
                    className={styles.paginationButton}
                  >←</button>
                  <span className={styles.paginationInfo}>{currentPage} / {totalPages}</span>
                  <button
                    onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                    disabled={currentPage === totalPages}
                    className={styles.paginationButton}
                  >→</button>
                </div>
              )}
            </>
          )}
        </aside>

        {/* ── Right: Navigator + Chat panel ── */}
        <div className={styles.navigatorPanel}>

          {navFileName && (
            <div style={{ fontSize: '13px', color: '#0070f3', marginBottom: 8, textAlign: 'center' }}>
              当前文章: {navFileName}{navUploadTime && ` (${navUploadTime})`}
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
            <div style={{ fontSize: '14px', color: '#64748b', textAlign: 'center', padding: '12px', background: '#f8fafc', borderRadius: '8px', border: '1px solid #e2e8f0' }}>
              文档加载中...
            </div>
          )}

          <div className={styles.contentWrapper}>
            {sermonContent ? (
              <div className={`${styles.contentArea} ${styles.hasContent}`} style={{ maxHeight: 'none', overflowY: 'visible' }}>
                {renderNavContent()}
              </div>
            ) : (
              <div style={{ textAlign: 'center', width: '100%', padding: '2rem 0', color: '#94a3b8' }}>
                <p>请先从左侧选择一篇文章，再点击上方按钮查看内容</p>
              </div>
            )}
          </div>
        </div>

      </div>

      {/* ── Floating chat bubble + panel ── */}
      {user && (
        <>
          {/* Chat panel */}
          <div className={`${chatStyles.floatingPanel}${chatOpen ? ' ' + chatStyles.panelOpen : ''}`}>
            <div className={chatStyles.panelHeader}>
              <span className={chatStyles.panelTitle}>遠志明耶穌頌 AI 助手</span>
              <button className={chatStyles.panelClose} onClick={() => setChatOpen(false)}>✕</button>
            </div>
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
                  type="zhiming-yuan"
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

          {/* Bubble toggle button */}
          <button
            className={chatStyles.floatingBubble}
            onClick={() => { setChatOpen(v => !v); setSidebarOpen(false); }}
            title="AI 對話助手"
          >
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
export default function ZhimingYuanPage() {
  return (
    <WithChat chatType="zhiming-yuan">
      <ZhimingYuanContent />
    </WithChat>
  );
}
