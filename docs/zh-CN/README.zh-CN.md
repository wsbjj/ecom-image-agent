# 产品指南（中文）

## 概述

Ecom Image Agent 是一个基于 Electron 的电商图片生成与视觉评估桌面应用。

应用采用 ReAct 闭环：

1. 生成图片
2. 评估图片
3. 基于缺陷反馈重试，直到达标或达到最大重试次数

## 主要功能

- ReAct 自动重试闭环
- Python 服务 + Anthropic 模型进行视觉评估
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

3. 启动应用：

```bash
npm run dev
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

## 运行时输出目录

位于 `app.getPath('userData')` 下：

- `tmp_images/`
- `ready_to_publish/`
- `failed/`
- `ecom-agent.db`

## 说明

- API Key 会先加密后写入本地 SQLite（`config` 表），不是 JSON 配置文件。
- 当前代码中存在部分中文乱码字符串，属于历史编码问题。
