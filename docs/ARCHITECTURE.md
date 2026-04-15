# Architecture

## Overview

The app is a desktop pipeline for ecommerce image generation:

1. Renderer creates a task.
2. Main process starts an agent loop.
3. Agent calls tools:
   - `generate_image` (Gemini)
   - `evaluate_image` (Python judge via Anthropic)
4. Loop retries until score threshold is met or retries are exhausted.
5. Task status/cost/score are persisted to SQLite and streamed back to renderer via IPC.

## Runtime Layers

### Renderer (`src/renderer`)

- React + Zustand UI.
- Uses `window.api` only (from preload).
- Pages:
  - `Dashboard`: task list and stats
  - `TaskRun`: single/batch run + terminal stream + score gauge
  - `Gallery`: generated images
  - `Templates`: prompt template CRUD
  - `Settings`: API key and model/base-url config

### Preload (`src/preload/index.ts`)

- Exposes typed IPC methods with `contextBridge`.
- Defines the only allowed renderer bridge surface.

### Main (`src/main`)

- `index.ts`: app bootstrap, window creation, DB migrations, handler registration.
- `ipc/*`: request/response handlers.
- `agent/*`: core loop, MCP tools, prompt builder, Python bridge.
- `db/*`: SQLite client, migrations, queries.

### Python (`python/vlmeval_server.py`)

- Long-running JSONL service (stdin/stdout).
- Evaluates generated images with Anthropic model and returns structured scores.

## Core Data Flow

## 1) Task Start

- Renderer calls `TASK_START`.
- Main:
  - decrypts keys from config table (via `safeStorage`),
  - starts Python bridge once (lazy init),
  - inserts task row (`running`),
  - launches `runAgentLoop` asynchronously.

## 2) Agent Loop

Implemented in `src/main/agent/runner.ts`.

Key constants:

- `MAX_RETRIES = 3`
- `SCORE_THRESHOLD = 85`
- cost estimation:
  - input token: `3 / 1_000_000`
  - output token: `15 / 1_000_000`

Per round:

1. Build system prompt (`prompt-builder.ts`), optionally injecting previous defect analysis.
2. Ask Anthropic model with tool definitions.
3. Execute tool calls returned by model:
   - `generate_image` -> returns local image path
   - `evaluate_image` -> returns `total_score` + `defect_analysis`
4. Emit loop event to renderer.
5. If score >= 85:
   - copy image to `ready_to_publish/`
   - persist success state.
6. Else retry with defect feedback.
7. On final failure:
   - copy last image to `failed/`
   - persist failed state.

Abort behavior:

- `TASK_STOP` aborts `AbortController` per task.
- Loop checks `signal.aborted` and exits gracefully.

## 3) Event Streaming

- Main emits `AGENT_LOOP_EVENT` with:
  - `phase` (`thought | act | observe | success | failed`)
  - message, score, retry count, timestamp, optional cost/defect analysis.
- Renderer consumes this in `TerminalPane` and `agent.store`.

## Persistence Model

SQLite DB path:

- `app.getPath('userData')/ecom-agent.db`

Tables:

- `tasks`: lifecycle, scoring, image path, cost, timestamps
- `templates`: prompt templates
- `config`: encrypted values (API keys and optional model/base URL)

Migrations:

- `001_create_tasks`
- `002_create_templates`

DB settings:

- WAL mode enabled
- foreign keys enabled

## IPC Contract

Channels are defined in `src/shared/ipc-channels.ts` and must stay in sync with preload and handlers:

- task: start/stop/list
- agent: loop event stream
- config: get/set
- app: user data path
- template: save/list/delete

Cross-process payload types are defined in `src/shared/types.ts`.

## File and Directory Outputs

Runtime output folders under `app.getPath('userData')`:

- `tmp_images/` (generated temporary images)
- `ready_to_publish/` (successful results)
- `failed/` (final failed result snapshot)

## Key Constraints

- Security boundary assumptions:
  - `contextIsolation: true`
  - `nodeIntegration: false`
- Renderer must not access Node APIs directly.
- Secrets must remain in encrypted `config` storage (no plaintext persistence).
- Python bridge protocol is line-delimited JSON; every request must carry unique `request_id`.
- Evaluation timeout is fixed at 120s per request (`VLMEvalBridge`).

## Known Gaps / Risks

- A number of Chinese UI/log strings are currently garbled due to encoding issues.
- `templateId` is part of task input but not fully integrated into runtime prompt selection.
- Current baseline has TypeScript typecheck issues in renderer (`JSX` namespace errors).
