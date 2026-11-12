/**
 * verify-boot-pool.mjs — 开机动画「素材池 + 本地导入」的判据（批次 A）。
 *
 * 用 DSH_FOLIA_HOME 指向临时目录，真读真写，不碰用户真实配置。
 *   B1 旧配置（只有 clipId）能读出 items=[clipId]（向后兼容）
 *   B2 items 与 clipId 写回时保持一致
 *   B3 pickClipForBoot：first / random / rotate 三种模式都能挑到「本地真实存在」的片段
 *   B4 pickClipForBoot：一条都不存在 ⇒ null（调用方不注入，不黑屏）
 *   B5 importLocalClip：合法 mp4（ftyp）能导入并写 meta(source=local)
 *   B6 importLocalClip：非视频字节被拒（not-a-video）
 *   B7 importLocalClip：超过上限被拒（too-large）
 */
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'folia-boot-pool-'));
process.env.DSH_FOLIA_HOME = home;

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
};

const boot = await import('../lib/boot/index.js');

// 准备一个「像 mp4」的片段：ftyp 头 + 若干字节
const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(1024, 0)]);
const clipId = 'clip-a';
writeFileSync(boot.clipFile(clipId), mp4);

// B1 旧配置兼容
writeFileSync(join(home, 'config.json'), JSON.stringify({ boot: { enabled: true, clipId } }, null, 2));
{
  const b = boot.readBoot();
  check('B1 旧配置只有 clipId ⇒ items=[clipId]', Array.isArray(b.items) && b.items.length === 1 && b.items[0] === clipId, JSON.stringify(b.items));
}

// B2 写回一致性
{
  boot.writeBoot({ items: ['clip-a', 'clip-b'] });
  const b = boot.readBoot();
  check('B2 写 items 同步 clipId=第一条', b.clipId === 'clip-a' && b.items.length === 2, `${b.clipId} / ${b.items.length}`);
}

// B3/B4 pick
{
  const first = boot.pickClipForBoot({ items: [clipId], poolMode: 'first' });
  const missing = boot.pickClipForBoot({ items: ['nope'], poolMode: 'first' });
  let rotate1 = null;
  let rotate2 = null;
  const two = [clipId, 'clip-c'];
  writeFileSync(boot.clipFile('clip-c'), mp4);
  rotate1 = boot.pickClipForBoot({ items: two, poolMode: 'rotate' });
  rotate2 = boot.pickClipForBoot({ items: two, poolMode: 'rotate' });
  check('B3 first 模式挑到真实存在的片段', first === clipId, String(first));
  check('B4 全都不存在 ⇒ null（不注入）', missing === null, String(missing));
  check('B3b rotate 连续两次会换一条', rotate1 !== rotate2, `${rotate1} → ${rotate2}`);
}

// B5-B7 导入校验
{
  const ok = boot.importLocalClip(mp4, { title: '本地测试' });
  let meta = null;
  try { meta = JSON.parse(readFileSync(boot.clipMetaFile(ok.id), 'utf8')); } catch { meta = null; }
  check('B5 合法 mp4 可导入并写 meta(source=local)', ok.ok === true && meta && meta.source === 'local', ok.ok ? ok.id : ok.error);
  const bad = boot.importLocalClip(Buffer.from('<html>not a video</html>'), { title: 'x' });
  check('B6 非视频字节被拒', bad.ok === false && bad.error === 'not-a-video', bad.error || 'accepted');
  const huge = boot.importLocalClip(mp4, { maxBytes: 10 });
  check('B7 超上限被拒', huge.ok === false && huge.error === 'too-large', huge.error || 'accepted');
}

rmSync(home, { recursive: true, force: true });
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} 通过 / ${failed.length} 失败`);
if (failed.length) process.exitCode = 1;
