/**
 * Headless check that koffi's prebuilt binary loads under Electron's ABI and
 * that the two Win32 calls dictation rests on actually resolve. Run with:
 * npm run smoke:ffi
 *
 * GetAsyncKeyState is called for real (harmless read). SendInput is resolved
 * but NOT called — a smoke test must never type into the user's session.
 */
const { app } = require('electron')

app.whenReady().then(() => {
  console.log('electron', process.versions.electron, '| node ABI', process.versions.modules)
  try {
    const koffi = require('koffi')
    const user32 = koffi.load('user32.dll')

    const GetAsyncKeyState = user32.func('int16 __stdcall GetAsyncKeyState(int vKey)')
    const state = GetAsyncKeyState(0x11) // VK_CONTROL
    console.log('GetAsyncKeyState(VK_CONTROL) =', state)

    const KEYBDINPUT = koffi.struct('KEYBDINPUT_S', {
      wVk: 'uint16',
      wScan: 'uint16',
      dwFlags: 'uint32',
      time: 'uint32',
      dwExtraInfo: 'uint64'
    })
    const INPUT = koffi.struct('INPUT_S', {
      type: 'uint32',
      _pad0: 'uint32',
      ki: KEYBDINPUT,
      _pad1: 'uint64'
    })
    user32.func('uint __stdcall SendInput(uint cInputs, INPUT_S *pInputs, int cbSize)')

    const size = koffi.sizeof(INPUT)
    console.log('sizeof(INPUT) =', size, '(Windows x64 expects 40)')
    const ok = typeof state === 'number' && size === 40
    console.log(ok ? 'PASS: koffi + user32 work under Electron' : 'FAIL: unexpected results')
    app.exit(ok ? 0 : 1)
  } catch (err) {
    console.error('FAIL:', err)
    app.exit(1)
  }
})
