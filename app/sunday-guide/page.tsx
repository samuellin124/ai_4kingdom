'use client';

import { useState, useEffect } from 'react';
import AssistantManager from '../components/AssistantManager';
import WithChat from '../components/layouts/WithChat';
import { useCredit } from '../contexts/CreditContext';
import UserIdDisplay from '../components/UserIdDisplay';
import styles from './SundayGuide.module.css';
import { ASSISTANT_IDS, VECTOR_STORE_IDS } from '../config/constants';
import { useAuth } from '../contexts/AuthContext';

interface ProcessedContent {
  summary: string;
  fullText: string;
  devotional: string;
  bibleStudy: string;
}

export default function SundayGuide() {
  const { refreshUsage, hasInsufficientTokens, remainingCredits } = useCredit();
  const { user, canUploadFiles } = useAuth(); // 取得當前登入用戶和上傳權限檢查方法
  const [isProcessing, setIsProcessing] = useState(false);
  const [processedContent, setProcessedContent] = useState<ProcessedContent | null>(null);
  const [uploadProgress, setUploadProgress] = useState<number>(0);
  const [uploadTime, setUploadTime] = useState<string>('');
  const [isUploadDisabled, setIsUploadDisabled] = useState(false);
  // 添加最新文件記錄的狀態
  const [latestFile, setLatestFile] = useState<{ fileName: string, uploadDate: string } | null>(null);
  // 添加是否顯示前次記錄的狀態
  const [showLatestFile, setShowLatestFile] = useState(true);
  // 新增：右側顯示所有用戶上傳的檔案記錄（分頁顯示）
  const [allFiles, setAllFiles] = useState<Array<{ fileName: string, uploadDate: string, fileId: string, uploaderId?: string }>>([]);
  // 新增：選中的檔案 ID
  const [selectedFileId, setSelectedFileId] = useState<string | null>(null);
  // 新增：刪除功能相關狀態
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [editingFileId, setEditingFileId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState('');
  const [allowedUploaders, setAllowedUploaders] = useState<string[]>([]);
  // 新增：分頁相關狀態
  const [currentPage, setCurrentPage] = useState(1);
  const filesPerPage = 10;
  const totalPages = Math.ceil(allFiles.length / filesPerPage);
  const recentFiles = allFiles.slice((currentPage - 1) * filesPerPage, currentPage * filesPerPage);

  // 檢查上傳權限
  const hasUploadPermission = canUploadFiles();
  
  console.log('[DEBUG] 上傳權限檢查:', {
    user_id: user?.user_id,
    hasUploadPermission
  });

  // 檢查用戶是否有足夠的 Credits
  useEffect(() => {
    // 只有當確實沒有剩餘 Credits 時才禁用上傳
    setIsUploadDisabled(remainingCredits <= 0);
  }, [remainingCredits, hasInsufficientTokens]);
  
  // 獲取最新的文件記錄（只查詢當前用戶）
  const fetchLatestFileRecord = async () => {
    if (!user?.user_id) {
      setLatestFile(null);
      return;
    }
    try {
      const response = await fetch(`/api/sunday-guide/documents?assistantId=${ASSISTANT_IDS.SUNDAY_GUIDE}&userId=${user.user_id}`);
      if (!response.ok) throw new Error('獲取文件記錄失敗');
      const data = await response.json();
      if (data.success && data.records && data.records.length > 0) {
        // 按時間排序，獲取最新記錄
        const latestRecord = [...data.records].sort(
          (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
        )[0];
        // 只保留日期部分（去除時分秒）
        const uploadDate = new Date(latestRecord.createdAt);
        const dateOnly = uploadDate.toLocaleDateString('en-US', {
          timeZone: 'America/Los_Angeles',
          year: 'numeric',
          month: '2-digit',
          day: '2-digit'
        });
        setLatestFile({
          fileName: latestRecord.fileName || '未命名文件',
          uploadDate: dateOnly
        });
      } else {
        setLatestFile(null);
      }
    } catch (error) {
      setLatestFile(null);
      console.error('獲取文件記錄失敗:', error);
    }
  };
  
  // 獲取所有用戶的文件記錄（一次全部載入，前端分頁）
  const fetchAllFileRecords = async () => {
    try {
      const response = await fetch(`/api/sunday-guide/documents?assistantId=${ASSISTANT_IDS.SUNDAY_GUIDE}&allUsers=true`);
      if (!response.ok) throw new Error('獲取文件記錄失敗');
      const data = await response.json();
      if (data.success && data.records) {
        const sortedFiles = data.records.sort((a: any, b: any) =>
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
        );
        setAllFiles(sortedFiles.map((rec: any) => ({
          fileName: rec.fileName || '未命名文件',
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

  // 新增：處理文件刪除功能
  const handleDelete = async (fileId: string, uploaderId?: string) => {
    if (!user?.user_id) return;
    if (!fileId) return;
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
        if (selectedFileId === fileId) setSelectedFileId(null);
        // 如果刪除的是最新文件，重新獲取最新記錄
        await fetchLatestFileRecord();
      }
    } catch (e: any) {
      alert('刪除時發生錯誤: ' + (e.message || '未知錯誤'));
    } finally {
      setDeletingId(null);
    }
  };

  // 取得所有用戶上傳檔案
  const fetchRecentFiles = async () => {
    await fetchAllFileRecords();
  };

  // 點擊 recent file 取得內容，改為直接開新分頁顯示完整版
  const handleRecentFileClick = (fileId: string, fileName: string) => {
    if (!user?.user_id || !fileId) return;
    const url = `/api/sunday-guide/download-pdf?includeAll=true&userId=${user.user_id}&assistantId=${ASSISTANT_IDS.SUNDAY_GUIDE}&fileId=${fileId}&previewOnly=true`;
    window.open(url, '_blank');
  };

  const handleRenameTitle = async (fileId: string, newTitle: string) => {
    if (!user?.user_id || !newTitle.trim()) { setEditingFileId(null); return; }
    const file = allFiles.find(f => f.fileId === fileId);
    const currentTitle = (file as any)?.sermonTitle || file?.fileName || '';
    if (newTitle.trim() === currentTitle) { setEditingFileId(null); return; }
    try {
      const res = await fetch('/api/sunday-guide/documents', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileId, unitId: 'default', userId: user.user_id, sermonTitle: newTitle.trim() }),
      });
      const data = await res.json();
      if (res.ok && data.success) {
        setAllFiles(prev => prev.map(f => f.fileId === fileId ? { ...f, sermonTitle: data.sermonTitle } as any : f));
      } else {
        alert('更新失敗: ' + (data.error || res.status));
      }
    } catch (e: any) {
      alert('更新時發生錯誤: ' + (e.message || '未知錯誤'));
    } finally {
      setEditingFileId(null);
    }
  };

  // 組件掛載時獲取文件記錄
  useEffect(() => {
    fetchLatestFileRecord();
    fetchAllFileRecords();
    fetch('/api/admin/sunday-guide-units')
      .then(r => r.json())
      .then(data => { if (data.success) setAllowedUploaders(data.data.units.default.allowedUploaders ?? []); })
      .catch(() => {});
  }, [user]);

  // 當有處理結果時，隱藏前次上傳記錄
  useEffect(() => {
    if (processedContent) {
      setShowLatestFile(false);
    } else {
      setShowLatestFile(true);
    }
  }, [processedContent]);

  const handleFileProcessed = async (content: ProcessedContent) => {
    setProcessedContent(content);
    setIsProcessing(false);

    // 文件處理完成後重新獲取最新的文件記錄並刷新信用點數使用量
    await fetchLatestFileRecord();
    await fetchAllFileRecords();
    await refreshUsage();
  };

  return (
    <WithChat chatType="sunday-guide">
      <div className={styles.container}>
        <div>
          <UserIdDisplay />
        </div>

        <div className={styles.layout}>
          {/* 左側：上傳 / 狀態區塊 */}
          {hasUploadPermission && (
            <section className={styles.section}>
              <div className={styles.sectionTitle}>
                <span>上传讲章</span>
              </div>
              {isUploadDisabled && (
                <span className={styles.creditWarningInline}>额度不足</span>
              )}
              {!isUploadDisabled && remainingCredits < 20 && (
                <span className={styles.creditWarningInline} style={{ background: '#fef3c7', color: '#92400e' }}>余额较低 ({remainingCredits})</span>
              )}
              <AssistantManager 
                onFileProcessed={handleFileProcessed} 
                setIsProcessing={setIsProcessing} 
                setUploadProgress={setUploadProgress}
                setUploadTime={setUploadTime}
                disabled={isUploadDisabled}
              />
              
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

          {/* 右側：所有用戶皆可瀏覽的文檔清單 */}
          <aside className={styles.recentFilesAside}>
            <h4 className={styles.recentFilesTitle}>
              可浏览文档
              <span style={{ fontSize: '0.7em', fontWeight: 'normal', color: '#888', marginLeft: '6px' }}>按上传日期↓</span>
            </h4>
            {recentFiles.length === 0 ? (
              <div className={styles.noRecentFiles}>暂无文档</div>
            ) : (
              <>
                <ul className={styles.recentFilesListScrollable}>
                  {recentFiles.map((file, idx) => (
                    <li 
                      key={file.fileId || idx} 
                      className={`${styles.recentFileItem} ${selectedFileId === file.fileId ? styles.selected : ''}`}
                      onClick={() => {
                        setSelectedFileId(file.fileId);
                        localStorage.setItem('selectedFileId', file.fileId);
                        localStorage.setItem('selectedFileName', file.fileName);
                        const channel = new BroadcastChannel('file-selection');
                        channel.postMessage({
                          type: 'FILE_SELECTED',
                          assistantId: ASSISTANT_IDS.SUNDAY_GUIDE,
                          fileId: file.fileId,
                          fileName: file.fileName,
                          timestamp: Date.now()
                        });
                        channel.close();
                      }}
                      title="点击选择此文档"
                    >
                      <span className={styles.fileIndex}>{((currentPage - 1) * filesPerPage) + idx + 1}. </span>
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
                          <span className={styles.fileName}>{(file as any).sermonTitle || file.fileName}</span>
                          {user?.user_id && (file.uploaderId?.toString() === user.user_id.toString() || allowedUploaders.includes(user.user_id)) && (
                            <button
                              className={styles.editTitleButton}
                              title="編輯標題"
                              onClick={e => {
                                e.stopPropagation();
                                setEditingTitle((file as any).sermonTitle || file.fileName);
                                setEditingFileId(file.fileId);
                              }}
                            >✎</button>
                          )}
                        </>
                      )}
                      <span className={styles.uploadDate}>{file.uploadDate}</span>

                      {/* 删除按钮：仅上传者可见 */}
                      {file.uploaderId && user?.user_id && (file.uploaderId.toString() === user.user_id.toString() || allowedUploaders.includes(user.user_id)) && (
                        <button
                          onClick={(e) => { 
                            e.stopPropagation();
                            handleDelete(file.fileId, file.uploaderId); 
                          }}
                          disabled={deletingId === file.fileId}
                          className={styles.deleteButton}
                          title="删除此文档"
                        >
                          {deletingId === file.fileId ? '...' : '🗑'}
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
                
                {/* 分頁控制 */}
                {allFiles.length > 0 && (
                  <div className={styles.pagination}>
                    <button
                      onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                      disabled={currentPage === 1}
                      className={styles.paginationButton}
                    >
                      上一页
                    </button>

                    <span className={styles.paginationInfo}>
                      第 {currentPage} 页，共 {totalPages} 页
                    </span>

                    <button
                      onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                      disabled={currentPage === totalPages}
                      className={styles.paginationButton}
                    >
                      下一页
                    </button>
                  </div>
                )}
              </>
            )}
          </aside>
        </div>
      </div>
    </WithChat>
  );
}