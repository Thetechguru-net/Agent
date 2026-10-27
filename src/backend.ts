// Client for the user's AI backend.
//
// Request:  POST <url>
//           Authorization: Bearer <token>
//           Content-Type: application/json
//           OpenAI chat-completions format:
//           { "model": "<model, if set>", "stream": false,
//             "messages": [...history, { "role": "user", "content": "<transcript>" }] }
//
// Response: either plain text, or JSON with the reply in one of the common
// fields (`reply`, `response`, `answer`, `text`, `message`, `content`,
// `output`) or in OpenAI chat shape (`choices[0].message.content`).

export interface ChatTurn {
  role: 'user' | 'assistant'
  content: string
}

export interface BackendConfig {
  url: string
  token: string
  /** Sent as `model` when non-empty; many OpenAI-compatible servers require it. */
  model: string
}

const TIMEOUT_MS = 60_000

export async function askBackend(
  cfg: BackendConfig,
  message: string,
  history: ChatTurn[],
  signal?: AbortSignal,
): Promise<string> {
  // AbortSignal.any / AbortSignal.timeout are missing on older phone WebViews.
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(new DOMException('Backend timed out', 'TimeoutError')), TIMEOUT_MS)
  const onAbort = () => ctrl.abort(signal?.reason)
  signal?.addEventListener('abort', onAbort)
  try {
    return await post(cfg, message, history, ctrl.signal)
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}

async function post(
  cfg: BackendConfig,
  message: string,
  history: ChatTurn[],
  signal: AbortSignal,
): Promise<string> {
  const res = await fetch(cfg.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/plain',
      ...(cfg.token ? { Authorization: `Bearer ${cfg.token}` } : {}),
    },
    body: JSON.stringify({
      ...(cfg.model ? { model: cfg.model } : {}),
      stream: false,
      messages: [...history, { role: 'user', content: message }],
    }),
    signal,
  })

  const body = await res.text()
  if (!res.ok) {
    throw new Error(`Backend ${res.status}: ${errorMessage(body) || res.statusText}`)
  }

  const reply = extractReply(body)
  if (!reply) throw new Error('Backend returned an empty response')
  return reply
}

function extractReply(body: string): string {
  let data: unknown
  try {
    data = JSON.parse(body)
  } catch {
    return body.trim()
  }
  if (typeof data === 'string') return data.trim()
  if (!data || typeof data !== 'object') return String(data ?? '').trim()

  const obj = data as Record<string, any>
  for (const key of ['reply', 'response', 'answer', 'text', 'message', 'content', 'output']) {
    const v = obj[key]
    if (typeof v === 'string') return v.trim()
    if (v && typeof v.content === 'string') return v.content.trim()
  }
  const choice = obj.choices?.[0]
  if (typeof choice?.message?.content === 'string') return choice.message.content.trim()
  if (typeof choice?.text === 'string') return choice.text.trim()

  return body.trim()
}

/** Pull a readable message out of an error body (OpenAI shape or plain text). */
function errorMessage(body: string): string {
  try {
    const data = JSON.parse(body)
    const msg = data?.error?.message ?? data?.error ?? data?.message ?? data?.detail
    if (typeof msg === 'string') return msg
  } catch {
    // not JSON
  }
  return body.slice(0, 160)
}
