"use client";

import { useState, useEffect, useRef } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { useCredit } from '../contexts/CreditContext';
import WithChat from '../components/layouts/WithChat';
import styles from './page.module.css';
import { CHAT_TYPES } from '../config/chatTypes';
import { ASSISTANT_IDS, VECTOR_STORE_IDS } from '../config/constants';
import ReactMarkdown from 'react-markdown';

// 添加全局類型定義，以解決TypeScript報錯
declare global {
  interface Window {
    html2canvas: any;
    jspdf: {
      jsPDF: any;
    };
    jsPDF: any;
  }
}

// 使用 script 標籤直接引入 jspdf 和 html2canvas 庫，避免動態導入問題
const scriptsLoaded = {
  jspdf: false,
  html2canvas: false
};

type GuideMode = 'summary' | 'text' | 'devotional' | 'bible' | null;

// 簡繁轉換映射表（擴展版，包含更多常用字符）
const traditionalToSimplified: Record<string, string> = {
  '個': '个', '東': '东', '義': '义', '並': '并', '餘': '余', '傑': '杰',
  '這': '这', '為': '为', '來': '来', '後': '后', '點': '点', '國': '国',
  '說': '说', '當': '当', '時': '时', '從': '从', '學': '学', '實': '实',
  '進': '进', '與': '与', '產': '产', '還': '还', '會': '会', '發': '发',
  '經': '经', '見': '见', '樣': '样', '現': '现', '話': '话', '讓': '让',
  '對': '对', '體': '体', '們': '们', '開': '开', '過': '过', '著': '着',
  '關': '关', '靈': '灵', '長': '长', '門': '门', '問': '问', '間': '间',
  '聽': '听', '書': '书', '頁': '页', '紐': '纽', '約': '约', '馬': '马',
  '總': '总', '結': '结', '數': '数', '處': '处',
  '導': '导', '應': '应', '該': '该', '頭': '头', '顯': '显', '願': '愿',
  '歲': '岁', '師': '师', '遠': '远', '鐘': '钟', '專': '专', '區': '区',
  '團': '团', '園': '园', '圓': '圆', '連': '连', '週': '周', '階': '阶',
  '麼': '么', '麗': '丽', '壽': '寿', '圍': '围', '興': '兴',
  '證': '证', '讀': '读', '認': '认', '隻': '只', '講': '讲',
  '較': '较', '誰': '谁', '張': '张', '際': '际', '離': '离', '壓': '压',
  '雲': '云', '畫': '画', '惡': '恶', '愛': '爱', '爺': '爷', '態': '态',
  '雞': '鸡', '強': '强', '歡': '欢', '漢': '汉'
};

function SundayGuideContent() {
  // 檔案列表與選擇的 unique id
  const [fileList, setFileList] = useState<Array<{ fileName: string, uploadTime: string, fileUniqueId: string }>>([]);
  const [selectedFileUniqueId, setSelectedFileUniqueId] = useState<string | null>(null);
  // 新增：從 localStorage 讀取選中的檔案 ID
  const [selectedFileFromSundayGuide, setSelectedFileFromSundayGuide] = useState<{ fileId: string, fileName: string } | null>(null);
  const { user } = useAuth();
  const { refreshUsage } = useCredit();
  const [selectedMode, setSelectedMode] = useState<GuideMode>(null);
  const [sermonContent, setSermonContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [pdfLoading, setPdfLoading] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const [pdfError, setPdfError] = useState<string | null>(null);
  const [librariesLoaded, setLibrariesLoaded] = useState(false);
  // 添加檔案資訊相關狀態變數
  const [fileName, setFileName] = useState<string>('');
  const [uploadTime, setUploadTime] = useState<string>('');
  // 新增：追蹤是否已按下任一按鈕
  const [isButtonClicked, setIsButtonClicked] = useState(false);

  useEffect(() => {
    // 檢查是否在瀏覽器環境
    if (typeof window !== 'undefined') {
      // 動態引入腳本
      const loadScripts = async () => {
        try {
          // 加載 html2canvas
          const html2canvasScript = document.createElement('script');
          html2canvasScript.src = 'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js';
          html2canvasScript.async = true;
          html2canvasScript.onload = () => {
            console.log('html2canvas 已加載');
            scriptsLoaded.html2canvas = true;
            checkAllScriptsLoaded();
          };
          document.head.appendChild(html2canvasScript);

          // 加載 jspdf
          const jspdfScript = document.createElement('script');
          jspdfScript.src = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js';
          jspdfScript.async = true;
          jspdfScript.onload = () => {
            console.log('jsPDF 已加載');
            scriptsLoaded.jspdf = true;
            checkAllScriptsLoaded();
          };
          document.head.appendChild(jspdfScript);

          const checkAllScriptsLoaded = () => {
            if (scriptsLoaded.html2canvas && scriptsLoaded.jspdf) {
              setLibrariesLoaded(true);
              console.log('所有 PDF 生成所需庫已加載完成');
            }
          };
        } catch (error) {
          console.error('腳本加載錯誤:', error);
        }
      };
      
      loadScripts();
    }
  }, []);

  useEffect(() => {
    if (user?.user_id) {
      // 獲取檔案資訊
      fetchLatestFileInfo();
      
      // 檢查 localStorage 是否有選中的檔案
      const storedFileId = localStorage.getItem('selectedFileId');
      const storedFileName = localStorage.getItem('selectedFileName');
      console.log('[DEBUG] localStorage 檢查:', { storedFileId, storedFileName });
      
      if (storedFileId && storedFileName) {
        console.log('[DEBUG] 設定選中檔案:', { fileId: storedFileId, fileName: storedFileName });
        setSelectedFileFromSundayGuide({ fileId: storedFileId, fileName: storedFileName });
        setSelectedFileUniqueId(storedFileId);
        setFileName(storedFileName);
        // 設定上傳時間為空，因為這是從其他頁面選擇的
        setUploadTime('');
      }
    }
  }, [user]);

  // 監聽跨頁面文件選擇變化
  useEffect(() => {
    // 使用 BroadcastChannel 監聽跨頁面文件選擇
    const channel = new BroadcastChannel('file-selection');
    
    const handleFileSelection = (event: MessageEvent) => {
      console.log('[DEBUG] 收到文件選擇廣播:', event.data);
      
      // 僅處理來自 Sunday Guide 模組的事件
      if (
        event.data &&
        event.data.type === 'FILE_SELECTED' &&
        event.data.fileId &&
        event.data.fileName &&
        // 若有 assistantId，需為 SUNDAY_GUIDE；若舊版本未帶 assistantId，亦允許
        (!event.data.assistantId || event.data.assistantId === ASSISTANT_IDS.SUNDAY_GUIDE)
      ) {
        console.log('[DEBUG] 其他頁面選中了檔案，準備重新載入頁面');
        console.log('[DEBUG] 選中檔案:', { fileId: event.data.fileId, fileName: event.data.fileName });
        
        // 延遲一下再重新載入，確保資料完全更新
        setTimeout(() => {
          window.location.reload();
        }, 100);
      }
    };

    channel.addEventListener('message', handleFileSelection);

    // 清理函數
    return () => {
      channel.removeEventListener('message', handleFileSelection);
      channel.close();
    };
  }, []);

  // 新增：監聽文件上傳完成的廣播，自動重新加載檔案列表
  useEffect(() => {
    const uploadChannel = new BroadcastChannel('file-upload-complete');
    
    const handleFileUploadComplete = (event: MessageEvent) => {
      console.log('[DEBUG] 收到文件上傳完成廣播:', event.data);
      
      if (event.data.type === 'FILE_UPLOAD_COMPLETE' && event.data.module === 'sunday-guide') {
        console.log('[DEBUG] /sunday-guide 上傳完成，準備重新加載檔案列表');
        console.log('[DEBUG] 上傳的檔案:', event.data.fileName);
        
        // 延遲一下再重新加載，確保後端資料已更新
        setTimeout(() => {
          if (user?.user_id) {
            console.log('[DEBUG] 重新加載檔案列表');
            fetchLatestFileInfo();
          }
        }, 500);
      }
    };

    uploadChannel.addEventListener('message', handleFileUploadComplete);

    // 清理函數
    return () => {
      uploadChannel.removeEventListener('message', handleFileUploadComplete);
      uploadChannel.close();
    };
  }, [user, isButtonClicked]);
  
  const handleModeSelect = async (mode: GuideMode) => {
    setSelectedMode(mode);
    setIsButtonClicked(true); // 設置按鈕已點擊
    setLoading(true);
    try {
      const userId = user?.user_id || '';
      // 優先使用從 /sunday-guide 選中的檔案 ID
      const targetFileId = selectedFileFromSundayGuide?.fileId || selectedFileUniqueId;
      
      console.log(`[DEBUG] 正在獲取 ${mode} 內容，用戶ID: ${userId}，檔案ID: ${targetFileId}`);
      console.log(`[DEBUG] selectedFileFromSundayGuide:`, selectedFileFromSundayGuide);
      console.log(`[DEBUG] selectedFileUniqueId:`, selectedFileUniqueId);
      
      // 如果有來自 Sunday Guide 的選擇，直接使用該檔案 ID 查詢
      if (selectedFileFromSundayGuide?.fileId) {
        console.log(`[DEBUG] 使用來自 Sunday Guide 的選擇: ${selectedFileFromSundayGuide.fileId}`);
        
        let apiUrl = `/api/sunday-guide/content/${ASSISTANT_IDS.SUNDAY_GUIDE}?type=${mode}&userId=${encodeURIComponent(userId)}&fileId=${encodeURIComponent(selectedFileFromSundayGuide.fileId)}`;
        
        console.log(`[DEBUG] API URL:`, apiUrl);
        
        const response = await fetch(apiUrl);
        
        // 處理 202 Processing 狀態
        if (response.status === 202) {
          const data = await response.json();
          alert(data.error || '內容正在生成中，請稍候...');
          return;
        }

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({ error: '未知錯誤' }));
          // 如果是後端返回的具體錯誤訊息，直接顯示
          if (errorData.error) {
            throw new Error(errorData.error);
          }
          throw new Error(`獲取內容失敗: ${response.status} - ${errorData.error || response.statusText}`);
        }
        
        const data = await response.json();
        console.log(`[DEBUG] 成功獲取 ${mode} 內容，長度: ${data.content?.length || 0}`);
        
        setSermonContent(data.content);
        
        // 更新當前文件資訊顯示
        setFileName(selectedFileFromSundayGuide.fileName);
        setUploadTime(''); // 來自其他頁面選擇，不顯示上傳時間
        
      } else {
        // 沒有來自 Sunday Guide 的選擇，使用原來的邏輯
        let apiUrl = `/api/sunday-guide/content/${ASSISTANT_IDS.SUNDAY_GUIDE}?type=${mode}&userId=${encodeURIComponent(userId)}`;
        if (targetFileId) {
          apiUrl += `&fileId=${encodeURIComponent(targetFileId)}`;
        }
        
        console.log(`[DEBUG] API URL:`, apiUrl);
        
        const response = await fetch(apiUrl);
        
        // 處理 202 Processing 狀態
        if (response.status === 202) {
          const data = await response.json();
          alert(data.error || '內容正在生成中，請稍候...');
          return;
        }

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({ error: '未知錯誤' }));
          // 如果是後端返回的具體錯誤訊息，直接顯示
          if (errorData.error) {
            throw new Error(errorData.error);
          }
          throw new Error(`獲取內容失敗: ${response.status} - ${errorData.error || response.statusText}`);
        }
        
        const data = await response.json();
        console.log(`[DEBUG] 成功獲取 ${mode} 內容，長度: ${data.content?.length || 0}`);
        
        setSermonContent(data.content);
        
        // 按下按鈕後即時更新最新文件資訊
        await fetchLatestFileInfo();
      }
      
      await refreshUsage();
    } catch (error) {
      console.error('獲取內容失敗:', error);
      // 添加用戶友好的錯誤提示
      alert(`獲取內容失敗: ${error instanceof Error ? error.message : '請稍後重試'}`);
    } finally {
      setLoading(false);
    }
  };

  // 獲取最新的文件資訊
  const fetchLatestFileInfo = async () => {
    try {
      const userId = user?.user_id || '';
      console.log(`[DEBUG] 正在獲取用戶 ${userId} 的最新文件資訊`);
      
      const response = await fetch(
        `/api/sunday-guide/documents?assistantId=${ASSISTANT_IDS.SUNDAY_GUIDE}&userId=${encodeURIComponent(userId)}`
      );
      
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ error: '未知錯誤' }));
        throw new Error(`獲取文件資訊失敗: ${response.status} - ${errorData.error || response.statusText}`);
      }
      
      const data = await response.json();
      console.log(`[DEBUG] 獲取到 ${data.records?.length || 0} 條文件記錄`);
      
      if (data.success && data.records && data.records.length > 0) {
        // 依照時間排序
        const sortedRecords = [...data.records].sort(
          (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
        );
        setFileList(sortedRecords.map(rec => ({
          fileName: rec.fileName || '未命名文件',
          uploadTime: rec.updatedAt,
          fileUniqueId: rec.fileUniqueId || rec.fileId // 兼容 fileId
        })));
        // 預設選擇最新一筆
        const latestRecord = sortedRecords[0];
        setFileName(latestRecord.fileName || '未命名文件');
        const uploadDate = new Date(latestRecord.updatedAt);
        setUploadTime(uploadDate.toLocaleDateString('en-US', { timeZone: 'America/Los_Angeles' }));
        setSelectedFileUniqueId(latestRecord.fileUniqueId || latestRecord.fileId);
      } else {
        setFileList([]);
        setFileName('尚未上傳文件');
        setUploadTime('');
        setSelectedFileUniqueId(null);
      }
    } catch (error) {
      console.error('獲取文件資訊失敗:', error);
      setFileName('獲取文件資訊失敗');
      setUploadTime('');
    }
  };

  useEffect(() => {
    // 組件加載時獲取最新的文件資訊
    fetchLatestFileInfo();
  }, [user]);

  // 將繁體中文轉換為簡體中文（改進版本）
  const convertToSimplified = (text: string): string => {
    if (!text) return '';
    
    try {
      return text.split('').map(char => traditionalToSimplified[char] || char).join('');
    } catch (error) {
      console.error('繁簡轉換出錯:', error);
      return text; // 出錯時返回原文
    }
  };

  // 下載包含所有內容的完整版本
  const handleDownloadPDF = () => {
    setPdfError(null);
    setPdfLoading(true);
    
    try {
      console.log('開始準備下載完整版...');
      
      const userId = user?.user_id || '';
      
      // 使用伺服器端API下載包含所有內容的HTML文件
      const downloadUrl = `/api/sunday-guide/download-pdf?includeAll=true&userId=${encodeURIComponent(userId)}&assistantId=${ASSISTANT_IDS.SUNDAY_GUIDE}`;
      
      // 在新分頁中打開下載URL
      window.open(downloadUrl, '_blank');
      
      console.log('完整版下載請求已發送');
      
      // 短暫延遲後重置加載狀態
      setTimeout(() => {
        setPdfLoading(false);
      }, 1000);
      
    } catch (error) {
      console.error('完整版PDF下載請求失敗:', error);
      setPdfError(error instanceof Error ? error.message : '下載完整版PDF時發生錯誤，請重試');
      alert('完整版PDF下載失敗: ' + (error instanceof Error ? error.message : '請稍後重試'));
      setPdfLoading(false);
    }
  };

  const renderContent = () => {
    if (loading) return <div className={styles.loading}>Loading, please wait...</div>;
    if (!sermonContent) return null;

    const titles = {
      summary: '讲道总结',
      text: '信息文字',
      devotional: '每日灵修',
      bible: '查经指引'
    };

    return (
      <div className={styles.contentBox}>
        <div className={styles.contentHeader}>
          <h2>{titles[selectedMode!]}</h2>
          <button 
            className={styles.downloadButton} 
            onClick={handleDownloadPDF}
            disabled={pdfLoading}
          >
            {pdfLoading ? '生成預覽中...' : '下载完整版(简体中文)'}
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
      <h1 className={styles.title}>主日信息导航</h1>
      {/* 極簡來源狀態提示 */}
      <div style={{ fontSize: '14px', color: '#4b5563', marginTop: 4, marginBottom: 8, textAlign: 'center' }}>
        当前使用最新上传的讲章作为解析来源
      </div>

      <div className={styles.buttonGroup}>
        <button 
          className={`${styles.modeButton} ${selectedMode === 'summary' ? styles.active : ''}`}
          onClick={() => handleModeSelect('summary')}
          disabled={!selectedFileUniqueId && !selectedFileFromSundayGuide}
        >
          信息总结
        </button>
        <button 
          className={`${styles.modeButton} ${selectedMode === 'devotional' ? styles.active : ''}`}
          onClick={() => handleModeSelect('devotional')}
          disabled={!selectedFileUniqueId && !selectedFileFromSundayGuide}
        >
          每日灵修
        </button>
        <button 
          className={`${styles.modeButton} ${selectedMode === 'bible' ? styles.active : ''}`}
          onClick={() => handleModeSelect('bible')}
          disabled={!selectedFileUniqueId && !selectedFileFromSundayGuide}
        >
          查经指引
        </button>
      </div>

      {/* 當用戶沒有可訪問的文件時顯示提示 */}
      {(!fileName || fileName === '尚未上傳文件' || fileName === '獲取文件資訊失敗') && (
        <div style={{ fontSize: '14px', color: '#ff6b6b', marginTop: 8, marginBottom: 16, textAlign: 'center', padding: '12px', backgroundColor: '#fff5f5', borderRadius: '8px', border: '1px solid #ffebee' }}>
          {fileName === '獲取文件資訊失敗' ? 
            '無法獲取文件資訊，請檢查網絡連接或聯繫管理員' : 
            '您尚未上傳任何文件，請先上傳文件後再使用此功能'
          }
        </div>
      )}

      {/* 內容顯示區域 - 隱藏直到有內容選擇 */}
      {sermonContent ? (
        <div className={styles.contentWrapper}>
          <div className={`${styles.contentArea} ${styles.hasContent}`}>
            {renderContent()}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default function UserSundayGuide() {
  const { user, loading } = useAuth();

  if (loading) {
    return <div>Loading, please wait...</div>;
  }

  if (!user) {
    return <div>请先登录</div>;
  }

  return (
    <WithChat chatType={CHAT_TYPES.SUNDAY_GUIDE} disableChatContext>
      <SundayGuideContent />
    </WithChat>
  );
}