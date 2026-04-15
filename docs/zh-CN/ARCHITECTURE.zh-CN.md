# 架构文档（中文）

## 概述

该应用是一个电商图片生成与质量评估的桌面化闭环系统。

流程摘要：

1. 渲染层发起任务
2. 主进程启动 Agent 循环
3. Agent 调用生成与评估工具
4. 循环重试直到达标或耗尽重试
5. 结果入库并通过 IPC 回流到渲染层

## 运行时分层

### 渲染层（`src/renderer`）

- React + Zustand 界面层
- 仅通过 `window.api` 调用能力
- 主要页面：
  - Dashboard
  - TaskRun
  - Gallery
  - Templates
  - Settings

### Preload（`src/preload/index.ts`）

- 通过 `contextBridge` 暴露类型化 API
- 定义渲染层可访问边界

### 主进程（`src/main`）

- `index.ts`：启动、迁移、窗口、处理器注册
- `ipc/*`：IPC 处理器
- `agent/*`：循环与工具编排、Python 桥接
- `db/*`：SQLite 客户端、迁移、查询

### Python 服务（`python/vlmeval_server.py`）

- 基于 stdin/stdout 的常驻 JSONL 服务
- 负责视觉评估（Anthropic 模型）

## 核心数据流

### 任务启动

- 渲染层调用 `TASK_START`
- 主进程解密配置密钥，按需启动 Python 桥，插入任务记录并异步启动 Agent 循环

### Agent 循环（`src/main/agent/runner.ts`）

关键常量：

- `MAX_RETRIES = 3`
- `SCORE_THRESHOLD = 85`
- 输入 token 成本：`3 / 1_000_000`
- 输出 token 成本：`15 / 1_000_000`

每轮流程：

1. 构建系统提示词（可带上轮缺陷反馈）
2. 调用 Anthropic 模型并传入工具定义
3. 执行返回的工具调用：
   - `generate_image`
   - `evaluate_image`
4. 向渲染层推送循环事件
5. 根据分数执行成功/失败落库与图片归档

中止机制：

- `TASK_STOP` 触发 `AbortController`
- 循环内检查 `AbortSignal` 并安全退出

### 事件流

- 主进程发送 `AGENT_LOOP_EVENT`
- 渲染层在终端面板与 store 中消费事件

## 持久化

SQLite 路径：

- `app.getPath('userData')/ecom-agent.db`

主要表：

- `tasks`
- `templates`
- `config`

迁移：

- `001_create_tasks`
- `002_create_templates`
- `003_add_image_fields`

数据库设置：

- WAL 模式
- 外键开启

## IPC 契约

通道定义集中在 `src/shared/ipc-channels.ts`，由 preload/main/renderer 共同使用。

领域：

- task：start/stop/list
- agent：loop events
- config：get/set
- app：user data path
- template：save/list/delete

负载类型定义在 `src/shared/types.ts`。

## 运行时文件输出

位于 `app.getPath('userData')` 下：

- `tmp_images/`
- `ready_to_publish/`
- `failed/`

## 关键约束

- 必须保持安全边界：
  - `contextIsolation: true`
  - `nodeIntegration: false`
- 渲染层禁止直接访问 Node 能力
- 密钥必须加密后存入本地数据库
- Python 桥协议为逐行 JSON，且需唯一 `request_id`
- 单次评估超时为 120 秒

## 已知风险

- 历史编码问题导致部分中文字符串乱码
- `templateId` 尚未完全打通至运行时 prompt 选择
- 当前基线存在渲染层 TypeScript 类型检查问题（`JSX` 命名空间）
