# 贡献指南（中文）

本仓库是一个电商图片生成与质量评估的 Electron 桌面应用。

## 前置要求

- Node.js `22.x`
- npm
- Python `3.11+`
- pip

## 本地开发准备

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

3. 启动开发环境：

```bash
npm run dev
```

## 开发流程

1. 从 `main` 拉出聚焦分支。
2. 每次改动只解决一个主题（功能/修复/重构）。
3. 改代码要同步补测试。
4. 提交前执行校验命令。
5. 使用清晰的提交信息。

## 提交前校验

```bash
npm run test
npm run typecheck
```

当前基线说明：

- `npm run test` 通过。
- `npm run typecheck` 当前在渲染层存在 `Cannot find namespace 'JSX'` 基线问题。请不要引入新的类型错误。

## 代码约定

- 保持 TypeScript 严格模式，避免无必要 `any`。
- 跨进程契约统一使用 `src/shared/types.ts` 与 `src/shared/ipc-channels.ts`。
- 渲染层仅通过 `window.api` 访问能力。
- 特权逻辑放在 `src/main`。
- Agent 业务逻辑放在 `src/main/agent`。
- 数据库逻辑放在 `src/main/db`。
- 不要提交密钥和本地运行产物。

## 测试范围

- 渲染层：`tests/renderer/**`
- 主进程/共享层：`tests/main/**`

## 提交信息示例

- `feat: add batch task validation`
- `fix: handle vlmeval timeout in runner`
- `chore: update ipc channel typing`
- `docs: clarify architecture constraints`

## 安全要求

- 禁止打印原始 API Key。
- 密钥必须继续通过加密存储链路（`safeStorage` + 数据库 config 表）。
- 保持 `contextIsolation: true` 与 `nodeIntegration: false` 的安全边界假设。

## 已知约束

- 当前存在部分中文乱码字符串（历史编码问题）。
- `templateId` 已在输入中定义，但尚未完全打通到运行时 prompt 选择链路。
