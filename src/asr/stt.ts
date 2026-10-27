// Soniox real-time speech-to-text client for the G2 microphone.
//
// The G2 mic emits PCM s16le @ 16 kHz, mono via `bridge.audioControl(true)`.
// Each onEvenHubEvent callback with `audioEvent.audioPcm` delivers a chunk,
// which is forwarded here as a binary WebSocket frame.
//
// Protocol (https://soniox.com/docs/stt/api-reference/websocket-api):
//   • Connect to wss://stt-rt.soniox.com/transcribe-websocket, passing the API
//     key in the WebSocket protocols list as ['soniox-api-key', <key>].
//   • Send a JSON start message, then binary audio frames.
//   • Send an empty TEXT frame to end the stream; the server flushes the
//     remaining tokens, sends `{ finished: true }` and closes.
//
// Each snapshot is a full transcript state, not a delta:
//   - finalText: text Soniox is confident about
//   - interimText: unstable tail that may still change
//   - finished: true on the terminal message

const SONIOX_URL = 'wss://stt-rt.soniox.com/transcribe-websocket'
const SONIOX_MODEL = 'stt-rt-v5'

export interface SttSnapshot {
  finalText: string
  interimText: string
  finished: boolean
}

export interface SttClient {
  sendPcm(chunk: Uint8Array): void
  /** Signal end of audio; Soniox flushes and emits a `finished` snapshot. */
  finish(): void
  /** Hard close without waiting for the final snapshot. */
  close(): void
}

export interface SttOptions {
  apiKey: string
  onSnapshot: (snap: SttSnapshot) => void
  onError?: (err: unknown) => void
  /** Called when Soniox detects the speaker has stopped talking. Enables endpoint detection. */
  onEndpoint?: () => void
  languageHints?: string[]
}

interface SonioxToken {
  text: string
  is_final?: boolean
}

interface SonioxResponse {
  tokens?: SonioxToken[]
  finished?: boolean
  error_code?: number
  error_type?: string
  error_message?: string
}

// Control tokens Soniox injects into the stream: `<end>` marks a detected
// endpoint, `<fin>` acknowledges a manual finalize. Neither is speech.
const CONTROL_TOKENS = new Set(['<end>', '<fin>'])

type AuthMode = 'protocol' | 'start-message'

export function startSttStream(opts: SttOptions): SttClient {
  const apiKey = cleanKey(opts.apiKey)

  // Every frame sent since the stream started, so a retry with the other auth
  // mode can replay the utterance. Dropped once Soniox returns tokens.
  let sent: Uint8Array<ArrayBuffer>[] | null = []
  // Mic frames that arrived while the socket was still connecting.
  const pending: Uint8Array<ArrayBuffer>[] = []
  let finalText = ''
  let finishRequested = false
  let done = false
  let ws: WebSocket

  function connect(mode: AuthMode) {
    // The protocols list is the documented auth for browsers. Some keys / hosts
    // reject it, so on a 401 we fall back to `api_key` in the start message
    // (accepted by Soniox until 15 January 2027).
    const sock =
      mode === 'protocol' ? new WebSocket(SONIOX_URL, ['soniox-api-key', apiKey]) : new WebSocket(SONIOX_URL)
    sock.binaryType = 'arraybuffer'
    ws = sock
    let gotMessage = false

    const retry = () => {
      if (mode !== 'protocol' || gotMessage || done || sock !== ws) return false
      console.warn('Soniox rejected protocol auth — retrying with api_key in the start message')
      pending.unshift(...(sent ?? []))
      sent = []
      sock.onclose = null
      sock.close()
      connect('start-message')
      return true
    }

    sock.onopen = () => {
      sock.send(
        JSON.stringify({
          ...(mode === 'start-message' ? { api_key: apiKey } : {}),
          model: SONIOX_MODEL,
          audio_format: 's16le',
          sample_rate: 16000,
          num_channels: 1,
          language_hints: opts.languageHints ?? ['en'],
          enable_endpoint_detection: !!opts.onEndpoint,
        }),
      )
      for (const chunk of pending) send(chunk)
      pending.length = 0
      if (finishRequested) sock.send('')
    }

    sock.onmessage = ev => {
      if (sock !== ws) return
      let msg: SonioxResponse
      try {
        msg = JSON.parse(ev.data as string)
      } catch {
        return
      }

      if (msg.error_code) {
        if (msg.error_code === 401 && retry()) return
        done = true
        opts.onError?.(
          new Error(
            `Soniox ${msg.error_code}${msg.error_type ? ` ${msg.error_type}` : ''}: ${msg.error_message ?? 'error'}`,
          ),
        )
        return
      }
      gotMessage = true
      sent = null

      let interimText = ''
      let endpoint = false
      for (const t of msg.tokens ?? []) {
        if (CONTROL_TOKENS.has(t.text)) {
          if (t.text === '<end>') endpoint = true
          continue
        }
        if (t.is_final) finalText += t.text
        else interimText += t.text
      }

      const finished = !!msg.finished
      if (finished) done = true
      opts.onSnapshot({ finalText, interimText, finished })
      if (endpoint) opts.onEndpoint?.()
    }

    sock.onclose = ev => {
      if (done || sock !== ws) return
      // A handshake rejected with HTTP 401 surfaces only as an abnormal close.
      if (ev.code === 1006 && retry()) return
      done = true
      if (ev.code !== 1000) {
        opts.onError?.(
          new Error(
            ev.code === 1006
              ? 'Could not connect to Soniox — check the API key and network'
              : `Soniox closed (${ev.code}${ev.reason ? `: ${ev.reason}` : ''})`,
          ),
        )
      }
      // Make sure the caller always gets a terminal snapshot.
      opts.onSnapshot({ finalText, interimText: '', finished: true })
    }
  }

  function send(chunk: Uint8Array<ArrayBuffer>) {
    ws.send(chunk)
    sent?.push(chunk)
  }

  connect('protocol')

  return {
    sendPcm(pcm) {
      if (finishRequested) return
      // Mic frames are never backed by a SharedArrayBuffer; narrow for WebSocket.send.
      const chunk = pcm as Uint8Array<ArrayBuffer>
      if (ws.readyState === WebSocket.OPEN) send(chunk)
      else if (ws.readyState === WebSocket.CONNECTING) pending.push(chunk)
    },
    finish() {
      if (finishRequested) return
      finishRequested = true
      if (ws.readyState === WebSocket.OPEN) ws.send('')
    },
    close() {
      done = true
      ws.close()
    },
  }
}

/** Strip whitespace, quotes, and a pasted 'Bearer ' prefix from a key. */
function cleanKey(key: string): string {
  return key.trim().replace(/^["']+|["']+$/g, '').replace(/^Bearer\s+/i, '').trim()
}
