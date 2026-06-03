# Telegram 插件记忆系统设计

## 设计目标

为 Telegram Bridge 插件实现一个三层记忆架构，让 AI 能够：
1. 跨重启保持对话上下文
2. 自动压缩历史对话释放上下文窗口
3. 长期记住用户偏好和关键信息

## 架构概览

```
┌─────────────────────────────────────────────────────┐
│                   用户在 Telegram 聊天                │
└─────────────────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────┐
│              telegram-bridge.ts (Node.js)            │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐ │
│  │ 短期记忆    │  │ 中期记忆    │  │ 长期记忆    │ │
│  │ (Session)   │  │ (Compact)   │  │ (Memory)    │ │
│  └─────────────┘  └─────────────┘  └─────────────┘ │
└─────────────────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────┐
│              ~/.pi/agent/ 存储结构                   │
├─────────────────────────────────────────────────────┤
│  sessions/telegram/                                 │
│  ├── chat-123456.jsonl       # 对话历史              │
│  └── chat-789012.jsonl       # 其他用户              │
├─────────────────────────────────────────────────────┤
│  memory/telegram/                                   │
│  ├── chat-123456/                                    │
│  │   ├── profile.json        # 用户画像              │
│  │   ├── projects.json       # 项目信息              │
│  │   └── knowledge.json      # 知识点                │
│  └── ...                                             │
└─────────────────────────────────────────────────────┘
```

## 三层记忆详细设计

### 第一层：短期记忆 - 会话持久化

**实现方式**：
- 为每个 Chat ID 创建专属 JSONL 文件
- 启动参数：`--mode rpc --session ~/.pi/agent/sessions/telegram/chat-{chatId}.jsonl`
- Bridge 重启时使用 `--continue` 恢复最近会话

**触发条件**：无（自动）

**存储位置**：`~/.pi/agent/sessions/telegram/`

---

### 第二层：中期记忆 - 自动压缩归档

**触发条件**（任一满足即触发）：
- 对话轮数达到 50 轮
- 距离上次压缩超过 2 小时
- 手动执行 `/compact` 命令

**压缩流程**：
1. 调用 pi 的 RPC 命令 `compact`
2. AI 自动将前 40 轮对话总结成摘要
3. 最近 10 轮保持完整细节
4. 摘要注入上下文开头，保持连贯性

**存储位置**：内嵌在会话 JSONL 文件中

---

### 第三层：长期记忆 - 跨会话知识库

**提取时机**：每次 `agent_end` 事件后

**提取内容**：
```json
{
  "user_profile": {
    "preferred_languages": ["TypeScript", "Python"],
    "preferred_frameworks": ["React", "FastAPI"],
    "coding_style": "functional",
    "timezone": "Asia/Shanghai"
  },
  "active_projects": [
    {
      "name": "pi-telegram",
      "description": "Telegram bridge plugin",
      "last_discussed": "2025-06-03",
      "status": "active development"
    }
  ],
  "knowledge": [
    "用户习惯使用 /compact 手动压缩",
    "用户偏好简洁回复，不喜欢冗长解释",
    "用户主要在 macOS 环境开发"
  ]
}
```

**注入时机**：每次 `session_start` 事件时

**注入方式**：通过修改 System Prompt，将历史记忆注入上下文

**存储位置**：`~/.pi/agent/memory/telegram/chat-{chatId}/`

## 用户命令

| 命令 | 说明 |
|------|------|
| `/compact` | 手动触发压缩 |
| `/clear` | 清空当前会话，创建新会话 |
| `/memory` | 查看当前记忆内容 |
| `/export-memory` | 导出记忆为 JSON 文件 |
| `/import-memory <file>` | 从文件导入记忆 |

## 技术实现路径

| 阶段 | 功能 | 优先级 | 复杂度 |
|------|------|--------|--------|
| Phase 1 | 启用会话持久化 | P0 | 低 |
| Phase 2 | 自动压缩归档 | P1 | 中 |
| Phase 3 | 长期记忆提取与注入 | P2 | 高 |
