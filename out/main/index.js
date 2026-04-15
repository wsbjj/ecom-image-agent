"use strict";
const electron = require("electron");
const path = require("node:path");
const Database = require("better-sqlite3");
const kysely = require("kysely");
const Anthropic = require("@anthropic-ai/sdk");
const generativeAi = require("@google/generative-ai");
const fs = require("node:fs/promises");
const uuid = require("uuid");
const node_child_process = require("node:child_process");
const readline = require("node:readline");
function _interopNamespaceDefault(e) {
  const n = Object.create(null, { [Symbol.toStringTag]: { value: "Module" } });
  if (e) {
    for (const k in e) {
      if (k !== "default") {
        const d = Object.getOwnPropertyDescriptor(e, k);
        Object.defineProperty(n, k, d.get ? d : {
          enumerable: true,
          get: () => e[k]
        });
      }
    }
  }
  n.default = e;
  return Object.freeze(n);
}
const path__namespace = /* @__PURE__ */ _interopNamespaceDefault(path);
const fs__namespace = /* @__PURE__ */ _interopNamespaceDefault(fs);
const readline__namespace = /* @__PURE__ */ _interopNamespaceDefault(readline);
async function up$1(db2) {
  await db2.schema.createTable("tasks").ifNotExists().addColumn("id", "integer", (col) => col.primaryKey().autoIncrement()).addColumn("task_id", "text", (col) => col.notNull().unique()).addColumn("sku_id", "text", (col) => col.notNull()).addColumn("product_name", "text", (col) => col.notNull()).addColumn("retry_count", "integer", (col) => col.notNull().defaultTo(0)).addColumn("total_score", "real").addColumn("defect_analysis", "text").addColumn("status", "text", (col) => col.notNull().defaultTo("pending")).addColumn("image_path", "text").addColumn("prompt_used", "text").addColumn("cost_usd", "real").addColumn(
    "created_at",
    "text",
    (col) => col.notNull().defaultTo(kysely.sql`CURRENT_TIMESTAMP`)
  ).addColumn("updated_at", "text").execute();
  await db2.schema.createTable("config").ifNotExists().addColumn("key", "text", (col) => col.primaryKey()).addColumn("value", "text", (col) => col.notNull()).execute();
}
async function down$1(db2) {
  await db2.schema.dropTable("tasks").ifExists().execute();
  await db2.schema.dropTable("config").ifExists().execute();
}
async function up(db2) {
  await db2.schema.createTable("templates").ifNotExists().addColumn("id", "integer", (col) => col.primaryKey().autoIncrement()).addColumn("name", "text", (col) => col.notNull()).addColumn("style", "text", (col) => col.notNull()).addColumn("lighting", "text", (col) => col.notNull()).addColumn("system_prompt", "text", (col) => col.notNull()).addColumn(
    "created_at",
    "text",
    (col) => col.notNull().defaultTo(kysely.sql`CURRENT_TIMESTAMP`)
  ).execute();
}
async function down(db2) {
  await db2.schema.dropTable("templates").ifExists().execute();
}
class InlineMigrationProvider {
  getMigrations() {
    return Promise.resolve({
      "001_create_tasks": { up: up$1, down: down$1 },
      "002_create_templates": { up, down }
    });
  }
}
function createDb() {
  const dbPath = path__namespace.join(electron.app.getPath("userData"), "ecom-agent.db");
  const sqlite = new Database(dbPath);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  return new kysely.Kysely({
    dialect: new kysely.SqliteDialect({ database: sqlite })
  });
}
const db = createDb();
async function runMigrations() {
  const migrator = new kysely.Migrator({ db, provider: new InlineMigrationProvider() });
  const { error, results } = await migrator.migrateToLatest();
  if (error) throw error;
  results?.forEach((r) => {
    console.log(`[Migration] ${r.migrationName}: ${r.status}`);
  });
}
const IPC_CHANNELS = {
  TASK_START: "task:start",
  TASK_STOP: "task:stop",
  TASK_LIST: "task:list",
  AGENT_LOOP_EVENT: "agent:loop-event",
  CONFIG_GET: "config:get",
  CONFIG_SET: "config:set",
  APP_USER_DATA_PATH: "app:user-data-path",
  TEMPLATE_SAVE: "template:save",
  TEMPLATE_LIST: "template:list",
  TEMPLATE_DELETE: "template:delete"
};
const GENERATE_IMAGE_TOOL = {
  name: "generate_image",
  description: "调用 Google Gemini API 生成电商精品图，返回本地绝对路径",
  inputSchema: {
    type: "object",
    properties: {
      prompt: { type: "string", description: "详细图像生成提示词（英文）" },
      style: { type: "string", description: "风格标签，如 minimalist / warm / studio" },
      aspect_ratio: { type: "string", enum: ["1:1", "4:3", "16:9"] }
    },
    required: ["prompt"]
  }
};
const EVALUATE_IMAGE_TOOL = {
  name: "evaluate_image",
  description: "对已生成的图片进行三维度质量评估（边缘畸变/透视光影/幻觉物体），返回评分和缺陷分析",
  inputSchema: {
    type: "object",
    properties: {
      image_path: { type: "string", description: "generate_image 返回的图片绝对路径" },
      product_name: { type: "string", description: "商品名称" },
      context: { type: "string", description: "拍摄场景描述" }
    },
    required: ["image_path", "product_name", "context"]
  }
};
async function createMcpServer(vlmBridge2, options) {
  const genAI = new generativeAi.GoogleGenerativeAI(options.googleApiKey);
  const toolHandlers = /* @__PURE__ */ new Map();
  toolHandlers.set("generate_image", async (rawInput) => {
    const input = rawInput;
    const model = genAI.getGenerativeModel(
      { model: options.googleImageModel ?? "gemini-2.0-flash-preview-image-generation" },
      options.googleBaseUrl ? { baseUrl: options.googleBaseUrl } : void 0
    );
    const fullPrompt = `${input.prompt}${input.style ? `, style: ${input.style}` : ""}, product photography, white background, 8K, commercial quality`;
    const result = await model.generateContent({
      contents: [{ role: "user", parts: [{ text: fullPrompt }] }],
      generationConfig: {
        responseMimeType: "image/png"
      }
    });
    const candidates = result.response.candidates;
    const imagePart = candidates?.[0]?.content.parts.find(
      (p) => p.inlineData?.mimeType?.startsWith("image/")
    );
    if (!imagePart?.inlineData?.data) {
      throw new Error("Gemini 未返回图片数据");
    }
    const tmpDir = path__namespace.join(electron.app.getPath("userData"), "tmp_images");
    await fs__namespace.mkdir(tmpDir, { recursive: true });
    const imagePath = path__namespace.join(tmpDir, `${uuid.v4()}.png`);
    await fs__namespace.writeFile(imagePath, Buffer.from(imagePart.inlineData.data, "base64"));
    return { image_path: imagePath, prompt_used: fullPrompt };
  });
  toolHandlers.set("evaluate_image", async (rawInput) => {
    const input = rawInput;
    const evalResult = await vlmBridge2.evaluate({
      requestId: uuid.v4(),
      imagePath: input.image_path,
      productName: input.product_name,
      context: input.context
    });
    return {
      total_score: evalResult.totalScore,
      defect_analysis: evalResult.defectAnalysis
    };
  });
  return {
    tools: [GENERATE_IMAGE_TOOL, EVALUATE_IMAGE_TOOL],
    callTool: async (name, input) => {
      const handler = toolHandlers.get(name);
      if (!handler) {
        throw new Error(`Unknown tool: ${name}`);
      }
      return handler(input);
    }
  };
}
function buildSystemPrompt(input) {
  const base = `你是一位专业的电商精品图生成 Agent。
你的任务是为商品「${input.productName}」生成符合电商平台最高标准的精品宣传图。
场景要求：${input.context}

## 工作流程（必须严格遵守）
1. 首先调用 generate_image 工具生成图片
2. 立即调用 evaluate_image 工具对生成的图片进行质量评估
3. 输出评估结论，不需要进行额外操作

## 图片质量标准
- 边缘清晰无畸变（30分）
- 透视与光影真实（30分）
- 无幻觉物体/无虚假商标（30分）
- 整体商业质量（10分）
目标总分 >= 85 分才算合格。`;
  if (!input.defectAnalysis || input.retryCount === 0) return base;
  const { edge_distortion, perspective_lighting, hallucination, overall_recommendation } = input.defectAnalysis;
  const formatIssues = (issues) => issues.length > 0 ? issues.map((i) => `- ${i}`).join("\n") : "- 无问题";
  const defectSection = `

## 上一轮缺陷分析（第 ${input.retryCount} 次重试，生成时请务必修正以下问题）

### 边缘畸变（得分 ${edge_distortion.score}/30）
${formatIssues(edge_distortion.issues)}

### 透视与光影（得分 ${perspective_lighting.score}/30）
${formatIssues(perspective_lighting.issues)}

### 幻觉物体（得分 ${hallucination.score}/30）
${formatIssues(hallucination.issues)}

### 综合建议
${overall_recommendation}

请在 generate_image 的提示词中显式修正上述缺陷。`;
  return base + defectSection;
}
async function insertTask(params) {
  await db.insertInto("tasks").values({
    task_id: params.taskId,
    sku_id: params.skuId,
    product_name: params.productName,
    retry_count: 0,
    status: "running"
  }).execute();
}
async function updateTaskSuccess(params) {
  await db.updateTable("tasks").set({
    status: "success",
    total_score: params.totalScore,
    defect_analysis: params.defectAnalysis,
    image_path: params.imagePath,
    retry_count: params.retryCount,
    cost_usd: params.costUsd,
    updated_at: (/* @__PURE__ */ new Date()).toISOString()
  }).where("task_id", "=", params.taskId).execute();
}
async function updateTaskFailed(params) {
  await db.updateTable("tasks").set({
    status: "failed",
    retry_count: params.retryCount,
    cost_usd: params.costUsd ?? null,
    updated_at: (/* @__PURE__ */ new Date()).toISOString()
  }).where("task_id", "=", params.taskId).execute();
}
async function listTasks() {
  const rows = await db.selectFrom("tasks").selectAll().orderBy("created_at", "desc").execute();
  return rows;
}
async function getConfigValue(key) {
  const row = await db.selectFrom("config").select("value").where("key", "=", key).executeTakeFirst();
  return row?.value;
}
async function setConfigValue(key, value) {
  await db.insertInto("config").values({ key, value }).onConflict((oc) => oc.column("key").doUpdateSet({ value })).execute();
}
async function insertTemplate(input) {
  await db.insertInto("templates").values({
    name: input.name,
    style: input.style,
    lighting: input.lighting,
    system_prompt: input.system_prompt
  }).execute();
}
async function listTemplates() {
  const rows = await db.selectFrom("templates").selectAll().orderBy("created_at", "desc").execute();
  return rows;
}
async function deleteTemplate(id) {
  await db.deleteFrom("templates").where("id", "=", id).execute();
}
const MAX_RETRIES = 3;
const SCORE_THRESHOLD = 85;
const COST_PER_INPUT_TOKEN = 3 / 1e6;
const COST_PER_OUTPUT_TOKEN = 15 / 1e6;
async function runAgentLoop(input, win, vlmBridge2, signal, options) {
  const taskId = input.taskId ?? uuid.v4();
  const readyDir = path__namespace.join(electron.app.getPath("userData"), "ready_to_publish");
  const failedDir = path__namespace.join(electron.app.getPath("userData"), "failed");
  await fs__namespace.mkdir(readyDir, { recursive: true });
  await fs__namespace.mkdir(failedDir, { recursive: true });
  let retryCount = 0;
  let lastDefectAnalysis = null;
  let lastImagePath = null;
  let totalCostUsd = 0;
  const pushEvent = (event) => {
    if (!win.isDestroyed()) {
      win.webContents.send(IPC_CHANNELS.AGENT_LOOP_EVENT, event);
    }
  };
  const mcpServer = await createMcpServer(vlmBridge2, {
    googleApiKey: options.googleApiKey,
    googleBaseUrl: options.googleBaseUrl,
    googleImageModel: options.googleImageModel
  });
  const anthropic = new Anthropic({
    apiKey: options.anthropicApiKey,
    ...options.anthropicBaseUrl ? { baseURL: options.anthropicBaseUrl } : {}
  });
  while (retryCount <= MAX_RETRIES) {
    if (signal.aborted) {
      pushEvent({
        taskId,
        phase: "failed",
        message: "任务已手动中止",
        retryCount,
        timestamp: Date.now()
      });
      await updateTaskFailed({ taskId, retryCount, costUsd: totalCostUsd });
      return;
    }
    const systemPrompt = buildSystemPrompt({
      productName: input.productName,
      context: input.context,
      defectAnalysis: lastDefectAnalysis ?? void 0,
      retryCount
    });
    pushEvent({
      taskId,
      phase: "thought",
      message: `[第 ${retryCount + 1} 轮] 开始推理 → 商品: ${input.productName}`,
      retryCount,
      timestamp: Date.now()
    });
    let generatedImagePath = null;
    let roundEvalScore = null;
    let roundDefect = null;
    const toolDefs = mcpServer.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema
    }));
    const messages = [
      {
        role: "user",
        content: `生成电商精品图：商品名称=${input.productName}，场景=${input.context}，SKU=${input.skuId}。生成图片后立即调用 evaluate_image 工具进行质量评估。`
      }
    ];
    let continueLoop = true;
    while (continueLoop) {
      if (signal.aborted) break;
      const response = await anthropic.messages.create({
        model: options.anthropicModel ?? "claude-sonnet-4-20250514",
        max_tokens: 4096,
        system: systemPrompt,
        tools: toolDefs,
        messages
      });
      totalCostUsd += response.usage.input_tokens * COST_PER_INPUT_TOKEN + response.usage.output_tokens * COST_PER_OUTPUT_TOKEN;
      if (response.stop_reason === "end_turn" || response.stop_reason !== "tool_use") {
        continueLoop = false;
        break;
      }
      const assistantContent = response.content;
      messages.push({ role: "assistant", content: assistantContent });
      const toolResults = [];
      for (const block of assistantContent) {
        if (block.type !== "tool_use") continue;
        pushEvent({
          taskId,
          phase: block.name === "generate_image" ? "act" : "observe",
          message: `调用 ${block.name}，参数: ${JSON.stringify(block.input)}`,
          retryCount,
          timestamp: Date.now()
        });
        try {
          const result = await mcpServer.callTool(
            block.name,
            block.input
          );
          if (block.name === "generate_image") {
            const genResult = result;
            generatedImagePath = genResult.image_path;
            lastImagePath = generatedImagePath;
          }
          if (block.name === "evaluate_image") {
            const evalRes = result;
            roundEvalScore = evalRes.total_score;
            roundDefect = evalRes.defect_analysis;
          }
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: JSON.stringify(result)
          });
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: `Error: ${errMsg}`,
            is_error: true
          });
        }
      }
      messages.push({ role: "user", content: toolResults });
      if (roundEvalScore !== null) {
        continueLoop = false;
      }
    }
    if (signal.aborted) {
      pushEvent({
        taskId,
        phase: "failed",
        message: "任务已手动中止",
        retryCount,
        timestamp: Date.now()
      });
      await updateTaskFailed({ taskId, retryCount, costUsd: totalCostUsd });
      return;
    }
    if (!generatedImagePath || roundEvalScore === null || !roundDefect) {
      pushEvent({
        taskId,
        phase: "failed",
        message: "Agent 未完成完整 generate+evaluate 循环",
        retryCount,
        timestamp: Date.now()
      });
      break;
    }
    pushEvent({
      taskId,
      phase: "observe",
      message: `评分结果: ${roundEvalScore} / 100`,
      score: roundEvalScore,
      defectAnalysis: roundDefect,
      costUsd: totalCostUsd,
      retryCount,
      timestamp: Date.now()
    });
    if (roundEvalScore >= SCORE_THRESHOLD) {
      const destPath = path__namespace.join(readyDir, `${taskId}_${retryCount}.png`);
      await fs__namespace.copyFile(generatedImagePath, destPath);
      await updateTaskSuccess({
        taskId,
        totalScore: roundEvalScore,
        defectAnalysis: JSON.stringify(roundDefect),
        imagePath: destPath,
        retryCount,
        costUsd: totalCostUsd
      });
      pushEvent({
        taskId,
        phase: "success",
        message: `任务成功！评分 ${roundEvalScore}，总费用 $${totalCostUsd.toFixed(4)}`,
        score: roundEvalScore,
        costUsd: totalCostUsd,
        retryCount,
        timestamp: Date.now()
      });
      return;
    }
    lastDefectAnalysis = roundDefect;
    retryCount++;
  }
  if (lastImagePath) {
    const destPath = path__namespace.join(failedDir, `${taskId}_final.png`);
    await fs__namespace.copyFile(lastImagePath, destPath);
  }
  await updateTaskFailed({ taskId, retryCount, costUsd: totalCostUsd });
  pushEvent({
    taskId,
    phase: "failed",
    message: `任务失败：已重试 ${MAX_RETRIES} 次，总费用 $${totalCostUsd.toFixed(4)}`,
    costUsd: totalCostUsd,
    retryCount,
    timestamp: Date.now()
  });
}
const EVAL_TIMEOUT_MS = 12e4;
class VLMEvalBridge {
  proc = null;
  pendingRequests = /* @__PURE__ */ new Map();
  rl = null;
  async start(pythonPath, anthropicApiKey, options) {
    const scriptPath = path__namespace.join(electron.app.getAppPath(), "python", "vlmeval_server.py");
    const workDir = electron.app.getPath("userData");
    this.proc = node_child_process.spawn(pythonPath, [scriptPath, "--workdir", workDir], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        ANTHROPIC_API_KEY: anthropicApiKey,
        ...options?.anthropicBaseUrl ? { ANTHROPIC_BASE_URL: options.anthropicBaseUrl } : {},
        ...options?.anthropicModel ? { ANTHROPIC_MODEL: options.anthropicModel } : {}
      }
    });
    this.rl = readline__namespace.createInterface({ input: this.proc.stdout });
    this.rl.on("line", (line) => {
      this.handleStdoutLine(line);
    });
    this.proc.stderr.on("data", (chunk) => {
      process.stderr.write(`[VLMEval] ${chunk.toString()}`);
    });
    this.proc.on("exit", (code) => {
      console.warn(`[VLMEval] 子进程退出，code=${String(code)}`);
      this.proc = null;
      const err = new Error(`VLMEval 子进程意外退出 code=${String(code)}`);
      for (const [id, pending] of this.pendingRequests) {
        clearTimeout(pending.timer);
        pending.reject(err);
        this.pendingRequests.delete(id);
      }
    });
  }
  handleStdoutLine(line) {
    let raw;
    try {
      raw = JSON.parse(line);
    } catch {
      return;
    }
    const pending = this.pendingRequests.get(raw.request_id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingRequests.delete(raw.request_id);
    if (raw.error) {
      pending.reject(new Error(raw.error));
    } else {
      pending.resolve({
        totalScore: raw.total_score,
        defectAnalysis: raw.defect_analysis
      });
    }
  }
  evaluate(req) {
    if (!this.proc) {
      return Promise.reject(new Error("VLMEval 子进程未启动"));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(req.requestId);
        reject(new Error(`VLMEval 评估超时 (${EVAL_TIMEOUT_MS}ms)`));
      }, EVAL_TIMEOUT_MS);
      this.pendingRequests.set(req.requestId, { resolve, reject, timer });
      const payload = JSON.stringify({
        request_id: req.requestId,
        image_path: req.imagePath,
        product_name: req.productName,
        context: req.context
      });
      this.proc.stdin.write(payload + "\n");
    });
  }
  async stop() {
    this.rl?.close();
    this.rl = null;
    if (this.proc) {
      this.proc.kill("SIGTERM");
      this.proc = null;
    }
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error("VLMEval bridge stopped"));
      this.pendingRequests.delete(id);
    }
  }
}
const controllers = /* @__PURE__ */ new Map();
const vlmBridge = new VLMEvalBridge();
let vlmStarted = false;
async function getDecryptedKey(key) {
  const encrypted = await getConfigValue(key);
  if (!encrypted) {
    throw new Error(`配置项 ${key} 未设置，请先在 Settings 页面配置`);
  }
  return electron.safeStorage.decryptString(Buffer.from(encrypted, "base64"));
}
async function getOptionalDecryptedValue(key) {
  const encrypted = await getConfigValue(key);
  if (!encrypted) return void 0;
  const value = electron.safeStorage.decryptString(Buffer.from(encrypted, "base64")).trim();
  return value.length > 0 ? value : void 0;
}
function registerAgentHandlers(win) {
  electron.ipcMain.handle(
    IPC_CHANNELS.TASK_START,
    async (_event, input) => {
      if (!vlmStarted) {
        const pythonPath = process.platform === "win32" ? "python" : "python3";
        const anthropicKey2 = await getDecryptedKey("ANTHROPIC_API_KEY");
        const anthropicBaseUrl2 = await getOptionalDecryptedValue("ANTHROPIC_BASE_URL");
        const anthropicModel2 = await getOptionalDecryptedValue("ANTHROPIC_MODEL");
        await vlmBridge.start(pythonPath, anthropicKey2, {
          anthropicBaseUrl: anthropicBaseUrl2,
          anthropicModel: anthropicModel2
        });
        vlmStarted = true;
      }
      const taskId = uuid.v4();
      await insertTask({
        taskId,
        skuId: input.skuId,
        productName: input.productName
      });
      const controller = new AbortController();
      controllers.set(taskId, controller);
      const googleKey = await getDecryptedKey("GOOGLE_API_KEY");
      const anthropicKey = await getDecryptedKey("ANTHROPIC_API_KEY");
      const anthropicBaseUrl = await getOptionalDecryptedValue("ANTHROPIC_BASE_URL");
      const anthropicModel = await getOptionalDecryptedValue("ANTHROPIC_MODEL");
      const googleBaseUrl = await getOptionalDecryptedValue("GOOGLE_BASE_URL");
      const googleImageModel = await getOptionalDecryptedValue("GOOGLE_IMAGE_MODEL");
      runAgentLoop(
        { ...input, taskId },
        win,
        vlmBridge,
        controller.signal,
        {
          googleApiKey: googleKey,
          googleBaseUrl,
          googleImageModel,
          anthropicApiKey: anthropicKey,
          anthropicBaseUrl,
          anthropicModel
        }
      ).catch((err) => {
        console.error("[AgentRunner]", err);
      }).finally(() => {
        controllers.delete(taskId);
      });
      return { taskId };
    }
  );
  electron.ipcMain.handle(
    IPC_CHANNELS.TASK_STOP,
    async (_event, taskId) => {
      const ctrl = controllers.get(taskId);
      if (ctrl) {
        ctrl.abort();
        controllers.delete(taskId);
      }
      return { success: true };
    }
  );
}
function cleanupAgentHandlers() {
  for (const [, ctrl] of controllers) {
    ctrl.abort();
  }
  controllers.clear();
  vlmBridge.stop().catch(console.error);
}
function registerTaskHandlers() {
  electron.ipcMain.handle(
    IPC_CHANNELS.TASK_LIST,
    async () => {
      return listTasks();
    }
  );
}
function registerConfigHandlers() {
  electron.ipcMain.handle(
    IPC_CHANNELS.CONFIG_SET,
    async (_event, key, rawValue) => {
      const encrypted = electron.safeStorage.encryptString(rawValue).toString("base64");
      await setConfigValue(key, encrypted);
      return { success: true };
    }
  );
  electron.ipcMain.handle(
    IPC_CHANNELS.CONFIG_GET,
    async (_event, key) => {
      const val = await getConfigValue(key);
      return { exists: val !== void 0 };
    }
  );
  electron.ipcMain.handle(
    IPC_CHANNELS.APP_USER_DATA_PATH,
    async () => {
      return { path: electron.app.getPath("userData") };
    }
  );
  electron.ipcMain.handle(
    IPC_CHANNELS.TEMPLATE_SAVE,
    async (_event, template) => {
      await insertTemplate(template);
      return { success: true };
    }
  );
  electron.ipcMain.handle(
    IPC_CHANNELS.TEMPLATE_LIST,
    async () => {
      return listTemplates();
    }
  );
  electron.ipcMain.handle(
    IPC_CHANNELS.TEMPLATE_DELETE,
    async (_event, id) => {
      await deleteTemplate(id);
      return { success: true };
    }
  );
}
let mainWindow = null;
function createWindow() {
  mainWindow = new electron.BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1e3,
    minHeight: 700,
    webPreferences: {
      preload: path__namespace.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    },
    titleBarStyle: "hiddenInset",
    show: false
  });
  mainWindow.on("ready-to-show", () => {
    mainWindow?.show();
  });
  registerAgentHandlers(mainWindow);
  registerTaskHandlers();
  registerConfigHandlers();
  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    mainWindow.loadFile(path__namespace.join(__dirname, "../renderer/index.html"));
  }
}
electron.app.whenReady().then(async () => {
  await runMigrations();
  createWindow();
  electron.app.on("activate", () => {
    if (electron.BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
}).catch((error) => {
  console.error("[Main] Failed to initialize app", error);
  electron.app.quit();
});
electron.app.on("window-all-closed", () => {
  cleanupAgentHandlers();
  if (process.platform !== "darwin") {
    electron.app.quit();
  }
});
