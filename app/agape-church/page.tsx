"use client";

import { useState, useEffect } from 'react';
import SermonInputTabs from '../components/SermonInputTabs';
import WithChat from '../components/layouts/WithChat';
import UserIdDisplay from '../components/UserIdDisplay';
import { useCredit } from '../contexts/CreditContext';
import { useAuth } from '../contexts/AuthContext';
import styles from '../sunday-guide-v2/SundayGuide.module.css';
import { ASSISTANT_IDS, VECTOR_STORE_IDS } from '../config/constants';

interface ProcessedContent {
  summary: string;
  fullText: string;
  devotional: string;
  bibleStudy: string;
}

export default function AgapeChurchPage() {
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

  useEffect(() => {
    fetch('/api/admin/sunday-guide-units')
      .then((r) => r.json())
      .then((data) => {
        if (data.success) setAllowedUploaders(data.data.units.agape.allowedUploaders ?? []);
      })
      .catch(() => {});
  }, []);

  useEffect(() => { setIsUploadDisabled(remainingCredits <= 0); }, [remainingCredits, hasInsufficientTokens]);

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
        if (selectedFileId === fileId) setSelectedFileId(null);
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
    try {
      const file = recentFiles.find(f => f.fileId === fileId);
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

  return (
    <WithChat chatType="sunday-guide">
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

          <div className={styles.guidePlaceholder}>
            <div className={styles.guidePlaceholderIcon}>👈</div>
            <p className={styles.guidePlaceholderText}>
              选择讲章后可前往<br />
              <a href="/agape-church/navigator" style={{ color: '#0070f3', textDecoration: 'underline' }}>愛加倍信息導覽</a><br />
              查看信息总结、灵修与查经
            </p>
          </div>
        </div>
      </div>
    </WithChat>
  );
}
