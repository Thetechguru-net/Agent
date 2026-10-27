# Agent — voice AI for Even G2

Ask questions with your voice on Even Realities G2 glasses. Speech is transcribed in real time by [Soniox](https://soniox.com), sent to an AI backend of your choice, and the response is shown on the glasses.

## Using it

1. Open the app. On the phone, fill in **Settings**: Soniox API key, AI backend URL, backend token, and the model name if your backend needs one. These are saved with the Even Hub SDK storage.
2. **First question:** the app starts listening right away. Speak, then pause; Soniox endpoint detection sends your question.
3. **All later questions:** long-press the R1 ring or either temple pad and keep holding while you talk. Release to send. Long-pressing while an answer is loading cancels it and starts a new question.
4. Swipe up/down to page through long answers. Double-tap to exit.

The companion screen also has a **Hold to talk** button, for testing in the simulator (it has no long-press input).

## Backend contract

The app uses the OpenAI chat-completions format, so any OpenAI-compatible endpoint works. Set the URL to the full `.../v1/chat/completions` path.

```
POST <backend URL>
Authorization: Bearer <token>        (omitted if the token is empty)
Content-Type: application/json

{ "model": "<Model setting, omitted if empty>",
  "stream": false,
  "messages": [ ...previous turns, { "role": "user", "content": "what the user said" } ] }
```

The reply is read from `choices[0].message.content`. Plain-text responses, and JSON with a `reply`, `response`, `answer`, `text`, `content` or `output` field, also work. On a non-2xx status, the backend's `error.message` is shown on the glasses. The backend must allow CORS from the WebView origin.

## Run

```bash
npm install
cp .env.example .env.local   # optional dev defaults for the settings
npm run dev
npm run simulate             # desktop simulator
npx evenhub qr --url http://<your-ip>:5173   # real glasses
```

## Before packaging

Replace `https://your-backend.example.com` in the `network` whitelist in `app.json` with your backend's origin, then run `npm run pack`.

## Files

| File | Purpose |
|---|---|
| `src/main.ts` | Glasses UI, the listen → transcribe → ask → display state machine, gesture routing |
| `src/asr/stt.ts` | Soniox real-time WebSocket client (`stt-rt-v5`, PCM s16le 16 kHz mono) |
| `src/backend.ts` | AI backend request and response parsing |
| `src/settings.ts` | Settings saved with `bridge.setLocalStorage` |
| `src/ui.ts` | Phone companion UI: settings form, conversation log, hold-to-talk button |
