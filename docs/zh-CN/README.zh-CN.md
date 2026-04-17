# 产品指南（中文）

## 概述

Ecom Image Agent 是一个基于 Electron 的电商图片生成与视觉评估桌面应用。

应用采用 ReAct 闭环：

1. 生成图片
2. 评估图片
3. 基于缺陷反馈重试，直到达标或达到最大重试次数

## 主要功能

- ReAct 自动重试闭环
- Python 服务 + `custom_anthropic` / `vlmevalkit` 双后端视觉评估
- 终端面板实时事件流
- 任务级成本统计（基于 token 估算）
- 本地密钥加密存储（Electron `safeStorage`）
- CSV/JSON 批量导入
- Monaco 模板编辑管理

## 环境要求

- Node.js：22.x
- Python：3.11+
- pip
- Git

必填密钥：

- `ANTHROPIC_API_KEY`
- `GOOGLE_API_KEY`

Judge 专用配置（可选，未配置时会回退到 `ANTHROPIC_*`）：

- `JUDGE_API_KEY`
- `JUDGE_BASE_URL`
- `JUDGE_MODEL`

可选覆盖项：

- `ANTHROPIC_BASE_URL`
- `ANTHROPIC_MODEL`
- `GOOGLE_BASE_URL`
- `GOOGLE_IMAGE_MODEL`

## 安装与启动

1. 安装 Node 依赖：

```bash
npm install
```

2. 安装 Python 依赖：

```bash
cd python
python -m venv .venv
# Windows
.venv\Scripts\activate
pip install -r requirements.txt
```

如需使用 `EVAL_BACKEND=vlmevalkit`，应用会按需从官方 Git 源安装 VLMEvalKit：

```bash
pip install git+https://github.com/open-compass/VLMEvalKit.git@v0.3rc1
```

注意：不是 `pip install vlmeval`。

配置职责建议：

- `ANTHROPIC_*`：用于 `claude_sdk` 编排、Anthropic draft fallback、评估模板 AI 草稿。
- `JUDGE_*`：仅用于 `evaluate_image` 视觉评测 Judge。

3. 启动应用：

```bash
npm run dev
```

Windows 终端若出现 `浣跨敤...` 这类乱码，优先使用 UTF-8 启动脚本：

```bash
npm run dev:win:utf8
```

## 构建与测试

```bash
npm run build
npm run build:win
npm run build:mac
npm run build:linux
npm run test
npm run test:watch
npm run test:coverage
```

## 模板编写说明

- 评估模板 Markdown 编写说明：[`docs/zh-CN/EVAL_TEMPLATE_MARKDOWN_GUIDE.zh-CN.md`](./EVAL_TEMPLATE_MARKDOWN_GUIDE.zh-CN.md)
- VLMEvalKit 模型支持与选型：[`docs/zh-CN/VLMEVALKIT_MODEL_GUIDE.zh-CN.md`](./VLMEVALKIT_MODEL_GUIDE.zh-CN.md)

## 运行时输出目录

位于 `app.getPath('userData')` 下：

- `tmp_images/`
- `ready_to_publish/`
- `failed/`
- `ecom-agent.db`

## 快速测试：载入上次任务输入

在 `任务执行` 页（单任务模式）可以使用 `载入上次` 按钮，快速回填最近一次通过前端校验并尝试启动时的输入快照，减少重复填表时间。

回填字段包含：

- SKU
- 商品名
- 场景描述
- 商品图
- 参考图
- 自定义提示词
- 评估模板
- 阈值覆盖

注意事项：

- 点击 `载入上次` 只回填输入，不会自动启动任务，仍需手动点击 `开始生成`。
- 回填时会校验图片路径可读性，失效路径会自动清空并提示。
- 如果清理后商品图为空，任务会保持不可启动状态，需要先补图。
- 快照仅保存输入参数，不包含运行结果或状态（如 taskId、轮次预览、评分、日志等），每次任务仍是独立执行。

## 说明

- API Key 会先加密后写入本地 SQLite（`config` 表），不是 JSON 配置文件。
- 当前代码中存在部分中文乱码字符串，属于历史编码问题。
