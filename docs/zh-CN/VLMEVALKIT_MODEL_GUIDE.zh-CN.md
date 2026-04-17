# VLMEvalKit 模型支持与选型指南（中文）

## 文档目的

这份文档专门说明两件事：

1. `VLMEvalKit` 官方大致支持哪些视觉模型
2. 在本项目里，`VLMEVAL_MODEL_ID` 应该怎么填，哪些值更适合“在线单图评测”

适用场景：

- `Settings -> 视觉评估 -> 评测后端 = vlmevalkit`
- 希望关闭 `优先使用项目内置自定义 model adapter`
- 希望直接使用 `vlmeval.config.supported_VLM` 里已经注册的模型

先明确两点：

- 本项目里 `ANTHROPIC_*` 和 `JUDGE_*` 已分离：
  - `ANTHROPIC_*` 用于 Agent 编排
  - `JUDGE_*` 用于 `evaluate_image` 视觉评测
- VLMEvalKit 的安装来源是官方 Git 仓库：
  - `git+https://github.com/open-compass/VLMEvalKit.git@v0.3rc1`
  - 不是 `pip install vlmeval`

## 先说最重要的结论

### 1. 官方支持范围很大，但不要手工维护“全量名单”

VLMEvalKit 官方 README 明确写到：该项目当前支持 **220+ LMMs**、**80+ benchmarks**。对这个项目来说，更合理的做法不是把全部模型硬编码进文档，而是：

- 文档里维护“常用、适合在线评测”的推荐清单
- 真正需要查全量时，直接读取你本地安装版本的 `supported_VLM`

原因很简单：

- 官方仓库会持续新增模型
- 同一个模型族往往有多个 provider 版本、日期版本、推理后端版本
- 某些模型虽然“被支持”，但依赖本地权重、LMDeploy、VLLM、ARM-Thinker 或自定义 API，并不适合你的当前闭环

### 2. 在本项目里，`VLMEVAL_MODEL_ID` 的含义取决于 `VLMEVAL_USE_CUSTOM_MODEL`

这是最容易踩坑的点。

| 配置 | `VLMEVAL_MODEL_ID` 的含义 | 示例 |
| --- | --- | --- |
| `VLMEVAL_USE_CUSTOM_MODEL=true` | 直接传给你项目内置的 Anthropic adapter 的“真实模型 ID” | `claude-4-sonnet-20250514` |
| `VLMEVAL_USE_CUSTOM_MODEL=false` | 必须是 `vlmeval.config.supported_VLM` 里的“注册键名” | `Claude4_Sonnet` |

也就是说：

- `true` 模式填的是 **底层模型名**
- `false` 模式填的是 **VLMEvalKit registry key**

这两个值经常不是同一个字符串。

### 3. 你当前项目的行为

当前项目实现如下：

- `src/main/ipc/agent.handler.ts` 会把 `EVAL_BACKEND`、`VLMEVAL_MODEL_ID`、`VLMEVAL_USE_CUSTOM_MODEL` 传给 Python 评测服务
- Python 评测服务会优先读取 `JUDGE_API_KEY`、`JUDGE_BASE_URL`、`JUDGE_MODEL`；若未配置，再回退到 `ANTHROPIC_*`
- `python/vlmeval_server.py` 在 `VLMEVAL_USE_CUSTOM_MODEL=false` 时，会执行 `from vlmeval.config import supported_VLM`，然后按 `supported_VLM.get(model_name)` 取模型
- 如果没取到 registry 模型，并且环境里仍有 `JUDGE_API_KEY`（或回退得到的 `ANTHROPIC_API_KEY`），当前实现会回退到项目自定义 Anthropic adapter
- 如果没取到 registry 模型，且又没有可用的 Judge API Key，就会直接报错

因此：

- 想严格验证“这个值是否真的是 VLMEvalKit 原生支持的 registry key”，建议测试时临时关闭 Anthropic fallback 条件，或者至少观察 stderr 中是否出现 `registry_model_unavailable`

## 官方支持概览

### 官方 README 中直接可见的信息

截至 **2026-04-17**，我查阅 VLMEvalKit 官方仓库时，可以直接确认这些事实：

- 官方 README 写明：支持 `220+ LMMs`、`80+ benchmarks`
- 2025 年的更新公告里明确提到新增支持了这些模型族或模型：
  - `InternVL3 Series`
  - `Gemini-2.5-Pro`
  - `Kimi-VL`
  - `LLaMA4`
  - `NVILA`
  - `Qwen2.5-Omni`
  - `Phi4`
  - `SmolVLM2`
  - `Grok`
  - `SAIL-VL-1.5`
  - `VLM-R1`
  - `Taichu-VLR`
  - 更早一轮还包括 `InternVL2.5 Series`、`Qwen2.5VL Series`、`QVQ-72B`、`Doubao-VL`、`MiniCPM-o-2.6`、`Ovis2`、`EMU3` 等

### 官方 `config.py` 中直接可见的模型类型

从 `vlmeval/config.py` 可以直接看到，它不只支持一种来源，而是同时覆盖：

- 商业 API 模型
  - OpenAI
  - Gemini
  - Claude
  - Qwen API
  - GLM
  - Doubao / Seed
  - Kimi / Moonshot
  - ERNIE
  - MiniMax
  - Grok
  - 360 智脑
  - StepFun
  - Yi-Vision
- 云平台别名
  - GCP Vertex Claude
  - AWS Bedrock Claude
  - Together AI
  - SiliconFlow
- 开源 / 本地模型
  - MiniCPM 系列
  - LLaVA / LLaVA-Next / LLaVA-OneVision
  - Qwen-VL 早期系列
  - MMAlaya
  - Granite Vision
  - Emu
  - Pixtral
  - Bunny
  - XTuner 系列

## 适合本项目“在线单图评测”的常用模型清单

下面这份不是全量名单，而是更适合你当前项目的“候选清单”。

判断标准：

- 能明显看出是视觉模型
- 在官方 `config.py` 中能找到注册项
- 更适合在线单图打分，而不是复杂多轮工具调用或离线大规模 benchmark

## 一类：商业 API / SaaS 模型

这些通常最适合你的当前架构，因为你做的是在线单图评测，不是大规模本地离线 benchmark。

| `VLMEVAL_MODEL_ID`（`false` 模式） | provider 实际模型 | 备注 |
| --- | --- | --- |
| `Claude4_Sonnet` | `claude-4-sonnet-20250514` | 目前最适合做高质量审图 judge 的候选之一 |
| `Claude4_Opus` | `claude-4-opus-20250514` | 质量强，但成本更高 |
| `Claude3-7V_Sonnet` | `claude-3-7-sonnet-20250219` | 较稳妥 |
| `Claude3-5V_Sonnet_20241022` | `claude-3-5-sonnet-20241022` | 兼容性好 |
| `GPT4o_20241120` | `gpt-4o-2024-11-20` | 通用型较强 |
| `ChatGPT4o` | `chatgpt-4o-latest` | 跟随 latest，结果可能有漂移 |
| `GPT4o_MINI` | `gpt-4o-mini-2024-07-18` | 预算友好 |
| `gpt-4.1-2025-04-14` | `gpt-4.1-2025-04-14` | 质量与稳定性都不错 |
| `gpt-4.1-mini-2025-04-14` | `gpt-4.1-mini-2025-04-14` | 性价比更高 |
| `GeminiFlash2-0` | `gemini-2.0-flash` | 响应快，适合在线闭环 |
| `GeminiFlash2-5` | `gemini-2.5-flash` | 推荐作为速度优先选项 |
| `GeminiPro2-5` | `gemini-2.5-pro` | 更偏质量优先 |
| `Gemini-3.1-Pro-Preview` | `gemini-3.1-pro-preview-thinking` | 预览 / thinking 类，需关注输出稳定性 |
| `QwenVLMax-250408` | `qwen-vl-max-2025-04-08` | 国内 API 里较值得关注 |
| `QwenVLMax` | `qwen-vl-max` | 如无版本锁定需求可用 |
| `Together_Qwen2-VL-72B` | `Qwen/Qwen2-VL-72B-Instruct` | 依赖 Together API |
| `Qwen2.5-VL-32B-Instruct-SiliconFlow` | `Qwen/Qwen2.5-VL-32B-Instruct` | 依赖 SiliconFlow |
| `GLM4V_PLUS_20250111` | `glm-4v-plus-0111` | 可作为国内 API 候选 |
| `GLM4V_PLUS` | `glm-4v-plus` | 同系列候选 |
| `Seed1.6` | `doubao-seed-1.6-250615` | 适合你电商图场景重点关注 |
| `Seed1.6-Flash` | `doubao-seed-1.6-flash-250615` | 更偏速度 |
| `Seed1.6-Thinking` | `doubao-seed-1.6-thinking-250615` | thinking 模式要关注 JSON 输出稳定性 |
| `Doubao-Seed-2.0-Pro-260215` | `doubao-seed-2-0-pro-260215` | 高质量候选 |
| `moonshot-v1-32k` | `moonshot-v1-32k-vision-preview` | 视觉预览版 |
| `ernie4.5-turbo` | `ernie-4.5-turbo-vl-32k` | 百度系可选 |
| `grok-2-vision-1212` | `grok-2-vision` | xAI 视觉模型 |
| `grok-4-0709` | `grok-4-0709` | 新版本候选 |

### 这一类的推荐优先级

如果你是为了“商品图自动审图 + 给修改建议”，我建议优先从这几个开始：

1. `Claude4_Sonnet`
2. `GeminiFlash2-5`
3. `GeminiPro2-5`
4. `GPT4o_20241120`
5. `gpt-4.1-2025-04-14`
6. `QwenVLMax-250408`
7. `Seed1.6`
8. `GLM4V_PLUS_20250111`

## 二类：provider 别名 / 云平台专用键

这些键也能在官方 `config.py` 里看到，但它们不是“通用 API key 一把梭”的类型。

| registry key | 说明 |
| --- | --- |
| `GCP_Claude3-5Sonnet` | 走 GCP Vertex |
| `GCP_Claude3-7Sonnet` | 走 GCP Vertex |
| `GCP_ClaudeSonnet4-5` | 走 GCP Vertex |
| `GCP_ClaudeOpus4-6` | 走 GCP Vertex |
| `Bedrock_Claude3-5Sonnet` | 走 AWS Bedrock |
| `Bedrock_Claude3Opus` | 走 AWS Bedrock |
| `Bedrock_Claude3Sonnet` | 走 AWS Bedrock |
| `Bedrock_Claude3Haiku` | 走 AWS Bedrock |
| `Together_Llama3.2-11B-Vision` | 走 Together |
| `Together_Llama3.2-90B-Vision` | 走 Together |
| `Together_Llama4-Scout-17B` | 走 Together |
| `Together_Llama4-Maverick-17B` | 走 Together |

如果你项目里没有这些 provider 的独立鉴权与网络配置，就不要优先选它们。

## 三类：开源 / 本地模型

这些模型适合“本地部署后再接入 VLMEvalKit”，不一定适合你当前这套桌面应用直接在线用。

| registry key | 对应模型路径 / 含义 | 备注 |
| --- | --- | --- |
| `MiniCPM-V-2_6` | `openbmb/MiniCPM-V-2_6` | 较常见 |
| `MiniCPM-o-2_6` | `openbmb/MiniCPM-o-2_6` | 官方 README 也提到过 |
| `MiniCPM-V-4_5` | `openbmb/MiniCPM-V-4_5` | 新一些 |
| `MiniCPM-o-4_5` | `openbmb/MiniCPM-o-4_5` | 多模态能力更全 |
| `granite_vision_3.3_2b` | `ibm-granite/granite-vision-3.3-2b` | 轻量 |
| `emu3_chat` | `BAAI/Emu3-Chat` | 开源路线 |
| `MMAlaya2` | `DataCanvas/MMAlaya2` | 可本地 |
| `qwen_base` | `Qwen/Qwen-VL` | 早期 Qwen-VL |
| `qwen_chat` | `Qwen/Qwen-VL-Chat` | 早期 Qwen-VL Chat |
| `llava_next_qwen_32b` | `lmms-lab/llava-next-qwen-32b` | 资源需求大 |
| `llava-onevision-qwen2-0.5b-ov-hf` | `llava-hf/llava-onevision-qwen2-0.5b-ov-hf` | 轻量候选 |
| `llava_next_72b` | `llava-hf/llava-next-72b-hf` | 很重，不适合轻量桌面闭环 |
| `llava_next_110b` | `llava-hf/llava-next-110b-hf` | 更重 |
| `Bunny-llama3-8B` | `BAAI/Bunny-v1_1-Llama-3-8B-V` | 开源候选 |
| `Pixtral-12B` | `mistralai/Pixtral-12B-2409` | 开源强模型候选 |

## 哪些“名字看起来能用”，但不建议你直接填

### 1. 不要把模型族名当成 registry key

例如这些说法在 README 里出现过，但**不一定能直接拿来填 `VLMEVAL_MODEL_ID`**：

- `InternVL3 Series`
- `Qwen2.5VL Series`
- `Ovis2`
- `SmolVLM2`
- `Phi4`
- `Kimi-VL`

原因：

- README 里说的是“支持某个模型族”
- 但你真正要填的，是当前安装版本 `supported_VLM` 里的具体键名
- 有些族名对应多个不同 registry key
- 还有些实现依赖本地权重或定制运行时，而不是直接一个通用 API key 就能跑

### 2. 不要把底层 provider model 名和 registry key 混用

错误示例：

- `VLMEVAL_USE_CUSTOM_MODEL=false` 时填 `claude-4-sonnet-20250514`
- `VLMEVAL_USE_CUSTOM_MODEL=false` 时填 `gemini-2.5-pro`

这通常会失败，因为 `false` 模式下要查的是 `supported_VLM` 键名，不是 provider 原始模型名。

正确示例：

- `VLMEVAL_USE_CUSTOM_MODEL=false` + `VLMEVAL_MODEL_ID=Claude4_Sonnet`
- `VLMEVAL_USE_CUSTOM_MODEL=false` + `VLMEVAL_MODEL_ID=GeminiPro2-5`

### 3. thinking / preview 模型要小心

VLMEvalKit 官方 README 在近几次更新里特别提到：

- thinking 模式模型最好启用 `SPLIT_THINK=True`
- 长输出模型最好启用 `PRED_FORMAT=tsv`

而你这个项目的目标是：

- 单图在线评测
- 严格 JSON 输出
- 120 秒内给出结构化分数和缺陷建议

所以首版更建议优先用：

- 非 preview
- 非超长 thinking
- 返回稳定、速度较快的视觉模型

## 适合你项目的默认建议

### 方案 A：最稳妥

适用于你现在最关注“稳定输出结构化评分 JSON”。

```env
EVAL_BACKEND=vlmevalkit
VLMEVAL_USE_CUSTOM_MODEL=true
VLMEVAL_MODEL_ID=claude-4-sonnet-20250514
```

特点：

- 不依赖 `supported_VLM` 键名
- 仍然走你项目内置 Anthropic adapter
- 最适合先把闭环跑稳

### 方案 B：真正走 VLMEvalKit registry

适用于你想验证“官方已注册模型能不能直接当 judge”。

```env
EVAL_BACKEND=vlmevalkit
VLMEVAL_USE_CUSTOM_MODEL=false
VLMEVAL_MODEL_ID=Claude4_Sonnet
```

可替换候选：

- `GeminiFlash2-5`
- `GeminiPro2-5`
- `GPT4o_20241120`
- `gpt-4.1-2025-04-14`
- `QwenVLMax-250408`
- `Seed1.6`
- `GLM4V_PLUS_20250111`

### 方案 C：国内 API 优先

如果你更希望国内调用链路：

```env
EVAL_BACKEND=vlmevalkit
VLMEVAL_USE_CUSTOM_MODEL=false
VLMEVAL_MODEL_ID=QwenVLMax-250408
```

备选：

- `Seed1.6`
- `Doubao-Seed-2.0-Pro-260215`
- `GLM4V_PLUS_20250111`
- `ernie4.5-turbo`

## 如何查看你本机安装版本的“完整可用键名”

建议以**你实际安装的 `vlmeval` 版本**为准，因为官方仓库会持续变化。

Windows PowerShell 示例：

```powershell
python -c "from vlmeval.config import supported_VLM; keys=sorted(supported_VLM.keys()); print('total=', len(keys)); print(*keys, sep='\n')"
```

按关键字过滤：

```powershell
python -c "from vlmeval.config import supported_VLM; print(*[k for k in sorted(supported_VLM.keys()) if 'Claude' in k], sep='\n')"
python -c "from vlmeval.config import supported_VLM; print(*[k for k in sorted(supported_VLM.keys()) if 'Gemini' in k], sep='\n')"
python -c "from vlmeval.config import supported_VLM; print(*[k for k in sorted(supported_VLM.keys()) if 'Qwen' in k or 'qwen' in k], sep='\n')"
```

如果你想做成团队内固定流程，建议每次升级 `vlmeval` 后都重新导出一次列表，再决定是否更新这份文档。

## 本项目里的配置建议

| 目标 | 建议配置 |
| --- | --- |
| 先把在线单图评测跑稳 | `VLMEVAL_USE_CUSTOM_MODEL=true` |
| 验证官方 registry 模型 | `VLMEVAL_USE_CUSTOM_MODEL=false` + 填 registry key |
| 控制成本 | 优先试 `GPT4o_MINI`、`GeminiFlash2-0`、`GeminiFlash2-5` |
| 国内可用性 | 优先试 `QwenVLMax-250408`、`Seed1.6`、`GLM4V_PLUS_20250111` |
| 强调主观审美和细节缺陷分析 | 优先试 `Claude4_Sonnet`、`GeminiPro2-5`、`GPT4o_20241120` |

## 参考资料

- VLMEvalKit 官方 README：
  - https://github.com/open-compass/VLMEvalKit
- VLMEvalKit 官方模型注册表：
  - https://github.com/open-compass/VLMEvalKit/blob/main/vlmeval/config.py
- 本项目接入实现：
  - `python/vlmeval_server.py`
  - `src/main/ipc/agent.handler.ts`
  - `src/main/agent/vlmeval-bridge.ts`

## 更新时间

- 本文基于 **2026-04-17** 查阅到的官方仓库内容整理。
- 后续若 VLMEvalKit 新增模型，请优先以官方 `config.py` 与你本地安装版本为准。
