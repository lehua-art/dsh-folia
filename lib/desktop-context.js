/**
 * desktop-context.js — 屏幕感知（v1.2 Level 1 前台窗口 / Level 2 屏幕 OCR）。
 *
 * **默认全关**：没有任何轮询在这里开始；只有路由在设置 `screen.mode !== 'off'` 时才调用。
 * 两条通道都走 Windows PowerShell（不新增原生依赖）：
 *
 *   Level 1  $foreground  → user32 GetForegroundWindow / GetWindowText / 进程名
 *            只取「应用名 + 标题摘要」，30–60 秒一次；不读窗口内容。
 *
 *   Level 2  $ocr         → System.Drawing 截屏到**内存** + Windows.Media.Ocr 识别，
 *            OCR 文本只在本地；截图不落盘、不上传、不进日志；密码管理器/银行等按进程名跳过；
 *            锁屏/LogonUI 直接停。
 *
 * 诚实边界：只能读「前台窗口标题 + 屏幕像素」。读不到别的 App 的内部数据；OCR 对复杂界面/
 * 小字/游戏画面会不准。失败一律回 `{ok:false, reason}`，不假装看到了。
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** 默认跳过的进程名（小写比较）：密码管理器 / 银行 / 远程桌面 / 锁屏。 */
export const SENSITIVE_APPS = Object.freeze([
  '1password', '1password7', 'bitwarden', 'keepass', 'keepassxc', 'lastpass', 'dashlane',
  'enpass', 'roboform', 'nordpass', 'mstsc', 'logonui', 'lockapp', 'credentialuibroker',
  'bank', 'banking', 'alipay', 'wechatpay', 'wallet',
]);

/** 标题里出现这些词也跳过（进程名拿不到时的第二道闸）。 */
export const SENSITIVE_TITLE_WORDS = Object.freeze([
  '密码', '银行', '支付', '登录', 'password', 'bank', 'sign in', 'login', 'wallet',
]);

/** 前台窗口脚本：只输出 JSON；任何异常都以 ok:false 收尾，不把堆栈写进日志。 */
const FOREGROUND_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class FoliaForeground {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int max);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
}
"@
try {
  $h = [FoliaForeground]::GetForegroundWindow()
  if ($h -eq [IntPtr]::Zero) { '{"ok":false,"reason":"no-foreground"}' | Write-Output; exit 0 }
  $len = [FoliaForeground]::GetWindowTextLength($h)
  $sb = New-Object System.Text.StringBuilder ($len + 2)
  [void][FoliaForeground]::GetWindowText($h, $sb, $sb.Capacity)
  $pidOut = 0
  [void][FoliaForeground]::GetWindowThreadProcessId($h, [ref]$pidOut)
  $app = ''
  try { $app = (Get-Process -Id $pidOut -ErrorAction Stop).ProcessName } catch { $app = '' }
  $payload = @{ ok = $true; pid = [int]$pidOut; app = [string]$app; title = [string]$sb.ToString() }
  $payload | ConvertTo-Json -Compress
} catch {
  '{"ok":false,"reason":"foreground-failed"}' | Write-Output
}
`;

/** 截屏 + OCR：全程内存（InMemoryRandomAccessStream），不写临时文件。 */
const OCR_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Storage.Streams.InMemoryRandomAccessStream, Windows.Storage, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime]
function Await($op, $type) {
  $task = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation` + "`" + `1'
  } | Select-Object -First 1
  $task = $task.MakeGenericMethod($type)
  $t = $task.Invoke($null, @($op))
  $t.Wait(-1) | Out-Null
  return $t.Result
}
try {
  $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
  if (-not $engine) { '{"ok":false,"reason":"no-ocr-engine"}' | Write-Output; exit 0 }
  $bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
  if ($bounds.Width -lt 8 -or $bounds.Height -lt 8) { '{"ok":false,"reason":"no-screen"}' | Write-Output; exit 0 }
  $bmp = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($bounds.Left, $bounds.Top, 0, 0, $bmp.Size)
  $ms = New-Object System.IO.MemoryStream
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $bytes = $ms.ToArray()
  $g.Dispose(); $bmp.Dispose(); $ms.Dispose()
  $stream = New-Object Windows.Storage.Streams.InMemoryRandomAccessStream
  $writer = New-Object Windows.Storage.Streams.DataWriter($stream)
  $writer.WriteBytes($bytes)
  [void](Await ($writer.StoreAsync()) 'UInt32')
  $writer.DetachStream() | Out-Null
  $stream.Seek(0) | Out-Null
  $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) 'Windows.Graphics.Imaging.BitmapDecoder'
  $software = Await ($decoder.GetSoftwareBitmapAsync()) 'Windows.Graphics.Imaging.SoftwareBitmap'
  $result = Await ($engine.RecognizeAsync($software)) 'Windows.Media.Ocr.OcrResult'
  $lines = @()
  foreach ($line in $result.Lines) { $lines += [string]$line.Text }
  $payload = @{ ok = $true; lines = $lines }
  $payload | ConvertTo-Json -Compress -Depth 4
} catch {
  '{"ok":false,"reason":"ocr-failed"}' | Write-Output
}
`;

/** 找 Windows PowerShell（pwsh 7 加载 WinRT 不稳，固定用 5.1）。 */
export function resolvePowerShell() {
  const fixed = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  if (existsSync(fixed)) return fixed;
  return 'powershell.exe';
}

/**
 * 跑一段 PowerShell，拿最后一行 JSON。永不抛（失败回 `{ok:false}`）。
 * @param {string} script
 * @param {{timeoutMs?:number, run?:Function}} [options]
 */
export function runPowerShellJson(script, options = {}) {
  const timeoutMs = Math.max(2000, Math.min(30000, Number(options.timeoutMs) || 12000));
  if (typeof options.run === 'function') {
    // 判据注入：`run(script, timeoutMs) => {stdout, stderr, code}`（同步）
    try {
      const result = options.run(script, timeoutMs) || {};
      return parseJsonLine(String(result.stdout || ''));
    } catch (error) {
      return { ok: false, reason: 'runner-error', error: String((error && error.message) || error).slice(0, 120) };
    }
  }
  return new Promise((resolveP) => {
    let child;
    try {
      child = spawn(resolvePowerShell(), [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script,
      ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      resolveP({ ok: false, reason: 'spawn-failed', error: String((error && error.message) || error).slice(0, 120) });
      return;
    }
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      // pid 落地才 kill（未起来时裸 kill 会抛错/挂住事件循环；与 verify-child-kill 同一条纪律）
      try { if (child.pid !== undefined) child.kill(); } catch { /* ignore */ }
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { err = (err + chunk).slice(-500); });
    child.on('error', () => {
      clearTimeout(timer);
      resolveP({ ok: false, reason: 'spawn-failed' });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const parsed = parseJsonLine(out);
      if (parsed && parsed.ok !== undefined) { resolveP(parsed); return; }
      resolveP({ ok: false, reason: code === 0 ? 'bad-output' : 'ps-exit-' + code });
    });
  });
}

function parseJsonLine(text) {
  const lines = String(text || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!lines[i].startsWith('{')) continue;
    try { return JSON.parse(lines[i]); } catch { /* 继续往上找 */ }
  }
  return null;
}

/** 是否敏感应用（进程名或标题命中）。 */
export function isSensitiveApp(app, title = '') {
  const name = String(app || '').toLowerCase().trim();
  if (name && SENSITIVE_APPS.some((item) => name === item || name.includes(item))) return true;
  const text = String(title || '').toLowerCase();
  return SENSITIVE_TITLE_WORDS.some((word) => text.includes(word.toLowerCase()));
}

/** 锁屏 / 登录界面（这时必须停止采样，也不该截屏）。 */
export function isLockScreen(app, title = '') {
  const name = String(app || '').toLowerCase();
  const text = String(title || '').toLowerCase();
  return ['lockapp', 'logonui', 'winlogon'].includes(name) || /锁屏|lock screen|sign-in|登录/.test(text);
}

/**
 * Level 1：读前台应用 + 标题摘要。
 * @param {{run?:Function}} [options]
 * @returns {Promise<{ok:boolean, app?:string, title?:string, pid?:number, sensitive?:boolean, locked?:boolean, reason?:string}>}
 */
export async function readForegroundWindow(options = {}) {
  const raw = await runPowerShellJson(FOREGROUND_SCRIPT, { timeoutMs: 6000, run: options.run });
  if (!raw || raw.ok !== true) return { ok: false, reason: (raw && raw.reason) || 'foreground-failed' };
  const app = String(raw.app || '').slice(0, 60);
  const title = String(raw.title || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  return {
    ok: true,
    app,
    title,
    pid: Number(raw.pid) || 0,
    sensitive: isSensitiveApp(app, title),
    locked: isLockScreen(app, title),
  };
}

/**
 * Level 2：截屏 + OCR（内存直读，不落盘）。
 * @param {{run?:Function, maxChars?:number}} [options]
 * @returns {Promise<{ok:boolean, text?:string, lines?:string[], chars?:number, reason?:string}>}
 */
export async function captureScreenOcr(options = {}) {
  const raw = await runPowerShellJson(OCR_SCRIPT, { timeoutMs: 20000, run: options.run });
  if (!raw || raw.ok !== true) return { ok: false, reason: (raw && raw.reason) || 'ocr-failed' };
  const lines = Array.isArray(raw.lines)
    ? raw.lines.map((line) => String(line || '').replace(/\s+/g, ' ').trim()).filter(Boolean)
    : [];
  const maxChars = Math.max(40, Math.min(2000, Number(options.maxChars) || 600));
  const text = lines.join('\n').slice(0, maxChars);
  if (!text.trim()) return { ok: false, reason: 'ocr-empty' };
  return { ok: true, text, lines, chars: [...text].length };
}

/** 观察记录文本：应用名 + 标题摘要（去掉窗口标题里的私密细节？不——只截断）。 */
export function foregroundObservation(fg) {
  if (!fg || fg.ok !== true) return '';
  const app = String(fg.app || '').trim();
  if (!app) return '';
  const title = String(fg.title || '').trim();
  const text = title ? `前台应用：${app} · ${title.slice(0, 40)}` : `前台应用：${app}`;
  return text.slice(0, 120);
}

/** OCR 观察文本：一行摘要，不存整屏原文。 */
export function ocrObservation(ocr) {
  if (!ocr || ocr.ok !== true) return '';
  const first = String(ocr.text || '').split('\n').map((line) => line.trim()).filter(Boolean).slice(0, 2).join(' / ');
  if (!first) return '';
  return ('屏幕文字摘要：' + first).slice(0, 160);
}

/** 采样节奏：Level 1 30–60 秒，Level 2 2–5 分钟（任务书 §7）。 */
export const OBSERVE_RULES = Object.freeze({
  foregroundMs: 45000,
  ocrMs: 3 * 60 * 1000,
  /** 同一应用+标题在这段时间内不重复写观察记录（避免刷屏）。 */
  dedupeMs: 10 * 60 * 1000,
});
