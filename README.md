# EcomAgent — 电商精品图生成与视觉评估 Agent

基于 Electron + Claude Agent SDK 的桌面应用，通过 ReAct 循环自动生成电商精品图并评估质量，直到达到发布标准。

## 功能特性

- **ReAct 循环**：自动执行「生成 → 评估 → 修正」三步循环，最多重试 3 次
- **视觉评估**：通过 VLMEvalKit + Anthropic 模型（`.env` 可配置）对图片进行三维度评分（边缘畸变 / 透视光影 / 幻觉物体）
- **实时日志**：xterm.js 终端实时展示 Agent 循环状态和评分结果
- **成本追踪**：每轮循环记录 token 消耗，写入数据库可做 ROI 分析
- **安全存储**：所有 API Key 通过 Electron safeStorage 加密存储，不写入任何文件
- **批量导入**：支持 CSV / JSON 任务矩阵批量启动
- **提示词模板**：Monaco Editor 在线编辑和管理 system_prompt 模板

## 环境要求

| 工具 | 最低版本 | 说明 |
|------|---------|------|
| Node.js | 22.x LTS | 主进程和构建工具 |
| Python | 3.11+ | VLMEvalKit 评估服务 |
| pip | 24.x | Python 依赖管理 |
| Git | 2.x | 版本管理 |

**API Key 要求：**
- `ANTHROPIC_API_KEY`：Claude Agent SDK + VLMEvalKit judge 模型调用
- `GOOGLE_API_KEY`：Gemini 图像生成 API

## 安装步骤

### 1. 克隆仓库

```bash
git clone https://github.com/your-org/ecom-image-agent.git
cd ecom-image-agent
```

### 2. 安装 Node.js 依赖

```bash
npm install
```

### 3. 安装 Python 依赖

建议使用虚拟环境：

```bash
cd python
python -m venv .venv

# macOS / Linux
source .venv/bin/activate

# Windows
.venv\Scripts\activate

pip install -r requirements.txt
```

### 4. 验证 Python 安装

```bash
python vlmeval_server.py --workdir /tmp/test
# 应输出：[VLMEval] 服务启动，等待请求...
# Ctrl+C 退出
```

### 5. 配置 Python 评估服务 `.env`

在 `python/.env` 中配置以下变量：

```bash
ANTHROPIC_API_KEY=your_api_key
ANTHROPIC_BASE_URL=
ANTHROPIC_MODEL=claude-3-5-sonnet-20241022
```

- `ANTHROPIC_BASE_URL`：可选，使用代理/网关时填写自定义地址
- `ANTHROPIC_MODEL`：可选，默认 `claude-3-5-sonnet-20241022`

## 快速启动

### 开发模式

```bash
npm run dev
```

启动后会打开 Electron 窗口。首次启动请先在 **Settings** 页面配置 API Key。

### 配置 API Key

1. 打开应用 → 点击左侧「设置」
2. 填入 `Anthropic API Key` 和 `Google API Key`
3. 点击「保存」（密钥通过 safeStorage 加密存储，不会写入文件）

### 生产构建

```bash
# macOS
npm run build:mac

# Windows
npm run build:win

# Linux
npm run build:linux
```

构建产物在 `dist/` 目录。

### 运行测试

```bash
# 单元测试
npm run test

# 监听模式
npm run test:watch

# 覆盖率报告
npm run test:coverage
```

## 使用流程

### 单任务模式

1. 进入 **仪表盘** → 点击「新建任务」
2. 填写商品名称、SKU、拍摄场景
3. 点击「开始生成」，在 **任务执行** 页面查看 xterm 实时日志
4. 评分 >= 85 分时，图片自动保存至「待发布」目录

### 批量导入模式

1. 进入 **任务执行** → 点击「批量导入」
2. 上传 CSV 或 JSON 任务矩阵文件
3. 确认导入后批量启动

**CSV 格式示例：**

```csv
sku_id,product_name,context,template_id
SKU001,北欧陶瓷杯,侧逆光极简场景,1
SKU002,皮革钱包,暖光产品摄影台,2
```

### 提示词模板管理

进入 **提示词模板** 页面，可用 Monaco Editor 编辑 system_prompt，支持 JSON 格式校验。

## 图片输出目录

所有输出目录位于 Electron userData 路径下：

| 目录 | 说明 |
|------|------|
| `tmp_images/` | 每轮生成的临时图片 |
| `ready_to_publish/` | 评分 >= 85 的合格图片 |
| `failed/` | 重试耗尽后的最终图片 |

**userData 路径：**
- macOS：`~/Library/Application Support/ecom-image-agent/`
- Windows：`%APPDATA%\ecom-image-agent\`
- Linux：`~/.config/ecom-image-agent/`

## 架构简介

```
渲染进程 (React 19)
    ↕ contextBridge
preload/index.ts
    ↕ IPC (ipcMain / ipcRenderer)
主进程 (Electron Main)
    ├── agent/runner.ts          ReAct 循环
    ├── agent/mcp-server.ts      generate_image + evaluate_image MCP 工具
    ├── agent/vlmeval-bridge.ts  Python 子进程通信桥
    └── db/client.ts             SQLite (Kysely WAL)
    
python/vlmeval_server.py        VLMEvalKit JSON Lines 服务
```

## 技术栈

- **桌面框架**：Electron 34 + electron-vite
- **前端**：React 19 + TypeScript 5.8 + Tailwind CSS 4
- **状态管理**：Zustand 5 (subscribeWithSelector)
- **Agent SDK**：@anthropic-ai/sdk
- **图像生成**：Google Gemini API (@google/generative-ai)
- **视觉评估**：Python + Anthropic（模型由 `.env` 配置）
- **数据库**：SQLite + Kysely (WAL mode)
- **终端**：xterm.js + WebGL/Canvas Addon
- **代码编辑器**：Monaco Editor
- **测试**：Vitest + Testing Library

## 常见问题

**Q: 启动后 xterm 没有输出？**
检查 Settings 页面是否已保存 API Key，以及 Python vlmeval_server.py 是否可正常运行。

**Q: 评分始终低于 85？**
尝试在 Templates 页面调整 system_prompt，增加更详细的场景描述和风格关键词。

**Q: Windows 下 Python 子进程启动失败？**
确保 `python` 命令在 PATH 中可用，并已激活虚拟环境安装了依赖。

**Q: 如何重置所有数据？**
删除 userData 目录下的 `ecom-agent.db` 文件，重启应用会重新执行数据库迁移。

**Q: 如何查看 token 费用？**
每个任务的累计费用显示在 Dashboard 表格的「费用」列，也会在 xterm 终端实时输出。

## License

MIT
