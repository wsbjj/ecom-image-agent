# Contributing (English)

This repository is an Electron desktop app for ecommerce image generation and quality evaluation.

## Prerequisites

- Node.js `22.x`
- npm
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
# Windows
.venv\Scripts\activate
pip install -r requirements.txt
```

3. Run app in dev mode:

```bash
npm run dev
```

## Development Workflow

1. Create a focused branch from `main`.
2. Keep changes scoped to one concern.
3. Add/update tests with code changes.
4. Run validation commands before commit.
5. Commit with clear messages.

## Validation

```bash
npm run test
npm run typecheck
```

Current baseline note:

- `npm run test` passes.
- `npm run typecheck` currently fails in renderer with `Cannot find namespace 'JSX'`. Do not introduce additional type errors.

## Conventions

- Keep TypeScript strictness; avoid `any` unless justified.
- Use shared contracts from `src/shared/types.ts` and `src/shared/ipc-channels.ts`.
- Renderer must call `window.api` only.
- Privileged logic remains in `src/main`.
- Agent business logic lives in `src/main/agent`.
- DB logic lives in `src/main/db`.
- Do not commit secrets or local runtime artifacts.

## Testing Scope

- Renderer tests: `tests/renderer/**`
- Main/shared tests: `tests/main/**`

## Commit Message Examples

- `feat: add batch task validation`
- `fix: handle vlmeval timeout in runner`
- `chore: update ipc channel typing`
- `docs: clarify architecture constraints`

## Security

- Never log raw API keys.
- Keep key persistence through encrypted storage (`safeStorage` + DB config table).
- Preserve `contextIsolation: true` and `nodeIntegration: false` assumptions.

## Known Constraints

- Some Chinese strings are garbled due to encoding issues.
- `templateId` exists in input but is not fully integrated into prompt selection path.
