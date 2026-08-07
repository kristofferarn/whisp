# whisp

System-wide push-to-talk dictation for Windows. Hold **Ctrl+Win** anywhere,
speak, release — the transcript is pasted into whatever has focus. Never
submitted: pressing Enter stays your job.

Extracted from [SPCE](https://github.com/kristofferarn)'s "Whisper" feature
into a standalone tray app.

## How it works

- **Hotkey** — a 50ms `GetAsyncKeyState` poll via [koffi](https://koffi.dev)
  FFI (Electron's `globalShortcut` has no keyup, so a modifier-only hold is
  inexpressible there).
- **Capture** — a hidden renderer window records with
  `getUserMedia`/`MediaRecorder` (webm/opus) and gates out silent takes.
- **Transcription** — OpenAI `POST /v1/audio/transcriptions` with
  `gpt-4o-mini-transcribe` (~$0.003/min), biased by your Dictionary words.
- **Paste** — clipboard-carried: snapshot, `Ctrl+V` via `SendInput`, restore.
- **UI** — a floating pill while dictating; a tray icon always; a settings
  window (key, dictionary, history, stats) on demand.

## Development

```
npm install        # postinstall downloads the Electron binary
npm run dev        # run the app
npm run typecheck  # tsc --noEmit
npm run build      # typecheck + electron-vite build
npm run smoke:ffi  # verify koffi + user32 under Electron's ABI
npm run gen:icons  # derive tray icons + whisp.ico from resources/logo.png
```

The OpenAI API key is entered in Settings (opens automatically on first run)
and stored DPAPI-encrypted in `%APPDATA%/whisp`.

## Notes

- Two dictation hosts (e.g. whisp plus an SPCE build still running Whisper)
  both fire on the same press — mute one from its tray.
- Packaging (electron-builder) is not set up yet; when it is, koffi needs
  `asarUnpack: node_modules/koffi/**`.
