'use client';

import { useEffect, useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import Chat from "../components/Chat/Chat";
import { CHAT_TYPES } from "@/app/config/chatTypes";
import { ASSISTANT_IDS, VECTOR_STORE_IDS } from "../config/constants";
import { ChatProvider, useChat } from '../contexts/ChatContext';
import WithChat from '../components/layouts/WithChat';
import styles from './Homeschool.module.css';

function HomeschoolContent() {
    const { user, loading: authLoading } = useAuth();
    const { setConfig } = useChat();
    const [threadId, setThreadId] = useState<string | null>(null);
    const [isLoading, setIsLoading] = useState(true);

    useEffect(() => {
        async function fetchThreadId() {
            if (!user?.user_id) return;

            try {
                const response = await fetch(`/api/homeschool-prompt?userId=${user.user_id}`);
                console.log('[DEBUG] /api/homeschool-prompt response:', response);
                if (response.ok) {
                    const data = await response.json();
                    console.log('[DEBUG] /api/homeschool-prompt data:', data);
                    if (data.threadId) {
                        setThreadId(data.threadId);
                        setConfig({
                            type: CHAT_TYPES.HOMESCHOOL,
                            assistantId: ASSISTANT_IDS.HOMESCHOOL,
                            vectorStoreId: VECTOR_STORE_IDS.HOMESCHOOL,
                            threadId: data.threadId,
                            userId: user?.user_id
                        });
                    }
                }
            } catch (error) {
                console.error('获取 Thread ID 失败:', error);
            } finally {
                setIsLoading(false);
            }
        }

        if (user?.user_id) {
            fetchThreadId();
        }
    }, [user?.user_id, setConfig]);

    useEffect(() => {
        const handleUpdate = () => {
            window.location.reload(); // 直接整頁重載
        };
        // 新增 storage 事件監聽，支援跨分頁同步
        const handleStorage = (e: StorageEvent) => {
            if (e.key === 'homeschool_data_updated') {
                handleUpdate();
            }
        };
        window.addEventListener('homeschool_data_updated', handleUpdate);
        window.addEventListener('storage', handleStorage);
        return () => {
            window.removeEventListener('homeschool_data_updated', handleUpdate);
            window.removeEventListener('storage', handleStorage);
        };
    }, [user?.user_id, setConfig]);

    if (authLoading || isLoading) {
        return <div>加载中...</div>;
    }

    if (!user) {
        return <div>请先登录后使用</div>;
    }

    return (
        <div className={styles.container}>
            <Chat 
                key={threadId || 'empty'} // 讓 threadId 變動時 Chat 強制 remount
                type={CHAT_TYPES.HOMESCHOOL}
                assistantId={ASSISTANT_IDS.HOMESCHOOL}
                vectorStoreId={VECTOR_STORE_IDS.HOMESCHOOL}
                threadId={threadId}
                userId={user.user_id}
            />
        </div>
    );
}

export default function Homeschool() {
    const { user, loading } = useAuth();
    
    console.log('[DEBUG] Homeschool页面初始化:', {
        userId: user?.user_id,
        assistantId: ASSISTANT_IDS.HOMESCHOOL,
        vectorStoreId: VECTOR_STORE_IDS.HOMESCHOOL
    });
    
    if (loading) {
        return <div>Loading, please wait...</div>;
    }
    
    if (!user) {
        return <div>请先登录</div>;
    }

    return (
        <WithChat chatType={CHAT_TYPES.HOMESCHOOL}>
            <HomeschoolContent />
        </WithChat>
    );
}