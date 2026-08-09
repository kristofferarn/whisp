# whisp

System-wide push-to-talk dictation for Windows. Hold **Ctrl+Win** anywhere,
speak, release — the transcript is pasted into whatever has focus. Never
submitted: pressing Enter stays your job.

Or **double-tap Ctrl+Win** to go hands-free: whisp keeps listening with
nothing held down, so you can look things up mid-sentence. Tap once more —
with the input you want focused — and the transcript lands there.

Extracted from [SPCE](https://github.com/kristofferarn)'s "Whisper" feature
into a standalone tray app.

## How it works

- **Hotkey** — a 50ms `GetAsyncKeyState` poll via [koffi](https://koffi.dev)
  FFI (Electron's `globalShortcut` has no keyup, so a modifier-only hold is
  inexpressible there). Presses shorter than 300ms keep the mic open for a
  400ms window in case a second tap arrives; two taps latch the take into a
  hands-free session, capped at 5 minutes.
- **Capture** — a hidden renderer window records with
  `getUserMedia`/`MediaRecorder` (webm/opus) and gates out silent takes.
- **Transcription** — OpenAI `POST /v1/audio/transcriptions` with
  `gpt-4o-mini-transcribe` or `gpt-transcribe` (a Settings knob), biased by
  your Dictionary words and hinted with your spoken languages.
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
and stored DPAPI-encrypted in `%APPDATA%/whisp` (`%APPDATA%/whisp-dev` for
dev runs — the two worlds share nothing, including the single-instance lock).

## Releasing

Bump `version` in package.json, commit, then:

```
git tag v<version> && git push --tags
```

The Release workflow builds the NSIS installer on windows-latest and
publishes it as a GitHub release (draft-first, so updaters never see a
half-uploaded release). Installed apps check for updates on launch and
every 6 hours; an update installs from the tray's "Restart to update"
item, or silently on next quit. `npm run package` builds the installer
locally into `release/` without publishing.

## Notes

- Two dictation hosts (e.g. whisp plus an SPCE build still running Whisper,
  or whisp-dev next to installed whisp) both fire on the same press — mute
  one from its tray.
