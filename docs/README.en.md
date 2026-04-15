# Product Guide (English)

## Overview

Ecom Image Agent is an Electron desktop app for ecommerce image generation and visual quality evaluation.

The app runs a ReAct loop:

1. Generate image.
2. Evaluate image.
3. Retry with defect feedback until pass or max retries.

## Features

- ReAct loop with retries
- Visual evaluation via Python service + Anthropic model
- Real-time event streaming to terminal panel
- Cost tracking per task (token-based estimation)
- Encrypted local key storage (Electron `safeStorage`)
- Batch import via CSV/JSON
- Template management with Monaco editor

## Environment Requirements

- Node.js: 22.x
- Python: 3.11+
- pip
- Git

Required keys:

- `ANTHROPIC_API_KEY`
- `GOOGLE_API_KEY`

Optional overrides:

- `ANTHROPIC_BASE_URL`
- `ANTHROPIC_MODEL`
- `GOOGLE_BASE_URL`
- `GOOGLE_IMAGE_MODEL`

## Setup

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

3. Run the app:

```bash
npm run dev
```

## Build and Test

```bash
npm run build
npm run build:win
npm run build:mac
npm run build:linux
npm run test
npm run test:watch
npm run test:coverage
```

## Runtime Output Locations

Under `app.getPath('userData')`:

- `tmp_images/`
- `ready_to_publish/`
- `failed/`
- `ecom-agent.db`

## Notes

- API keys are stored in local SQLite (`config` table) after encryption, not in JSON config files.
- Current codebase contains some garbled Chinese strings due to encoding issues.
