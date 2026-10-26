# whisp

Push-to-talk dictation for macOS. Hold **🌐 Fn** anywhere, speak, release.
The text is pasted into whatever has focus. It is never sent: pressing
Return stays your job.

**Double-tap 🌐** to go hands-free: whisp keeps listening with nothing held,
so you can look things up mid-sentence. Tap once more, with the field you
want focused, and the text lands there. **Esc** throws a take away.

> whisp started life as an Electron app for Windows (hold Ctrl+Win). That
> version lives on the [`windows`](../../tree/windows) branch; tag `v0.6.1` is
> its last release.

## How it works

- **Menu bar app** with no Dock icon. The menu bar popover shows the status,
  switches between engines, lists recent dictations and opens Settings.
- **Key**: a Quartz event tap watches 🌐 Fn (or Right ⌥, or ⌃⌥). Pressing any
  other key while it is held (Fn+←, Fn+Delete…) means you used Fn as a
  modifier, so that take is cancelled.
- **Pill**: a small island grows out of the notch while you talk, with live
  words on the on-device engine. On displays without a notch it is a glass
  capsule at the top of the screen.
- **Transcribe**, as you choose per step:
  - *On-device*: Apple's SpeechAnalyzer. English uses SpeechTranscriber,
    Norwegian uses DictationTranscriber. It's free, private, works offline
    and shows words while you speak.
  - *OpenAI*: `gpt-transcribe` or `gpt-4o-mini-transcribe`, with your
    Dictionary as keywords and your languages as hints.
- **Clean up** (optional): removes fillers, applies "scratch that", fixes
  punctuation. Runs on *Apple Intelligence* (on-device Foundation Models) or
  *OpenAI* (`gpt-5.4-nano`). Any failure pastes the raw transcript instead.
- **Paste**: the transcript goes on the clipboard (marked transient, so
  clipboard managers skip it), whisp sends ⌘V, and then puts your previous
  clipboard back. Takes paste in the order you spoke them, even when the
  network answers out of order.

## Building

Needs macOS 26 or later and Swift 6.2 or later. The Xcode Command Line Tools
are enough; Xcode is optional (open `Package.swift` in it if you like).

```
scripts/run.sh                      # build "whisp dev" and run it, logs in the terminal
scripts/build.sh release --install  # build whisp.app and copy it to /Applications
scripts/update.sh                   # pull, build, swap the installed whisp, reopen it
swift test                          # gesture, queue, settings and cleanup tests
```

The dev build is a separate app (`com.kristofferarn.whisp.dev`) with its own
settings, history and permissions, so it can run next to the installed one.
Mute one of them from its menu bar popover, or both will paste.

To test the engines without a microphone, run a sound file through the
current engines:

```
say -o /tmp/take.aiff "um so the meeting is on Tuesday, no wait, Wednesday"
"build/whisp dev.app/Contents/MacOS/Whisp" --transcribe /tmp/take.aiff
```

To check the UI without screen recording, debug builds can render every
Settings pane, the popover, the welcome window and the pill states to PNGs
(add `--dark` for dark mode):

```
"build/whisp dev.app/Contents/MacOS/Whisp" --snapshot /tmp/whisp-snapshots
```

### A stable signing certificate (do this once)

Started by `scripts/run.sh`, whisp is a child of your terminal, and macOS
applies the terminal app's Microphone and Accessibility permissions, so no
signing is needed for development. An installed whisp (opened from Finder,
Spotlight or at login) gets its own permissions, tied to its signature.
Signed ad-hoc, every update would have to be granted them again. To avoid
that:

1. Open **Keychain Access** (Spotlight finds it).
2. Choose **Keychain Access → Certificate Assistant → Create a Certificate…**
3. Name: `whisp Dev`. Identity Type: **Self-Signed Root**. Certificate Type:
   **Code Signing**. Click **Create**.

`scripts/build.sh` finds it by name (override with `WHISP_SIGN_IDENTITY`).

### First run

whisp's welcome window walks through these steps:

- **Microphone** permission.
- **Accessibility** permission, used both to see the key and to send ⌘V.
- **System Settings → Keyboard → "Press 🌐 key to" → Do Nothing**, so macOS's
  own dictation and emoji picker don't react to the same key.
- Downloading Apple's speech model for your language, if you use the
  on-device engine.
- An OpenAI API key, if you use OpenAI. It's stored in the Keychain.
