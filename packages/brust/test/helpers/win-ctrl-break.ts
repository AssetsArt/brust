// F492 W3 helper (Windows only; run by win-ctrl-break.test.ts). The runner's steps have no real console, so this process makes one
// (FreeConsole + AllocConsole), starts `brust start` in a NEW PROCESS GROUP on it (CreateProcessW: Bun.spawn has no creation flags),
// waits for /ping, then sends CTRL_BREAK_EVENT to that group with GenerateConsoleCtrlEvent: what Ctrl+Break in a console does. The server
// must drain and exit by itself. Prints one JSON line: { ready, exited, exitCode, ms, refused }.
// argv: <bun.exe> <brust bin> <port>
import { dlopen, FFIType, ptr } from 'bun:ffi'

const [bun, bin, portArg] = process.argv.slice(2) as [string, string, string]
const port = Number(portArg)
const k = dlopen('kernel32.dll', {
  FreeConsole: { args: [], returns: FFIType.i32 },
  AllocConsole: { args: [], returns: FFIType.i32 },
  CreateProcessW: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.i32, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  GenerateConsoleCtrlEvent: { args: [FFIType.u32, FFIType.u32], returns: FFIType.i32 },
  WaitForSingleObject: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.u32 },
  GetExitCodeProcess: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  TerminateProcess: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
  GetLastError: { args: [], returns: FFIType.u32 },
}).symbols

const out = (o: object) => console.log(JSON.stringify(o))
k.FreeConsole()
if (!k.AllocConsole()) {
  out({ error: `AllocConsole failed (${k.GetLastError()})` })
  process.exit(2)
}
const CREATE_NEW_PROCESS_GROUP = 0x200
const cmd = Buffer.from(`"${bun}" "${bin}" start --port ${port} --workers 1\0`, 'utf16le')
const si = new Uint8Array(104) // STARTUPINFOW (x64): only cb is set
new DataView(si.buffer).setUint32(0, 104, true)
const pi = new Uint8Array(24) // PROCESS_INFORMATION: hProcess, hThread, dwProcessId, dwThreadId
if (!k.CreateProcessW(null, ptr(cmd), null, null, 0, CREATE_NEW_PROCESS_GROUP, null, null, ptr(si), ptr(pi))) {
  out({ error: `CreateProcessW failed (${k.GetLastError()})` })
  process.exit(2)
}
const view = new DataView(pi.buffer)
const hProcess = view.getBigUint64(0, true)
const pid = view.getUint32(16, true)
const base = `http://localhost:${port}`
let ready = false
for (let i = 0; i < 600 && !ready; i++) {
  ready = await fetch(`${base}/ping`).then((r) => r.ok, () => false)
  if (!ready) await Bun.sleep(100)
}
if (!ready) {
  k.TerminateProcess(hProcess as never, 1)
  out({ ready, error: 'the server never answered /ping' })
  process.exit(2)
}
const t0 = Date.now()
const sent = k.GenerateConsoleCtrlEvent(1 /* CTRL_BREAK_EVENT */, pid)
const WAIT_OBJECT_0 = 0
const exited = k.WaitForSingleObject(hProcess as never, 15_000) === WAIT_OBJECT_0
const ms = Date.now() - t0
const code = new Uint32Array(1)
if (exited) k.GetExitCodeProcess(hProcess as never, ptr(code))
else k.TerminateProcess(hProcess as never, 1)
const refused = await fetch(`${base}/ping`).then(() => false, () => true)
out({ ready, sent: sent !== 0, exited, exitCode: exited ? code[0] : null, ms, refused })
process.exit(0)
