/**
 * LLM 适配器。
 *
 * modsmith 不绑定任何一家 provider：从环境变量里读一个 OpenAI 兼容端点就够。这样
 * 既能用云端的，也能指向本机的 llama-server / vLLM。
 *
 *   MODSMITH_BASE_URL  默认 http://127.0.0.1:8080/v1
 *   MODSMITH_API_KEY   没设就不发 Authorization（本机服务通常不要）
 *   MODSMITH_MODEL     默认读 /v1/models 的第一条
 */
const BASE = (process.env.MODSMITH_BASE_URL ?? 'http://127.0.0.1:8080/v1').replace(/\/$/, '');
const KEY = process.env.MODSMITH_API_KEY ?? '';
const MODEL = process.env.MODSMITH_MODEL ?? '';
const TIMEOUT_MS = Number(process.env.MODSMITH_TIMEOUT_MS ?? 180000);
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
 * @param {string} prompt
 * @param {{temperature?: number, maxTokens?: number}} [opts]
 */
export async function askModel(prompt, opts = {}) {
  const model = await resolveModel();
  const body = {
    model,
    messages: [
      { role: 'system', content: '你只输出 JSON，不解释、不加 markdown 代码块。' },
      { role: 'user', content: prompt },
    ],
    temperature: opts.temperature ?? 0.2,
    max_tokens: opts.maxTokens ?? 2000,
    stream: false,
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
      throw new Error(`模型调用失败 HTTP ${res.status}: ${text.slice(0, 300)}`);
    }
    const data = await res.json();
    const msg = data?.choices?.[0]?.message?.content;
    if (typeof msg !== 'string') throw new Error('模型没回内容');
    return msg;
  } finally {
    clearTimeout(timer);
  }
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
