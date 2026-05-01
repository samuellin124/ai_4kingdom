// 刪除 Thread 中的特定訊息
import OpenAI from 'openai';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

async function deleteMessage() {
  const threadId = 'thread_FW8XgtEOc54kUuGvmKCfFwzD';
  const messageId = 'msg_TVSqGk3UpCjtwbVwMoK6hc69'; // 從 console 看到的那條訊息 ID
  
  try {
    console.log(`正在刪除 Thread ${threadId} 中的訊息 ${messageId}...`);
    
    const response = await openai.beta.threads.messages.del(
      threadId,
      messageId
    );
    
    console.log('訊息已刪除:', response);
  } catch (error) {
    console.error('刪除失敗:', error);
  }
}

deleteMessage();
