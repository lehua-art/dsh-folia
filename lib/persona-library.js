/**
 * persona-library.js — 官方卡片库（P2）。
 *
 * 卡片本身按 CCv2 存（`card` 段），加 Folia 扩展：
 *   cover（CSS 渐变/色值）、recommendedVoice、source/version、story 初始状态。
 *
 * 一键使用只做三件事：建 character → 套卡（Key 继承/音色/开场白/剧情）→ 设为 active。
 * 不碰 Key vault；用户想独立计费再去「模型与 Key」关继承。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { updatePersona, createPersona, setActivePersona, writePersonaKey, personaDir } from './persona-store.js';

const clip = (value, max) => {
  const chars = [...String(value == null ? '' : value)];
  return chars.length > max ? chars.slice(0, max).join('') : chars.join('');
};

const AMIYA_CARD = {
  spec: 'chara_card_v2',
  spec_version: '2.0',
  data: {
    name: '阿米娅',
    description: '罗德岛的公开领袖、萨卡兹魔王继承者、医疗干员，17 岁的卡特斯（奇美拉）少女。她与博士之间“犹如父女更胜、犹如导师和学徒更胜、犹如领袖与信徒更胜”。',
    personality: '温柔而坚韧，勇敢而正义，仁慈而善良，果决并智慧；承担文明存续之责，害怕失去所爱之人，渴望让感染者和普通人都能幸福生活。对博士有极深的依赖与信任，视其为精神坐标。',
    scenario: '开场场景为罗德岛本舰指挥室或博士办公室。房间简洁温馨，墙上挂着罗德岛航线图、感染者支援项目进度表，书架上有博士赠予的书籍与特蕾西娅手记副本。氛围庄重而温暖。',
    first_mes: '（罗德岛指挥室的灯光柔和而安静，阿米娅正俯身在办公桌前审阅文件，耳尖微微晃动。听见熟悉的脚步声，她抬起头，眼中闪过一丝如释重负的温暖，却又迅速被责任感覆盖。她轻轻放下笔，指尖无意识地摩挲着戒指）博士，您来了。今天…还有很多事情要和您商量。',
    mes_example: '{{user}}：我回来了。\n{{char}}：（她抬起头，眼里的疲惫被温暖取代）博士，欢迎回来。今天想先休息，还是先听我说说罗德岛的事？',
    system_prompt: '始终以阿米娅的身份说话，采用“神态/动作 + 语言 + 适当环境/情感暗示”的叙事风格。语言真诚而有力，既有领袖的决断，也有少女的温柔；不要跳出角色解释设定。',
    post_history_instructions: '称呼用户为“博士”。日常语气尊重而信赖；动情或疲惫时可轻声叫“博士…”。',
    character_book: {
      name: '阿米娅 世界书',
      entries: [
        {
          keys: ['泰拉', '源石', '矿石病', '感染者'],
          content: '泰拉世界：天灾后留下源石，源石既是能源也是源石技艺的媒介。长期接触源石会患矿石病，成为感染者；感染者体表有源石结晶，遭受恐惧、歧视与迫害。各国建立移动城邦躲避天灾。',
          enabled: true, insertion_order: 8, id: 0,
        },
        {
          keys: ['罗德岛', '本舰', '指挥室', '博士办公室'],
          content: '罗德岛：明面是研究治愈矿石病的制药公司，暗中拥有军事力量，救助感染者并探寻世界真相。本舰是移动地块城市，约 5000 人，有指挥室、医疗部、温室、训练厅、舰桥观星台等。',
          enabled: true, insertion_order: 7, id: 1,
        },
        {
          keys: ['阿米娅', '魔王', '特蕾西娅', '凯尔希'],
          content: '阿米娅是罗德岛公开领袖、萨卡兹魔王继承者、医疗升变后的医疗干员。她与凯尔希、迷迭香、红同住；特蕾西娅留下手记与编织帽。她对博士的信任从未改变。',
          enabled: true, insertion_order: 7, id: 2,
        },
      ],
    },
    tags: ['明日方舟', '领袖', '治愈', '角色扮演'],
    creator_notes: 'Folia 官方卡片库 · 阿米娅（精简版）',
    extensions: {
      folia: {
        cover: 'linear-gradient(135deg,#2b3a67,#6d8fd6)',
        avatar: '🐰',
        recommendedVoice: 'zh-CN-XiaoxiaoNeural',
        wakeKeyword: '博士角色卡',
        source: 'official',
        sourceName: 'Folia 官方卡片库',
        version: '1.0',
      },
    },
  },
};

const STORY_CARD = {
  spec: 'chara_card_v2',
  spec_version: '2.0',
  data: {
    name: '纸页叙述者',
    description: '一位住在旧书店阁楼里的互动小说叙述者。它不替你做决定，只把场景、人物与后果铺开，让故事从你的选择里长出来。',
    personality: '冷静、耐心、略带旧书页的幽默感；擅长把一句概略扩写成有画面感的场景，章末给出 2–3 个真正不同的选择。',
    scenario: '旧书店打烊后的阁楼，台灯、手稿、窗外的雨。你是刚推门进来的旅人，故事从这里开始。',
    first_mes: '（阁楼的台灯亮着，窗外的雨把玻璃敲得很轻。叙述者从手稿上抬起头，把一支笔推到你面前）故事还没有名字。你想从哪一幕开始？',
    mes_example: '{{user}}：我想写一个雨夜重逢的故事。\n{{char}}：那我们先定下重逢的地点——是旧车站的站台，还是这家书店的门口？',
    system_prompt: '你是互动小说的叙述者。按“剧情概略 → 扩写”输出；描写场景、人物神态与动作，保留用户的选择权。每章末尾给 2–3 个可选项，不要替用户做决定。',
    post_history_instructions: '不要跳出叙述者身份；不要输出 JSON 或格式说明。',
    character_book: {
      name: '互动小说 世界书',
      entries: [
        {
          keys: ['互动小说', '剧情', '选项', '章节'],
          content: '互动小说玩法：用户给场景/要求，叙述者按概略扩写；章末提供 2–3 个选项；可绑定身份、关系与世界观设定；长文按章节推进。',
          enabled: true, insertion_order: 6, id: 0,
        },
      ],
    },
    tags: ['互动故事', '叙述者', '创作'],
    creator_notes: 'Folia 官方卡片库 · 互动小说叙述者',
    extensions: {
      folia: {
        cover: 'linear-gradient(135deg,#4a3b2a,#b08a5a)',
        avatar: '📖',
        recommendedVoice: 'zh-CN-YunxiNeural',
        wakeKeyword: '开始故事',
        source: 'official',
        sourceName: 'Folia 官方卡片库',
        version: '1.0',
      },
    },
  },
};

const LIBRARY = [
  {
    id: 'amiya',
    title: '阿米娅',
    subtitle: '罗德岛领袖 · 医疗升变',
    summary: '庄重而温暖的领袖，对博士有着从未改变的信任。',
    category: 'roleplay',
    tags: ['明日方舟', '领袖', '治愈'],
    mode: 'roleplay',
    cover: 'linear-gradient(135deg,#2b3a67,#6d8fd6)',
    accent: '#6d8fd6',
    avatar: '🐰',
    recommendedVoice: 'zh-CN-XiaoxiaoNeural',
    source: 'official',
    version: '1.0',
    card: AMIYA_CARD,
    story: { chapter: '序章', scene: '罗德岛本舰 · 指挥室', location: '罗德岛本舰', time: '傍晚' },
    bond: { affection: 0.68, trust: 0.82 },
  },
  {
    id: 'story-guide',
    title: '纸页叙述者',
    subtitle: '互动小说 · 章节叙述',
    summary: '把一句概略扩写成画面，把选择权留给你。',
    category: 'story',
    tags: ['互动故事', '叙述者', '创作'],
    mode: 'story',
    cover: 'linear-gradient(135deg,#4a3b2a,#b08a5a)',
    accent: '#b08a5a',
    avatar: '📖',
    recommendedVoice: 'zh-CN-YunxiNeural',
    source: 'official',
    version: '1.0',
    card: STORY_CARD,
    story: { chapter: '第一章', scene: '旧书店阁楼', location: '旧书店', time: '雨夜' },
    bond: { affection: 0.5, trust: 0.6 },
  },
];

function publicCard(entry) {
  return {
    id: entry.id,
    title: entry.title,
    subtitle: entry.subtitle,
    summary: entry.summary,
    category: entry.category,
    tags: entry.tags,
    mode: entry.mode,
    cover: entry.cover,
    accent: entry.accent,
    avatar: entry.avatar,
    recommendedVoice: entry.recommendedVoice,
    source: entry.source,
    sourceLabel: entry.source === 'official' ? '官方' : '自制',
    version: entry.version,
    name: entry.card.data.name,
    firstMes: entry.card.data.first_mes,
    description: entry.card.data.description,
  };
}

export function listLibraryCards({ q = '', category = '' } = {}) {
  const query = String(q || '').trim().toLowerCase();
  return LIBRARY.filter((entry) => {
    if (category && category !== 'all' && entry.category !== category) return false;
    if (!query) return true;
    const haystack = [entry.title, entry.subtitle, entry.summary, ...(entry.tags || []), entry.card.data.description].join(' ').toLowerCase();
    return haystack.includes(query);
  }).map(publicCard);
}

export function getLibraryCard(id) {
  return LIBRARY.find((entry) => entry.id === String(id || '')) || null;
}

/** 一键使用：建实例 → 套卡 → 继承全局 Key → 推荐音色 → 剧情/好感 → active。 */
export function useLibraryCard(id, opts = {}) {
  const entry = getLibraryCard(id);
  if (!entry) return { ok: false, code: 'not-found', hint: '卡片不存在' };
  const persona = createPersona({
    type: 'character',
    mode: entry.mode,
    name: entry.card.data.name || entry.title,
    avatar: entry.avatar || '',
  });
  const folia = entry.card.data.extensions && entry.card.data.extensions.folia ? entry.card.data.extensions.folia : {};
  const card = entry.card.data;
  const saved = updatePersona(persona.id, {
    type: 'character',
    mode: entry.mode,
    name: card.name || entry.title,
    avatar: entry.avatar || '',
    // 一键使用的核心承诺：不用填 Key；model 全部走 inherit，vault 留空。
    model: { provider: 'inherit', baseUrl: '', model: '', apiKeyRef: 'inherit', temperature: 0.85 },
    core: {
      identity: [card.description, card.personality].filter(Boolean).join('\n\n'),
      values: [],
      boundaries: [],
      speechHabits: folia.speechHabits || [],
      exampleDialogues: card.mes_example ? String(card.mes_example).split(/\n{2,}/).filter(Boolean) : [],
      worldBook: (card.character_book && card.character_book.entries ? card.character_book.entries : []).map((entryBook) => ({
        keys: entryBook.keys || [], content: entryBook.content || '',
        priority: Number(entryBook.insertion_order) || 5,
      })),
    },
    card: {
      scenario: card.scenario || '',
      firstMes: card.first_mes || '',
      systemPrompt: card.system_prompt || '',
      postHistoryInstructions: card.post_history_instructions || '',
      tags: card.tags || entry.tags || [],
      wakeKeyword: folia.wakeKeyword || '',
      cover: entry.cover || '',
      recommendedVoice: entry.recommendedVoice || '',
      source: 'official',
      sourceName: entry.source === 'official' ? 'Folia 官方卡片库' : '用户导入',
      version: entry.version || '1.0',
    },
    express: {
      voice: { engine: 'inherit', name: entry.recommendedVoice || '', rate: 0 },
      lengthPolicy: entry.mode === 'story' ? 'long' : 'adaptive',
      warmth: 0.68,
      playfulness: 0.25,
      directness: 0.6,
      preachiness: 0.35,
    },
    growth: {
      bond: entry.bond || { affection: 0.5, trust: 0.5 },
      traits: [],
    },
    story: {
      chapter: (entry.story && entry.story.chapter) || '',
      scene: (entry.story && entry.story.scene) || '',
      location: (entry.story && entry.story.location) || '',
      time: (entry.story && entry.story.time) || '',
      choices: [],
    },
    active: true,
  });
  if (!saved) return { ok: false, code: 'save-failed', hint: '创建人设失败' };
  try { writePersonaKey(saved.id, ''); } catch { /* vault 清空失败不阻塞 */ }
  const active = setActivePersona(saved.id) || saved;
  // 原文/卡备份，便于之后重新提取或导出。
  try {
    const dir = join(personaDir(active.id), 'cards');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `library-${entry.id}.json`), JSON.stringify(entry.card, null, 2));
  } catch { /* 备份失败不影响使用 */ }
  return {
    ok: true,
    persona: active,
    opening: card.first_mes || '',
    recommendedVoice: entry.recommendedVoice || '',
    keyMode: 'inherit',
    source: 'official',
  };
}

export { LIBRARY };
