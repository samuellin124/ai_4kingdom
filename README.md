# AI4Kingdom

## 简介
这是一个基于 Next.js 的AI聊天应用，支持多种对话类型。

## 初次运行项目流程

1. **克隆项目**
   ```bash
   git clone [项目地址]
   cd [项目目录]
   ```

2. **环境配置**
   创建 `.env.local` 文件：
   ```env
   NEXT_PUBLIC_REGION=your_aws_region
   NEXT_PUBLIC_USER_POOL_ID=your_cognito_user_pool_id
   NEXT_PUBLIC_USER_POOL_CLIENT_ID=your_cognito_client_id
   NEXT_PUBLIC_IDENTITY_POOL_ID=your_cognito_identity_pool_id
   NEXT_PUBLIC_API_URL=your_api_url
   NEXT_PUBLIC_API_KEY=your_api_key
   ```

3. **安装依赖**
   ```bash
   npm install
   ```

4. **配置 AWS Credentials**
   确保已配置 AWS 凭证，可以通过以下方式之一：
   - AWS CLI 配置
   - 环境变量设置
   - IAM 角色配置（如果在 AWS 服务上运行）

5. **启动开发服务器**
   ```bash
   npm run dev
   ```

6. **访问应用**
   打开浏览器访问 `http://localhost:3000`

## AI 后端架构（Responses API）

本项目已从 OpenAI Assistants API（2026 年 8 月移除）迁移至 **Responses API + Conversations**：

- **对话状态**：使用 OpenAI Conversations（`conv_...` ID），存储于 DynamoDB `ChatHistory` 表的 `threadId` 字段（沿用旧字段名）。旧的 `thread_...` ID 会在用户下次发消息时自动"懒迁移"为 conversation（近期消息一并搬迁），映射关系记录在 `ChatHistory` 表的 `__thread_migration__` 分区。
- **模型与指令**：不再有平台侧的 Assistant 对象。每次调用需指定 model/instructions，由 `app/lib/openai/profiles.ts` 解析：优先读取 `app/config/assistantProfiles.ts` 快照，其次实时抓取旧 assistant 配置（日落前有效），兜底用 `OPENAI_RESPONSES_MODEL` 环境变量（默认 `gpt-5.6-terra`）。
- **⚠️ 日落前必做**：执行 `node scripts/export-assistant-profiles.mjs` 将平台上各 assistant 的 model/instructions 导出到 `app/config/assistantProfiles.ts` 并提交，否则 Assistants API 移除后将丢失平台侧配置的指令。
- **文件检索（RAG）**：Vector Store 不受影响，继续使用；绑定方式为每次调用时传 `tools: [{ type: 'file_search', vector_store_ids: [...] }]`（见 `app/lib/openai/responses.ts`）。
- **共享工具库**：`app/lib/openai/`（client.ts / profiles.ts / conversation.ts / responses.ts）。内容生成统一走 `generateResponse()`，无需再建线程、轮询 run 状态。

### 新增聊天类型时的 AI 配置

不再需要在 OpenAI 后台创建 Assistant。两种方式：

1. **推荐**：在 `app/config/assistantProfiles.ts` 的 `ASSISTANT_PROFILE_OVERRIDES` 中添加一个条目（key 可以是任意唯一标识符，形如 `asst_xxx` 的旧 ID 或自定义字符串），指定 `model` 和 `instructions`，然后在 `constants.ts` 的 `ASSISTANT_IDS` 中引用该 key。
2. 兼容方式：沿用现有 `ASSISTANT_IDS` 中的旧 assistant ID —— 系统会自动解析其 model/instructions。

## 创建新页面的流程

1. **定义页面类型**
   在 `app/config/chatTypes.ts` 中：
   ```typescript
   // 添加新的聊天类型
   export const CHAT_TYPES = {
     // ... existing types ...
     NEW_CHAT: 'new-chat'  // 将 'new-chat' 替换为你的聊天类型标识符
   } as const;

   // 更新类型定义
   export type ChatType = 'general' | 'new-chat';  // 添加你的聊天类型

   // 添加配置
   export const CHAT_TYPE_CONFIGS: Record<ChatType, ChatTypeConfig> = {
     'new-chat': {  // 将 'new-chat' 替换为你的聊天类型标识符
       type: 'new-chat',  // 保持与上面相同
       title: '新聊天',  // 修改为你的聊天页面标题
       description: '新聊天的描述',  // 修改为你的聊天页面描述
       assistantId: ASSISTANT_IDS.NEW_CHAT,
       vectorStoreId: VECTOR_STORE_IDS.NEW_CHAT
     }
   };
   ```

2. **配置助手和向量存储 ID**
   在 `app/config/constants.ts` 中：
   ```typescript
   export const ASSISTANT_IDS = {
     NEW_CHAT: 'your_assistant_id_here'  // 替换为你的 OpenAI Assistant ID
   };

   export const VECTOR_STORE_IDS = {
     NEW_CHAT: 'your_vector_store_id_here'  // 替换为你的向量存储 ID
   };
   ```

3. **创建新的聊天页面**
   
   a. 创建页面组件文件 `app/new-chat/page.tsx`：
   ```typescript
   'use client';

   import WithChat from '../components/layouts/WithChat';
   import Chat from '../components/Chat/Chat';
   import { ASSISTANT_IDS, VECTOR_STORE_IDS } from '../config/constants';
   import styles from './page.module.css';  // 导入样式

   export default function NewChatPage() {
     return (
       <div className={styles.container}>
         <div className={styles.content}>
           <div className={styles.chatContainer}>
             <WithChat chatType="new-chat">
               <Chat
                 type="new-chat"
                 assistantId={ASSISTANT_IDS.NEW_CHAT}
                 vectorStoreId={VECTOR_STORE_IDS.NEW_CHAT}
               />
             </WithChat>
           </div>
         </div>
       </div>
     );
   }
   ```

   b. 创建样式文件 `app/new-chat/page.module.css`：
   ```css
   .container {
     display: flex;
     flex-direction: column;
     height: 100vh;
     width: 100%;
     padding: 1rem;
     background-color: #ffffff;
   }

   .content {
     display: flex;
     flex-direction: column;
     gap: 20px;
     flex: 1;
     min-height: 0;
   }

   .chatContainer {
     flex: 1;
     display: flex;
     min-height: 400px;
     background: white;
     border-radius: 12px;
     box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
     overflow: hidden;
   }

   .chatContainer > div {
     flex: 1;
     display: flex;
     width: 100%;
     height: 100%;
   }

   /* 适配移动端 */
   @media (max-width: 768px) {
     .container {
       height: calc(100vh - 56px);
       padding: 0.5rem;
     }
   }
   ```

4. **添加权限控制**
   在 `app/types/auth.ts` 中：
   ```typescript
   export type FeatureKey = 'chat' | 'new_chat';  // 将 new_chat 替换为你的功能键名

   export const FEATURE_ACCESS: Record<FeatureKey, MemberRole[]> = {
     new_chat: ['free_member', 'pro_member', 'ultimate_member']  // 根据需要调整访问权限级别
   };
   ```

5. **连接到WordPress服务器**
   credentials能在aws lightsail中找到

6. **添加 WordPress Shortcode**
   在服务器的 `/bitnami/wordpress/wp-content/themes/hello-biz/function.php` 中添加：
   ```php
   // 注册新的 iframe shortcode
   add_shortcode('new_chat_iframe', function($atts) {
       if (!is_user_logged_in()) {
           return '<div class="notice notice-warning">请先登录查看内容</div>';
       }
       
       $current_user = wp_get_current_user();
       $user_id = $current_user->ID;
       
       $additional_params = isset($atts['params']) ? wp_parse_args($atts['params']) : [];
       $query_params = array_merge([
           'userId' => $user_id,
           'nonce' => wp_create_nonce('wp_rest')
       ], $additional_params);
       
      $base_url = 'https://main.d1b5nk0vz3t0hz.amplifyapp.com/new-chat';  // 替换为你的新聊天页面路径
       $iframe_url = $base_url . '/?' . http_build_query($query_params);
       
       return get_iframe_html('new-chat-module', $iframe_url);  // 替换为你的模块名称
   });
   ```

   > 注意：
   > - 将 `new_chat_iframe` 替换为你想要的 shortcode 名称
   > - 将 `/new-chat` 替换为你的新页面路径
   > - 将 `new-chat-module` 替换为你的模块名称

7. **使用 Shortcode**
   在 WordPress 页面中使用：
   ```
   [new_chat_iframe]
   ```

## 运行项目
1. 安装依赖：
   ```bash
   npm install
   ```

2. 启动开发服务器：
   ```bash
   npm run dev
   ```

3. 打开浏览器访问 `http://localhost:3000`。

## 许可证
MIT