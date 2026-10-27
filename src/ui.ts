import type { Settings } from './settings'

type Status = 'connecting' | 'idle' | 'listening' | 'thinking' | 'error'

export interface UiHandlers {
  onSave(s: Settings): void
  onTalkStart(): void
  onTalkEnd(): void
}

let statusEl: HTMLDivElement
let liveEl: HTMLDivElement
let logEl: HTMLDivElement
let form: HTMLFormElement

export function mountUi(h: UiHandlers) {
  const app = document.querySelector<HTMLDivElement>('#app')!
  app.innerHTML = `
    <main class="panel">
      <header>
        <h1>Voice AI</h1>
        <div id="status" class="status status-connecting">Connecting…</div>
      </header>

      <details id="settings" class="card">
        <summary>Settings</summary>
        <form id="settings-form" autocomplete="off">
          <label>Soniox API key
            <input name="sonioxApiKey" type="password" spellcheck="false" required />
          </label>
          <label>AI backend URL
            <input name="backendUrl" type="url" placeholder="https://…" spellcheck="false" required />
          </label>
          <label>AI backend token
            <input name="backendToken" type="password" spellcheck="false" />
          </label>
          <label>Model (optional)
            <input name="backendModel" type="text" placeholder="e.g. gpt-4o-mini" spellcheck="false" autocapitalize="off" />
          </label>
          <button type="submit">Save</button>
        </form>
      </details>

      <div id="live" class="live" aria-live="polite"></div>
      <section id="log" class="log"></section>

      <button id="talk" class="talk" type="button">Hold to talk</button>
      <footer>On the glasses: long-press the ring or temple to talk · swipe to page · double-tap to exit.</footer>
    </main>
  `
  statusEl = app.querySelector('#status')!
  liveEl = app.querySelector('#live')!
  logEl = app.querySelector('#log')!
  form = app.querySelector('#settings-form')!

  form.addEventListener('submit', e => {
    e.preventDefault()
    const fd = new FormData(form)
    h.onSave({
      sonioxApiKey: String(fd.get('sonioxApiKey') ?? ''),
      backendUrl: String(fd.get('backendUrl') ?? ''),
      backendToken: String(fd.get('backendToken') ?? ''),
      backendModel: String(fd.get('backendModel') ?? ''),
    })
  })

  // Companion-side push-to-talk mirrors the glasses long-press (handy in the
  // simulator, which has no long-press input).
  const talk = app.querySelector<HTMLButtonElement>('#talk')!
  let held = false
  const end = () => {
    if (!held) return
    held = false
    talk.classList.remove('held')
    h.onTalkEnd()
  }
  talk.addEventListener('pointerdown', e => {
    talk.setPointerCapture(e.pointerId)
    held = true
    talk.classList.add('held')
    h.onTalkStart()
  })
  talk.addEventListener('pointerup', end)
  talk.addEventListener('pointercancel', end)

  injectStyles()
}

export function fillSettings(s: Settings, open: boolean) {
  for (const [k, v] of Object.entries(s)) {
    const input = form.elements.namedItem(k) as HTMLInputElement | null
    if (input) input.value = v
  }
  ;(document.querySelector('#settings') as HTMLDetailsElement).open = open
}

export function setStatus(kind: Status, text: string) {
  if (!statusEl) return
  statusEl.className = `status status-${kind}`
  statusEl.textContent = text
}

export function setLive(text: string) {
  if (liveEl) liveEl.textContent = text
}

export function addTurn(role: 'user' | 'assistant' | 'error', text: string) {
  const el = document.createElement('div')
  el.className = `turn turn-${role}`
  el.textContent = text
  logEl.prepend(el)
}

function injectStyles() {
  // ER brand dark-theme surfaces: #232323 / #2E2E2E / #3E3E3E.
  // ER OS green (#3CFA44) + signal red (#FF453A) for state chips.
  const css = `
    :root { color-scheme: dark; }
    html, body { margin: 0; height: 100%; background: #232323; color: #E5E5E5;
      font: 16px/1.4 -apple-system, BlinkMacSystemFont, 'Helvetica Neue', system-ui, sans-serif;
      touch-action: manipulation; -webkit-text-size-adjust: 100%;
      overscroll-behavior: none; }
    #app { display: flex; min-height: 100%; }
    .panel { display: flex; flex-direction: column; gap: 14px;
      width: 100%; max-width: 640px; margin: 0 auto; padding: 20px 16px; box-sizing: border-box; }
    header { display: flex; align-items: center; justify-content: space-between; }
    h1 { font-size: 18px; font-weight: 600; margin: 0; letter-spacing: 0.02em; }
    .status { font-size: 12px; padding: 4px 10px; border-radius: 999px;
      border: 1px solid transparent; letter-spacing: 0.04em; text-transform: uppercase; }
    .status-connecting { color: #A7A7A7; border-color: #3E3E3E; }
    .status-idle       { color: #E5E5E5; border-color: #7B7B7B; background: rgba(229,229,229,0.06); }
    .status-listening  { color: #3CFA44; border-color: #3CFA44; background: rgba(60,250,68,0.08); }
    .status-thinking   { color: #F5C542; border-color: #F5C542; background: rgba(245,197,66,0.08); }
    .status-error      { color: #FF453A; border-color: #FF453A; background: rgba(255,69,58,0.08); }
    .card { background: #2E2E2E; border: 1px solid #3E3E3E; border-radius: 12px; padding: 12px 16px; }
    summary { cursor: pointer; font-weight: 600; }
    form { display: flex; flex-direction: column; gap: 12px; margin-top: 12px; }
    label { display: flex; flex-direction: column; gap: 4px; font-size: 13px; color: #A7A7A7; }
    input { background: #232323; color: #E5E5E5; border: 1px solid #3E3E3E; border-radius: 8px;
      padding: 10px; font-size: 15px; }
    button { font: inherit; border-radius: 10px; border: 1px solid #3CFA44; color: #3CFA44;
      background: rgba(60,250,68,0.08); padding: 10px; }
    .live { min-height: 1.4em; color: #919191; font-style: italic; }
    .log { flex: 1; display: flex; flex-direction: column; gap: 10px; overflow: auto; }
    .turn { padding: 12px 14px; border-radius: 12px; white-space: pre-wrap; word-break: break-word; }
    .turn-user { background: #3E3E3E; align-self: flex-end; max-width: 85%; }
    .turn-assistant { background: #2E2E2E; border: 1px solid #3E3E3E; }
    .turn-error { color: #FF453A; border: 1px solid #FF453A; }
    .talk { padding: 18px; font-size: 17px; font-weight: 600; user-select: none; -webkit-user-select: none; }
    .talk.held { background: #3CFA44; color: #232323; }
    footer { font-size: 12px; color: #7B7B7B; text-align: center; }
  `
  const style = document.createElement('style')
  style.textContent = css
  document.head.appendChild(style)
}
