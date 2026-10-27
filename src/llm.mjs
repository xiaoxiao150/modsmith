/**
 * LLM 适配器。
 *
 * modsmith 不绑定任何一家 provider：从环境变量里读一个 OpenAI 兼容端点就够。这样
 * 既能用云端的，也能指向本机的 llama-server / vLLM。
 *
 *   MODSMITH_BASE_URL  默认 http://127.0.0.1:8080/v1
 *   MODSMITH_API_KEY   没设就不发 Authorization（本机服务通常不要）
 *   MODSMITH_MODEL     默认读 /v1/models 的第一条
 *   MODSMITH_MAX_TOKENS  回复上限，默认 8000（推理模型会把预算先烧在思考上，
 *                        2000 时正文直接为空——DeepSeek deepseek-flash 实测）
 *   MODSMITH_REASONING_EFFORT  可选 low/high/max；端点不认就忽略
 */
const BASE = (process.env.MODSMITH_BASE_URL ?? 'http://127.0.0.1:8080/v1').replace(/\/$/, '');
const KEY = process.env.MODSMITH_API_KEY ?? '';
const MODEL = process.env.MODSMITH_MODEL ?? '';
const TIMEOUT_MS = Number(process.env.MODSMITH_TIMEOUT_MS ?? 180000);
const MAX_TOKENS = Math.max(200, Number(process.env.MODSMITH_MAX_TOKENS ?? 8000) || 8000);
const REASONING_EFFORT = process.env.MODSMITH_REASONING_EFFORT ?? '';
/**
 * 关掉推理模型的 thinking。
 *
 * 本地 Qwen 这类模型默认把 token 全花在思考上，content 回来是空的（实测）。
 * llama-server 认 `chat_template_kwargs.enable_thinking`。云端模型忽略这个字段，无副作用。
 */
const NO_THINKING = process.env.MODSMITH_THINKING !== '1';

function headers() {
  const h = { 'Content-Type': 'application/json' };
  if (KEY) h.Authorization = `Bearer ${KEY}`;
  return h;
}

/** 挑一个模型名：没配就看服务端有什么。 */
async function resolveModel() {
  if (MODEL) return MODEL;
  try {
    const res = await fetch(`${BASE}/models`, { headers: headers() });
    if (res.ok) {
      const data = await res.json();
      const first = data?.data?.[0]?.id;
      if (first) return first;
    }
  } catch {
    // 列不出来就交给下面的报错
  }
  throw new Error(`读不到模型名（${BASE}/models 没给）；用 MODSMITH_MODEL 指定`);
}

/**
 * 问一次模型，返回纯文本。
 *
 * 推理模型的坑（DeepSeek deepseek-flash 实测）：它先把 token 花在 reasoning 上，
 * 预算不够时 content 是空的——一次调用可能想 3 万字。所以正文为空且带思考内容时
 * **自动重试一次**：预算放大到 4 倍（上限 32000）并尽量把思考压低；端点不认
 * reasoning_effort 就退回不带它再试。仍然拿不到正文才报错，并说明旋钮。
 * @param {string} prompt
 * @param {{temperature?: number, maxTokens?: number}} [opts]
 */
export async function askModel(prompt, opts = {}) {
  const model = await resolveModel();
  const baseTokens = opts.maxTokens ?? MAX_TOKENS;
  const attempt = async (maxTokens, effort) => {
    const body = {
      model,
      messages: [
        { role: 'system', content: '你只输出 JSON，不解释、不加 markdown 代码块。' },
        { role: 'user', content: prompt },
      ],
      temperature: opts.temperature ?? 0.2,
      max_tokens: maxTokens,
      stream: false,
      ...(effort ? { reasoning_effort: effort } : {}),
      ...(NO_THINKING ? { chat_template_kwargs: { enable_thinking: false } } : {}),
    };
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(`${BASE}/chat/completions`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify(body),
        signal: ac.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        const err = new Error(`模型调用失败 HTTP ${res.status}: ${text.slice(0, 300)}`);
        err.status = res.status;
        throw err;
      }
      const data = await res.json();
      const message = data?.choices?.[0]?.message;
      return {
        content: message?.content,
        reasoningChars: typeof message?.reasoning_content === 'string' ? message.reasoning_content.length : 0,
        finish: data?.choices?.[0]?.finish_reason,
      };
    } finally {
      clearTimeout(timer);
    }
  };

  const first = await attempt(baseTokens, REASONING_EFFORT);
  if (typeof first.content === 'string' && first.content.trim() !== '') return first.content;

  const retryTokens = Math.min(Math.max(baseTokens * 4, 16000), 32000);
  if (first.reasoningChars > 0) {
    let retry;
    try {
      // 没显式配 effort 时，重试时主动压到 low（多数 OpenAI 兼容端点会忽略未知字段）
      retry = await attempt(retryTokens, REASONING_EFFORT || 'low');
    } catch (err) {
      if (err.status === 400 && !REASONING_EFFORT) {
        retry = await attempt(retryTokens, '');
      } else {
        throw err;
      }
    }
    if (typeof retry.content === 'string' && retry.content.trim() !== '') return retry.content;
    throw new Error(`模型两次都只回了思考内容（${first.reasoningChars} / ${retry.reasoningChars} 字），正文为空：`
      + `max_tokens 已放到 ${retryTokens}。调大 MODSMITH_MAX_TOKENS 或设 MODSMITH_REASONING_EFFORT=low`);
  }
  throw new Error('模型没回内容（content 为空）');
}

/** 探活：给 CLI 一个"能不能调"的前置检查。 */
export async function probeModel() {
  try {
    const model = await resolveModel();
    return { ok: true, model, base: BASE };
  } catch (err) {
    return { ok: false, error: String(err.message ?? err), base: BASE };
  }
}
