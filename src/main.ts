import {
  waitForEvenAppBridge,
  TextContainerProperty,
  CreateStartUpPageContainer,
  TextContainerUpgrade,
  OsEventTypeList,
  type EvenAppBridge,
} from '@evenrealities/even_hub_sdk'
import { startSttStream, type SttClient } from './asr/stt'
import { askBackend, type ChatTurn } from './backend'
import { loadSettings, saveSettings, isConfigured, type Settings } from './settings'
import { mountUi, fillSettings, setStatus, setLive, addTurn } from './ui'

// Interaction model:
//   • The first question after launch is captured hands-free — Soniox endpoint
//     detection ends the turn when the user stops speaking.
//   • Every question after that is push-to-talk: long-press the R1 ring or
//     either temple pad to start, release to send.
//   • Swipe up/down pages through a long response. Double-tap exits.

type Phase = 'setup' | 'listening' | 'transcribing' | 'thinking' | 'idle'

const PAGE_CHARS = 380 // ~400–500 chars fill the screen; leave room for the footer
const HISTORY_TURNS = 12
const FINISH_TIMEOUT_MS = 4000
// A press shorter than this (0.3 s of 16 kHz s16le audio) is treated as a
// mis-tap: Soniox rejects a stream with no audio ('400 No audio received').
const MIN_AUDIO_BYTES = 16000 * 2 * 0.3
const HINT_MS = 2000
// Mount the phone UI before waiting on the bridge so failures are visible
// instead of a blank screen.
let bridge!: EvenAppBridge // assigned before `ready` is set
let ready = false
mountUi({
  onSave: s => ready && void applySettings(s),
  onTalkStart: () => ready && startListening(false),
  onTalkEnd: () => ready && releaseTalk(),
})
setStatus('connecting', 'Waiting for Even app…')

const reportFatal = (msg: string) => {
  console.error(msg)
  setStatus('error', msg)
  addTurn('error', msg)
}
window.addEventListener('error', e => reportFatal(`Error: ${e.message}`))
window.addEventListener('unhandledrejection', e => reportFatal(`Error: ${(e.reason as Error)?.message ?? e.reason}`))

bridge = await waitForEvenAppBridge()

let settings: Settings = await loadSettings(bridge)
fillSettings(settings, !isConfigured(settings))
ready = true

const screen = new TextContainerProperty({
  xPosition: 0,
  yPosition: 0,
  width: 576,
  height: 288,
  borderWidth: 0,
  borderColor: 5,
  paddingLength: 6,
  containerID: 1,
  containerName: 'screen',
  content: 'Voice AI',
  isEventCapture: 1,
})

const created = await bridge.createStartUpPageContainer(
  new CreateStartUpPageContainer({ containerTotalNum: 1, textObject: [screen] }),
)
if (created !== 0) {
  setStatus('error', `createStartUpPageContainer failed: ${created}`)
  console.error('Failed to create startup page', created)
}

// ── Glasses rendering ────────────────────────────────────────────────────

let lastRender = ''
let renderTimer: number | null = null
let currentContent = ''

function show(content: string) {
  currentContent = content
  if (renderTimer !== null) return
  renderTimer = window.setTimeout(async () => {
    renderTimer = null
    if (currentContent === lastRender) return
    lastRender = currentContent
    await bridge.textContainerUpgrade(
      new TextContainerUpgrade({ containerID: 1, containerName: 'screen', content: currentContent }),
    )
  }, 120) // debounce display writes — BLE render queue is slow
}

const tail = (s: string, n: number) => (s.length > n ? '…' + s.slice(-n) : s)

// ── State ────────────────────────────────────────────────────────────────

let phase: Phase = 'setup'
let firstTurn = true // hands-free until the first question is sent
let handsFree = false // current listen ends on Soniox endpoint, not on release
let stt: SttClient | null = null
let transcript = { final: '', interim: '' }
let finishTimer: number | null = null
let audioBytes = 0 // PCM captured during the current listen
let hintTimer: number | null = null
let inflight: AbortController | null = null
const history: ChatTurn[] = []
let pages: string[] = []
let pageIndex = 0

async function applySettings(s: Settings) {
  try {
    await saveSettings(bridge, s)
  } catch (err) {
    setStatus('error', `Could not save settings: ${(err as Error).message}`)
    return
  }
  settings = await loadSettings(bridge)
  fillSettings(settings, !isConfigured(settings))
  if (phase === 'setup') begin()
}

function begin() {
  if (!isConfigured(settings)) {
    phase = 'setup'
    setStatus('error', 'Enter your Soniox key and backend URL')
    show('Voice AI\n\nOpen the Even app on your phone and enter your Soniox API key and AI backend URL.')
    return
  }
  phase = 'idle'
  if (firstTurn) startListening(true)
  else showIdle()
}

// Briefly show a hint, then restore the answer (or idle screen) underneath.
function flashHint(note: string) {
  if (hintTimer !== null) clearTimeout(hintTimer)
  show(note)
  hintTimer = window.setTimeout(() => {
    hintTimer = null
    if (phase !== 'idle') return
    if (pages.length) renderPage()
    else showIdle()
  }, HINT_MS)
}

function showIdle(note = '') {
  phase = 'idle'
  setStatus('idle', 'Ready · long-press to talk')
  show(`${note ? note + '\n\n' : ''}Long-press ring or temple to talk.`)
}

// ── Listening ────────────────────────────────────────────────────────────

function startListening(endOnSilence: boolean) {
  if (phase === 'setup') return
  if (phase === 'listening') {
    // A long-press during the hands-free first turn hands control to the user.
    handsFree = false
    return
  }
  if (phase === 'transcribing') return

  // A new question supersedes whatever was being answered.
  inflight?.abort()
  inflight = null

  if (hintTimer !== null) {
    clearTimeout(hintTimer)
    hintTimer = null
  }

  phase = 'listening'
  handsFree = endOnSilence
  audioBytes = 0
  transcript = { final: '', interim: '' }
  setLive('')

  const client = startSttStream({
    apiKey: settings.sonioxApiKey,
    onSnapshot: snap => {
      if (client !== stt) return
      transcript = { final: snap.finalText, interim: snap.interimText }
      const text = (snap.finalText + snap.interimText).trim()
      setLive(text)
      if (phase === 'listening') renderListening(text)
      if (snap.finished) void submit()
    },
    onEndpoint: () => {
      if (client === stt && phase === 'listening' && handsFree) stopListening()
    },
    onError: err => {
      if (client !== stt) return
      if (/no audio/i.test((err as Error)?.message ?? '')) {
        cancelTooShort()
        return
      }
      console.error('STT error:', err)
      abortListening(`STT error: ${(err as Error)?.message ?? err}`)
    },
  })
  stt = client

  void bridge.audioControl(true)
  setStatus('listening', handsFree ? 'Listening · ask your question' : 'Listening · release to send')
  renderListening('')
}

function renderListening(text: string) {
  const hint = handsFree ? 'Ask me anything…' : 'Listening… release to send'
  show(`● ${hint}\n\n${tail(text, 300)}`)
}

function releaseTalk() {
  if (phase === 'listening' && !handsFree) stopListening()
}

function stopListening() {
  if (phase !== 'listening' || !stt) return
  if (audioBytes < MIN_AUDIO_BYTES) {
    cancelTooShort()
    return
  }
  phase = 'transcribing'
  void bridge.audioControl(false)
  stt.finish()
  // If Soniox never sends `finished`, go with what we have.
  finishTimer = window.setTimeout(() => void submit(), FINISH_TIMEOUT_MS)
}

/** Drop a listen that captured (almost) no audio, without asking Soniox to transcribe it. */
function cancelTooShort() {
  void bridge.audioControl(false)
  stt?.close()
  stt = null
  clearFinishTimer()
  setLive('')
  phase = 'idle'
  setStatus('idle', 'Ready · long-press to talk')
  flashHint('Too short — hold the ring or temple while you talk.')
}

function abortListening(message: string) {
  void bridge.audioControl(false)
  stt?.close()
  stt = null
  clearFinishTimer()
  setStatus('error', message)
  addTurn('error', message)
  showIdle(message)
}

function clearFinishTimer() {
  if (finishTimer !== null) {
    clearTimeout(finishTimer)
    finishTimer = null
  }
}

// ── Asking the backend ───────────────────────────────────────────────────

async function submit() {
  if (phase !== 'transcribing') return
  clearFinishTimer()
  stt?.close()
  stt = null

  const question = (transcript.final + transcript.interim).trim()
  setLive('')
  if (!question) {
    showIdle("Didn't catch that.")
    return
  }

  firstTurn = false
  phase = 'thinking'
  addTurn('user', question)
  setStatus('thinking', 'Thinking…')
  show(`You: ${tail(question, 200)}\n\n… thinking`)

  const ctrl = new AbortController()
  inflight = ctrl
  try {
    const reply = await askBackend(
      { url: settings.backendUrl, token: settings.backendToken, model: settings.backendModel },
      question,
      history.slice(-HISTORY_TURNS),
      ctrl.signal,
    )
    if (inflight !== ctrl) return
    history.push({ role: 'user', content: question }, { role: 'assistant', content: reply })
    addTurn('assistant', reply)
    showReply(reply)
  } catch (err) {
    if (inflight !== ctrl || ctrl.signal.aborted) return
    const msg = (err as Error)?.name === 'TimeoutError' ? 'Backend timed out' : (err as Error)?.message ?? String(err)
    console.error('Backend error:', err)
    addTurn('error', msg)
    setStatus('error', msg)
    show(`Error: ${tail(msg, 200)}\n\nLong-press to try again.`)
    phase = 'idle'
  } finally {
    if (inflight === ctrl) inflight = null
  }
}

function showReply(reply: string) {
  phase = 'idle'
  pages = paginate(reply, PAGE_CHARS)
  pageIndex = 0
  setStatus('idle', 'Ready · long-press to talk')
  renderPage()
}

function renderPage() {
  const footer =
    pages.length > 1
      ? `\n\n— ${pageIndex + 1}/${pages.length} · swipe for more`
      : '\n\n— long-press to talk'
  show(pages[pageIndex] + footer)
}

function turnPage(delta: number) {
  if (phase !== 'idle' || pages.length < 2) return
  const next = Math.min(pages.length - 1, Math.max(0, pageIndex + delta))
  if (next === pageIndex) return
  pageIndex = next
  renderPage()
}

/** Split text into screen-sized pages, breaking on paragraph, then word boundaries. */
function paginate(text: string, max: number): string[] {
  const out: string[] = []
  let rest = text.trim()
  while (rest.length > max) {
    const slice = rest.slice(0, max)
    let cut = slice.lastIndexOf('\n')
    if (cut < max * 0.5) cut = slice.lastIndexOf(' ')
    if (cut < max * 0.5) cut = max
    out.push(rest.slice(0, cut).trim())
    rest = rest.slice(cut).trim()
  }
  if (rest) out.push(rest)
  return out.length ? out : ['(empty response)']
}

// ── Events ───────────────────────────────────────────────────────────────

let cleanedUp = false
function cleanup() {
  if (cleanedUp) return
  cleanedUp = true
  bridge.audioControl(false)
  stt?.close()
  inflight?.abort()
  unsubscribe()
}

// Reads the event type out of one envelope.
//
// CLICK_EVENT is 0, and protobuf omits zero-value fields on the wire, so a
// single tap arrives as an envelope whose `eventType` is `undefined`. The
// default has to be resolved INSIDE the envelope check, otherwise every audio
// frame (which carries no sysEvent) would read as a tap.
function eventTypeOf(envelope?: { eventType?: OsEventTypeList }): OsEventTypeList | null {
  if (!envelope) return null
  return envelope.eventType ?? OsEventTypeList.CLICK_EVENT
}

// Event routing:
//   • Audio PCM frames come through `event.audioEvent`.
//   • Gestures arrive in `sysEvent` (with `eventSource` = ring / left / right
//     temple) or in `textEvent` for our capture container — check both.
//   • Double-tap → exit dialog is checked first so the user can always leave.
const unsubscribe = bridge.onEvenHubEvent(event => {
  const pcm = event.audioEvent?.audioPcm
  if (pcm) {
    if (phase === 'listening') audioBytes += pcm.length
    stt?.sendPcm(pcm)
  }

  const sysType = eventTypeOf(event.sysEvent)
  const textType = eventTypeOf(event.textEvent)
  const is = (t: OsEventTypeList) => sysType === t || textType === t

  if (is(OsEventTypeList.DOUBLE_CLICK_EVENT)) {
    bridge.shutDownPageContainer(1)
    return
  }
  if (is(OsEventTypeList.LONG_PRESS_EVENT)) {
    startListening(false)
    return
  }
  if (is(OsEventTypeList.LONG_PRESS_RELEASE_EVENT)) {
    releaseTalk()
    return
  }
  if (is(OsEventTypeList.CLICK_EVENT)) {
    // A plain tap does nothing on its own; remind the user how to talk.
    if (phase === 'idle') flashHint("Hold the ring or temple to talk — a tap won't start listening.")
    return
  }
  if (is(OsEventTypeList.SCROLL_BOTTOM_EVENT)) {
    turnPage(1)
    return
  }
  if (is(OsEventTypeList.SCROLL_TOP_EVENT)) {
    turnPage(-1)
    return
  }
  if (sysType === OsEventTypeList.FOREGROUND_EXIT_EVENT && phase === 'listening') {
    // Don't keep the mic open in the background.
    stopListening()
    return
  }
  if (sysType === OsEventTypeList.SYSTEM_EXIT_EVENT || sysType === OsEventTypeList.ABNORMAL_EXIT_EVENT) {
    cleanup()
  }
})

window.addEventListener('beforeunload', cleanup)

begin()
