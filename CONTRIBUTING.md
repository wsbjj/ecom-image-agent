# Contributing

This repository is an Electron desktop app for ecommerce image generation and quality evaluation.

## Prerequisites

- Node.js `22.x` (LTS recommended)
- npm (comes with Node)
- Python `3.11+`
- pip

## Local Setup

1. Install Node dependencies:
   ```bash
   npm install
   ```
2. Install Python dependencies:
   ```bash
   cd python
   python -m venv .venv
   # Windows:
   .venv\Scripts\activate
   pip install -r requirements.txt
   ```
3. Run app in dev mode:
   ```bash
   npm run dev
   ```

## Development Workflow

1. Create a focused branch from `main`.
2. Keep changes scoped to one concern (feature, fix, or refactor).
3. Add or update tests with code changes.
4. Run validation commands before commit.
5. Commit with clear messages.

## Validation Checklist

Run these from repo root:

```bash
npm run test
npm run typecheck
```

Notes:
- `npm run test` is currently passing.
- `npm run typecheck` currently fails in this codebase (`Cannot find namespace 'JSX'` in renderer files). Do not ignore new type errors on top of this baseline.

## Code Conventions

- TypeScript strictness is enabled. Keep strong typing and avoid `any`.
- Use shared contracts from `src/shared/types.ts` and `src/shared/ipc-channels.ts` for cross-process communication.
- Keep Electron boundary clean:
  - Renderer calls `window.api` only.
  - All privileged operations stay in `main`.
- Keep business logic in `src/main/agent` and persistence logic in `src/main/db`.
- Prefer small pure helpers for parsing/formatting logic in renderer.
- Do not commit secrets (`.env`, API keys) or local runtime artifacts.

## Testing Scope

- Renderer state/components: `tests/renderer/**`
- Main/shared behavior: `tests/main/**`

When changing:
- Prompt building or loop behavior: update `tests/main/agent/runner.test.ts`.
- Store behavior: update `tests/renderer/store/task.store.test.ts`.
- UI rendering behavior: update component tests when applicable.

## Commit Message Style

Use concise, imperative commit messages. Examples:

- `feat: add batch task validation`
- `fix: handle vlmeval timeout in runner`
- `chore: update ipc channel typing`
- `docs: clarify architecture constraints`

## Security and Safety

- Never log raw API keys.
- Keep key storage through Electron `safeStorage` and DB config table.
- Keep `contextIsolation: true` and `nodeIntegration: false` assumptions intact.

## Known Project Constraints

- Some Chinese strings are currently garbled due to encoding issues; avoid spreading this in new code.
- `templateId` exists in task input but is not fully wired into prompt generation flow yet.
