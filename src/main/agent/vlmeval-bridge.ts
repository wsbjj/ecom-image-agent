import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import * as readline from 'node:readline'
import * as path from 'node:path'
import { app } from 'electron'
import type { EvalRequest, EvalResult, DefectAnalysis } from '../../shared/types'

export type { EvalRequest, EvalResult }

interface RawStdoutLine {
  request_id: string
  total_score: number
  defect_analysis: DefectAnalysis
  error?: string
}

interface PendingResolver {
  resolve: (value: EvalResult) => void
  reject: (reason: Error) => void
  timer: NodeJS.Timeout
}

const EVAL_TIMEOUT_MS = 120_000

export class VLMEvalBridge {
  private proc: ChildProcessWithoutNullStreams | null = null
  private pendingRequests = new Map<string, PendingResolver>()
  private rl: readline.Interface | null = null

  async start(
    pythonPath: string,
    anthropicApiKey: string,
    options?: { anthropicBaseUrl?: string; anthropicModel?: string },
  ): Promise<void> {
    const appPath = app.getAppPath()
    const scriptPath = path.join(appPath, 'python', 'vlmeval_server.py')
    const requirementsPath = path.join(appPath, 'python', 'requirements.txt')
    const workDir = app.getPath('userData')

    // Ensure required Python packages exist before starting JSONL service.
    const checkDeps = spawnSync(
      pythonPath,
      ['-X', 'utf8', '-c', 'import anthropic, pydantic'],
      { encoding: 'utf8' },
    )
    if (checkDeps.status !== 0) {
      const installDeps = spawnSync(
        pythonPath,
        ['-X', 'utf8', '-m', 'pip', 'install', '-r', requirementsPath],
        { encoding: 'utf8' },
      )
      if (installDeps.status !== 0) {
        const detail = installDeps.stderr || installDeps.stdout || 'unknown pip error'
        throw new Error(`安装 Python 依赖失败: ${detail}`)
      }
    }

    this.proc = spawn(pythonPath, ['-X', 'utf8', scriptPath, '--workdir', workDir], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PYTHONUTF8: '1',
        PYTHONIOENCODING: 'utf-8',
        ANTHROPIC_API_KEY: anthropicApiKey,
        ...(options?.anthropicBaseUrl
          ? { ANTHROPIC_BASE_URL: options.anthropicBaseUrl }
          : {}),
        ...(options?.anthropicModel ? { ANTHROPIC_MODEL: options.anthropicModel } : {}),
      },
    })

    this.rl = readline.createInterface({ input: this.proc.stdout })
    this.rl.on('line', (line: string) => {
      this.handleStdoutLine(line)
    })

    this.proc.stderr.on('data', (chunk: Buffer) => {
      process.stderr.write(`[VLMEval] ${chunk.toString()}`)
    })

    this.proc.on('exit', (code) => {
      console.warn(`[VLMEval] 子进程退出，code=${String(code)}`)
      this.proc = null
      const err = new Error(`VLMEval 子进程意外退出 code=${String(code)}`)
      for (const [id, pending] of this.pendingRequests) {
        clearTimeout(pending.timer)
        pending.reject(err)
        this.pendingRequests.delete(id)
      }
    })
  }

  private handleStdoutLine(line: string): void {
    let raw: RawStdoutLine
    try {
      raw = JSON.parse(line) as RawStdoutLine
    } catch {
      return
    }
    const pending = this.pendingRequests.get(raw.request_id)
    if (!pending) return
    clearTimeout(pending.timer)
    this.pendingRequests.delete(raw.request_id)
    if (raw.error) {
      pending.reject(new Error(raw.error))
    } else {
      pending.resolve({
        totalScore: raw.total_score,
        defectAnalysis: raw.defect_analysis,
      })
    }
  }

  evaluate(req: EvalRequest): Promise<EvalResult> {
    if (!this.proc) {
      return Promise.reject(new Error('VLMEval 子进程未启动'))
    }

    return new Promise<EvalResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(req.requestId)
        reject(new Error(`VLMEval 评估超时 (${EVAL_TIMEOUT_MS}ms)`))
      }, EVAL_TIMEOUT_MS)

      this.pendingRequests.set(req.requestId, { resolve, reject, timer })

      const payload = JSON.stringify({
        request_id: req.requestId,
        image_path: req.imagePath,
        product_name: req.productName,
        context: req.context,
      })
      this.proc!.stdin.write(payload + '\n')
    })
  }

  async stop(): Promise<void> {
    this.rl?.close()
    this.rl = null
    if (this.proc) {
      this.proc.kill('SIGTERM')
      this.proc = null
    }
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timer)
      pending.reject(new Error('VLMEval bridge stopped'))
      this.pendingRequests.delete(id)
    }
  }
}
