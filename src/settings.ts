import type { EvenAppBridge } from '@evenrealities/even_hub_sdk'

// User-provided settings, entered in the companion UI and persisted with the
// SDK's storage (browser localStorage does not survive app restarts in the
// Even App WebView). `.env.local` values act as defaults for development.

export interface Settings {
  sonioxApiKey: string
  backendUrl: string
  backendToken: string
  backendModel: string
}

const KEYS: Record<keyof Settings, string> = {
  sonioxApiKey: 'voiceai.sonioxApiKey',
  backendUrl: 'voiceai.backendUrl',
  backendToken: 'voiceai.backendToken',
  backendModel: 'voiceai.backendModel',
}

const DEFAULTS: Settings = {
  sonioxApiKey: (import.meta.env.VITE_SONIOX_API_KEY as string) ?? '',
  backendUrl: (import.meta.env.VITE_BACKEND_URL as string) ?? '',
  backendToken: (import.meta.env.VITE_BACKEND_TOKEN as string) ?? '',
  backendModel: (import.meta.env.VITE_BACKEND_MODEL as string) ?? '',
}

export async function loadSettings(bridge: EvenAppBridge): Promise<Settings> {
  const out = { ...DEFAULTS }
  for (const field of Object.keys(KEYS) as (keyof Settings)[]) {
    try {
      const v = await bridge.getLocalStorage(KEYS[field])
      if (v) out[field] = v
    } catch (err) {
      console.warn(`getLocalStorage(${KEYS[field]}) failed`, err)
    }
  }
  return out
}

export async function saveSettings(bridge: EvenAppBridge, s: Settings): Promise<void> {
  for (const field of Object.keys(KEYS) as (keyof Settings)[]) {
    await bridge.setLocalStorage(KEYS[field], s[field].trim())
  }
}

export function isConfigured(s: Settings): boolean {
  return !!(s.sonioxApiKey && s.backendUrl)
}
