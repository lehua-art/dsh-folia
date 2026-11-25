/**
 * lib/tts/singing.js — **按谱清唱**（v5 §1）的纯函数层：曲调库 / 歌词 / 音符 / 时间轴 / SSML。
 *
 * 为什么单独一层：旋律、歌词、时间轴都是**可判据的纯数据**，而"发一次 Edge 请求"
 * 在 worker 里。这里不读盘、不发请求，所有函数都能在 Node 里直接断言：
 *
 *   TUNE_LIBRARY            内置曲调（只收公共领域 / 原创，逐条注明来源与许可）
 *   planSing(input)         → { tuneId, title, lines, notes, expectedMs, disclaimer, source }
 *   buildSingSsml(notes)    → 一次请求内的多段 <prosody pitch> + <break>
 *   generateLyrics(input)   → 8 行押韵歌词（按曲调的每句字数生成）
 *   generateOriginalMelody()→ 原创旋律（大调/小调/五声 + 节奏型 + 音高轮廓）
 *
 * 诚实边界（写进 disclaimer，路由原样回给用户）：
 *   · 这是"合成音清唱"，不是真人歌声；**没有伴奏**；
 *   · 不内置受版权保护的流行歌旋律，只有公共领域曲调 + 原创旋律。
 */

/** 一个"拍"的毫秒数（八分音符 ≈ 94 BPM）。谱面时长 = units × UNIT_MS。 */
export const UNIT_MS = 320;

/** 每字演唱的预估时长（用于把 break 补到谱面时长；实测后固定）。 */
export const VOCAL_ESTIMATE_MS = 320;

/** 清唱的目标基频：midi 60 = 196Hz（G3）。整首下移 5 个半音再按乐句加八度，音域约 1.6 个八度。 */
export const BASE_FREQ_HZ = 196;
export const TUNE_BASE_SHIFT = -5;
/** 宽音域编曲：每句移调（半音）。清唱只有一个人声，用八度对比把旋律"唱开"。 */
export const ARRANGE_SHIFTS = Object.freeze([0, 12, 7, 5, 0, 12, 7, 5]);

/** midi → 目标基频 Hz。 */
export function freqOfMidi(midi) {
  return BASE_FREQ_HZ * Math.pow(2, ((Number(midi) || 60) + TUNE_BASE_SHIFT - 60) / 12);
}

/** 曲调库：`phrases` 是每句的音符（midi + units），`lineChars` 是每句字数。 */
export const TUNE_LIBRARY = Object.freeze([
  {
    id: 'twinkle',
    title: '小星星',
    source: '法国民谣《Ah! vous dirai-je, maman》（1761），公共领域',
    license: 'public-domain',
    mood: 'calm',
    phrases: [
      [[60, 2], [60, 2], [67, 2], [67, 2], [69, 2], [69, 2], [67, 4]],
      [[65, 2], [65, 2], [64, 2], [64, 2], [62, 2], [62, 2], [60, 4]],
    ],
  },
  {
    id: 'two-tigers',
    title: '两只老虎',
    source: '法国民谣《Frère Jacques》，公共领域',
    license: 'public-domain',
    mood: 'happy',
    phrases: [
      [[60, 2], [62, 2], [64, 2], [60, 2], [60, 2], [62, 2], [64, 2]],
      [[64, 2], [65, 2], [67, 4], [64, 2], [65, 2], [67, 4]],
    ],
  },
  {
    id: 'birthday',
    title: '生日快乐',
    source: 'Patty/Mildred Hill《Happy Birthday to You》（旋律已进入公共领域，2016 年美国法院判决）',
    license: 'public-domain',
    mood: 'happy',
    phrases: [
      [[67, 1], [67, 1], [69, 2], [67, 2], [72, 2], [71, 4]],
      [[67, 1], [67, 1], [69, 2], [67, 2], [74, 2], [72, 4]],
    ],
  },
  {
    id: 'jingle-bells',
    title: '铃儿响叮当',
    source: 'James Lord Pierpont《Jingle Bells》（1857），公共领域',
    license: 'public-domain',
    mood: 'happy',
    phrases: [
      [[64, 2], [64, 2], [64, 4], [64, 2], [64, 2], [64, 4]],
      [[64, 2], [67, 2], [60, 2], [62, 2], [64, 6]],
    ],
  },
  {
    id: 'ode-to-joy',
    title: '欢乐颂',
    source: '贝多芬第九交响曲主题（1824），公共领域',
    license: 'public-domain',
    mood: 'happy',
    phrases: [
      [[64, 2], [64, 2], [65, 2], [67, 2], [67, 2], [65, 2], [64, 2]],
      [[62, 2], [62, 2], [64, 2], [64, 4], [62, 4]],
    ],
  },
  {
    id: 'jasmine',
    title: '茉莉花',
    source: '中国民歌《茉莉花》（清代《小慧集》工尺谱，传统民歌，公共领域）',
    license: 'public-domain',
    mood: 'calm',
    phrases: [
      [[64, 2], [64, 2], [65, 2], [67, 4], [64, 2], [67, 2]],
      [[69, 2], [67, 2], [65, 2], [64, 2], [62, 2], [60, 4]],
    ],
  },
]);

/** 原创旋律的调式（全部只用自然音级；五声去掉半音关系）。 */
const ORIGINAL_SCALES = Object.freeze({
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  pentatonic: [0, 2, 4, 7, 9],
});

/** 稳定的字符串种子（同一主题每次生成同一首，不随会话漂移）。 */
function seedOf(text) {
  const raw = String(text == null ? '' : text);
  let hash = 2166136261;
  for (let i = 0; i < raw.length; i += 1) {
    hash ^= raw.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) || 1;
}

/** 线性同余（判据可复现）。 */
function makeRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function clipChars(value, max) {
  const chars = [...String(value == null ? '' : value)];
  return chars.length > max ? chars.slice(0, max).join('') : chars.join('');
}

function escapeXml(text) {
  return String(text == null ? '' : text).replace(/[<>&"']/g, (char) => ({
    '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;',
  }[char]));
}

/** midi → SSML 音高：半音（st）。Edge 实测接受 `+Nst`；不接受时由 buildSingSsml 切 Hz。 */
export function midiToSemitone(midi) {
  const delta = Math.max(-24, Math.min(24, Math.round(Number(midi) || 60) - 60));
  return `${delta >= 0 ? '+' : ''}${delta}st`;
}

/** 备用：midi → 相对基频的 Hz 偏移（基频 200Hz，+2st ≈ +24Hz）。 */
export function midiToHz(midi, baseHz = 200) {
  const semitones = Math.round(Number(midi) || 60) - 60;
  const hz = Math.round(baseHz * (Math.pow(2, semitones / 12) - 1));
  return `${hz >= 0 ? '+' : ''}${hz}Hz`;
}

/* ── 歌词 ──────────────────────────────────────────────────────────────── */

const LYRIC_BANK = Object.freeze({
  happy: [
    ['今天风很轻', '阳光落在窗', '把心事放一放', '笑着走一趟'],
    ['小小的欢喜', '藏在日常里', '和你一起唱', '烦恼都忘记'],
  ],
  calm: [
    ['夜色慢慢落', '灯下轻轻哼', '把日子过慢', '心里有微光'],
    ['风从窗边过', '云在天上走', '安静陪着你', '直到梦开头'],
  ],
  sad: [
    ['如果有点累', '就先歇一歇', '我陪你坐会', '等天亮一些'],
    ['雨会慢慢停', '路会慢慢明', '你不是一人', '我在这边听'],
  ],
  miss: [
    ['月亮升起来', '想你在心间', '隔着一段路', '也觉得很近'],
    ['把思念折好', '放进晚风里', '等你回头时', '我还在原地'],
  ],
});

const RHYME_POOL = Object.freeze({
  happy: ['窗', '唱', '光', '趟', '方', '亮'],
  calm: ['光', '上', '旁', '长', '凉', '藏'],
  sad: ['歇', '些', '听', '明', '肩', '停'],
  miss: ['间', '近', '里', '地', '你', '起'],
});

/**
 * 生成 8 行歌词（贴合主题/情绪；每行字数 = 曲调每句字数）。
 * 做法：主题词嵌进第 1/5 行，其余行用情绪模板 + 韵脚替换；可复现。
 */
export function generateLyrics(input = {}) {
  const topic = clipChars(input.topic || '今天', 6);
  const mood = ['happy', 'calm', 'sad', 'miss'].includes(String(input.mood)) ? String(input.mood) : 'calm';
  const lineChars = Array.isArray(input.lineChars) && input.lineChars.length
    ? input.lineChars.map((n) => Math.max(4, Math.min(9, Math.round(Number(n) || 7))))
    : [7, 7];
  const rand = makeRandom(seedOf(topic + mood + lineChars.join('-')));
  const bank = LYRIC_BANK[mood];
  const rhymes = RHYME_POOL[mood];
  const lines = [];
  for (let i = 0; i < 8; i += 1) {
    const base = bank[Math.floor(rand() * bank.length)][i % 4];
    const targetLen = lineChars[i % lineChars.length];
    let line = base;
    if (i === 0 || i === 4) line = `${topic}${base}`;
    // 韵脚：偶数行末字换成同一韵，保证"像歌词"。
    if (i % 2 === 1 && targetLen >= 4) {
      line = line.slice(0, Math.max(0, targetLen - 1)) + rhymes[Math.floor(rand() * rhymes.length)];
    }
    const chars = [...line].filter((c) => !/[，。！？、,.!?]/.test(c));
    while (chars.length < targetLen) chars.push(...[...base].filter((c) => !/[，。！？、,.!?]/.test(c)));
    lines.push(chars.slice(0, targetLen).join(''));
  }
  return lines;
}

/* ── 旋律 ──────────────────────────────────────────────────────────────── */

/**
 * 原创旋律：选调式 + 节奏型 + 音高轮廓，按每句字数生成音符。
 * 返回 phrases（与内置曲调同形），便于统一走 buildNotes。
 */
export function generateOriginalMelody(input = {}) {
  const topic = clipChars(input.topic || '原创', 8);
  const style = ['major', 'minor', 'pentatonic'].includes(String(input.style)) ? String(input.style) : 'major';
  const lineChars = Array.isArray(input.lineChars) && input.lineChars.length
    ? input.lineChars.map((n) => Math.max(4, Math.min(9, Math.round(Number(n) || 7))))
    : [7, 7];
  const rand = makeRandom(seedOf(topic + style));
  const scale = ORIGINAL_SCALES[style];
  const phrases = [];
  for (let p = 0; p < 2; p += 1) {
    const notes = [];
    const count = lineChars[p % lineChars.length];
    let degree = p === 0 ? 0 : 4;
    for (let i = 0; i < count; i += 1) {
      const step = Math.round((rand() - 0.5) * 4);
      degree = Math.max(0, Math.min(scale.length * 2 - 1, degree + step));
      const octave = Math.floor(degree / scale.length);
      const midi = 60 + scale[degree % scale.length] + octave * 12;
      const units = i === count - 1 ? 4 : (rand() < 0.25 ? 4 : 2);
      notes.push([midi, units]);
    }
    // 终止感：第一句落在属音/主音，第二句落回主音。
    const last = notes[notes.length - 1];
    last[0] = p === 0 ? 67 : 60;
    phrases.push(notes);
  }
  return {
    id: 'original-' + style,
    title: '原创旋律（' + (style === 'major' ? '大调' : style === 'minor' ? '小调' : '五声') + '）',
    source: '本插件原创旋律生成器（公共领域式无版权素材，无第三方旋律）',
    license: 'original',
    mood: 'original',
    phrases,
  };
}

/** 选曲调：显式 tune → 同情绪内置 → 原创兜底；每句字数取曲调自身的。 */
export function pickTune(input = {}) {
  const asked = String(input.tune || '').trim();
  if (asked) {
    const hit = TUNE_LIBRARY.find((tune) => tune.id === asked || tune.title === asked);
    if (hit) return hit;
    if (asked === 'original' || asked.startsWith('original')) {
      return generateOriginalMelody({ ...input, style: String(input.style || 'major') });
    }
  }
  const mood = ['happy', 'calm', 'sad', 'miss'].includes(String(input.mood)) ? String(input.mood) : '';
  const candidates = TUNE_LIBRARY.filter((tune) => !mood || tune.mood === mood || (mood === 'miss' && tune.mood === 'calm'));
  const pool = candidates.length ? candidates : TUNE_LIBRARY;
  const rand = makeRandom(seedOf(String(input.topic || '') + mood));
  return pool[Math.floor(rand() * pool.length)];
}

/**
 * 把 8 行歌词铺到旋律上：
 *   · 每个曲调 phrase 配一行；8 行 = 4 轮 phrase（A A B B A A B B）；
 *   · 一行字数与 phrase 音符数不一致时：先裁/补字（不新增音节），再一句一音。
 * 返回 notes = [{ midi, units, durMs, startMs, lyric, line, charIndex }]。
 */
export function buildNotes(tune, lines, options = {}) {
  const phrases = Array.isArray(tune && tune.phrases) ? tune.phrases : [];
  if (!phrases.length || !lines.length) return [];
  const arrange = options.spread !== false && tune.phrases.length > 1;
  const notes = [];
  let cursor = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const phrase = phrases[i % phrases.length];
    const shift = arrange ? ARRANGE_SHIFTS[i % ARRANGE_SHIFTS.length] : 0;
    const chars = [...lines[i]].filter((c) => !/[，。！？、,.!?]/.test(c));
    for (let j = 0; j < phrase.length; j += 1) {
      const [midi, units] = phrase[j];
      const lyric = chars[j] || chars[chars.length - 1] || '啦';
      const durMs = Math.max(120, units * UNIT_MS);
      notes.push({
        midi: midi + shift, units, durMs, startMs: cursor, lyric, line: i, charIndex: j,
        freqHz: Math.round(freqOfMidi(midi + shift) * 10) / 10,
      });
      cursor += durMs;
    }
  }
  return notes;
}

/** 谱面总时长（含每音符的尾静音；与实际音频对比做 S3 误差判据）。 */
export function timelineOf(notes) {
  const list = Array.isArray(notes) ? notes : [];
  if (!list.length) return { totalMs: 0, lines: [] };
  const totalMs = list[list.length - 1].startMs + list[list.length - 1].durMs;
  const lines = [];
  for (const note of list) {
    const row = lines[note.line] || (lines[note.line] = { text: '', startMs: note.startMs, durMs: 0 });
    row.text += note.lyric;
    row.durMs = note.startMs + note.durMs - row.startMs;
  }
  return { totalMs, lines };
}

/** 每音符后的 break：谱面时长 − 预估演唱时长（不小于 20ms）。 */
export function breakMsOf(note) {
  return Math.max(20, Math.round(Number(note && note.durMs) || 0) - VOCAL_ESTIMATE_MS);
}

/**
 * 一次请求内的多段 prosody + break。
 * @param {Array} notes buildNotes 的结果
 * @param {{voice?:string, pitchMode?:'st'|'hz', ratePct?:string}} [options]
 */
export function buildSingSsml(notes, options = {}) {
  const list = Array.isArray(notes) ? notes : [];
  const voice = String(options.voice || 'zh-CN-XiaoxiaoNeural');
  const pitchMode = options.pitchMode === 'hz' ? 'hz' : 'st';
  const ratePct = String(options.ratePct || '-8%');
  const body = list.map((note) => {
    const pitch = pitchMode === 'hz' ? midiToHz(note.midi) : midiToSemitone(note.midi);
    return '<prosody pitch="' + pitch + '" rate="' + ratePct + '">'
      + escapeXml(note.lyric) + '</prosody><break time="' + breakMsOf(note) + 'ms"/>';
  }).join('');
  return '<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="zh-CN">'
    + '<voice name="' + escapeXml(voice) + '">' + body + '</voice></speak>';
}

/**
 * 一次完整编曲（纯函数）：歌词 → 曲调 → 音符 → 时间轴 + 免责声明。
 *
 * @returns {{
 *   ok: boolean, tuneId: string, title: string, source: string, license: string,
 *   lines: Array<{text:string,startMs:number,durMs:number}>, notes: Array,
 *   expectedMs: number, disclaimer: string, ssml: string, distinctPitches: number,
 * }}
 */
export function planSing(input = {}) {
  const tune = pickTune(input);
  const lineChars = tune.phrases.map((phrase) => phrase.length);
  const lines = Array.isArray(input.lyrics) && input.lyrics.length
    ? input.lyrics.map((line) => clipChars(line, 24)).slice(0, 16)
    : generateLyrics({
      topic: input.topic || '今天',
      mood: input.mood || (tune.mood === 'happy' ? 'happy' : 'calm'),
      lineChars,
    });
  // 至少 8 行（任务要求 8–16 行）：不够就重复一轮（歌词重复在清唱里很常见）。
  while (lines.length < 8) lines.push(...lines.slice(0, 8 - lines.length));
  const notes = buildNotes(tune, lines, { spread: input.spread });
  const time = timelineOf(notes);
  const distinctPitches = new Set(notes.map((note) => note.midi)).size;
  return {
    ok: notes.length >= 8 && distinctPitches >= 4,
    tuneId: tune.id,
    title: tune.title,
    source: tune.source,
    license: tune.license,
    lines: time.lines,
    notes,
    expectedMs: time.totalMs,
    distinctPitches,
    ssml: buildSingSsml(notes, { voice: input.voice, ratePct: input.ratePct }),
    disclaimer: '这是合成音清唱：有旋律和节拍，但没有伴奏，也不是真人歌声。'
      + '曲调只使用公共领域作品或本插件原创旋律；需要带伴奏/原唱请用音乐 App。',
  };
}

/** 曲调来源清单（S6：代码里能列出曲调来源）。 */
export function tuneSources() {
  return TUNE_LIBRARY.map((tune) => ({
    id: tune.id, title: tune.title, source: tune.source, license: tune.license,
  }));
}
