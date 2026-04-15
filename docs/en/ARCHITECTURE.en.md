# Architecture (English)

## Overview

The application is a desktop pipeline for ecommerce image generation and quality evaluation.

Flow summary:

1. Renderer starts a task.
2. Main process launches an agent loop.
3. Agent calls tools for generation and evaluation.
4. Loop retries until threshold met or retries exhausted.
5. Results are persisted and streamed back to renderer.

## Runtime Layers

### Renderer (`src/renderer`)

- React + Zustand UI.
- Uses `window.api` bridge only.
- Main pages:
  - Dashboard
  - TaskRun
  - Gallery
  - Templates
  - Settings

### Preload (`src/preload/index.ts`)

- Exposes typed API via `contextBridge`.
- Defines renderer-accessible boundary.

### Main (`src/main`)

- `index.ts`: bootstrap, migrations, window, handler registration.
- `ipc/*`: IPC handlers.
- `agent/*`: loop + tool orchestration + Python bridge.
- `db/*`: SQLite client, migrations, queries.

### Python (`python/vlmeval_server.py`)

- Long-running JSONL service over stdin/stdout.
- Executes visual evaluation via Anthropic model.

## Core Flow

### Task Start

- Renderer invokes `TASK_START`.
- Main decrypts keys from config table, lazy-starts Python bridge, inserts task row, starts agent loop.

### Agent Loop (`src/main/agent/runner.ts`)

Key constants:

- `MAX_RETRIES = 3`
- `SCORE_THRESHOLD = 85`
- Input token cost: `3 / 1_000_000`
- Output token cost: `15 / 1_000_000`

Per round:

1. Build system prompt (optionally with previous defect feedback).
2. Call Anthropic model with tool definitions.
3. Execute returned tool calls:
   - `generate_image`
   - `evaluate_image`
4. Stream loop event to renderer.
5. Persist success/failure and copy image to target directory.

Abort:

- `TASK_STOP` aborts task controller.
- Loop checks `AbortSignal` and exits gracefully.

### Event Streaming

- Main emits `AGENT_LOOP_EVENT`.
- Renderer consumes events in terminal pane and store.

## Persistence

SQLite path:

- `app.getPath('userData')/ecom-agent.db`

Tables:

- `tasks`
- `templates`
- `config`

Migrations:

- `001_create_tasks`
- `002_create_templates`
- `003_add_image_fields`

DB settings:

- WAL mode
- foreign keys enabled

## IPC Contract

Channels are declared in `src/shared/ipc-channels.ts` and used across preload/main/renderer.

Domains:

- task: start/stop/list
- agent: loop events
- config: get/set
- app: user data path
- template: save/list/delete

Payload types live in `src/shared/types.ts`.

## Runtime File Outputs

Under `app.getPath('userData')`:

- `tmp_images/`
- `ready_to_publish/`
- `failed/`

## Constraints

- Security boundary must remain:
  - `contextIsolation: true`
  - `nodeIntegration: false`
- No direct Node access in renderer.
- Secrets stored encrypted in local DB.
- Python bridge protocol is line-delimited JSON with unique `request_id`.
- Evaluation timeout is 120 seconds per request.

## Known Risks

- Existing garbled Chinese strings from historical encoding issues.
- `templateId` not fully wired into runtime prompt selection.
- Current baseline has renderer TypeScript typecheck issue (`JSX` namespace).
