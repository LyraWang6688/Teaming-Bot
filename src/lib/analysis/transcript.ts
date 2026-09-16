export interface ParsedTurn {
  speaker: string;
  timestamp?: string;
  text: string;
  charCount: number;
}

export interface ParsedTranscript {
  raw: string;
  header: string[];
  turns: ParsedTurn[];
  speakers: Array<{ name: string; charCount: number; share: number; turnCount: number }>;
  durationLabel?: string;
  meetingStartedAt?: string;
  effectiveTurnCount: number;
  qualityNotes: string[];
}

const FILLER_ONLY = /^(?:[嗯啊哦额譬如呃呵哈譬如哎譬如诶譬如\s,.!?~。，！？、…-]|ok|okay)+$/i;

/**
 * Parse common Feishu Minutes exports. Speaker statistics are deterministic and
 * never delegated to the language model.
 */
export function parseTranscript(rawInput: string): ParsedTranscript {
  const raw = normalizeText(rawInput);
  const lines = raw.split('\n');
  const header: string[] = [];
  const turns: ParsedTurn[] = [];
  let active: ParsedTurn | null = null;

  const flush = () => {
    if (!active) return;
    active.text = active.text.replace(/\s+/g, ' ').trim();
    active.charCount = countMeaningfulChars(active.text);
    if (active.text) turns.push(active);
    active = null;
  };

  for (const sourceLine of lines) {
    const line = sourceLine.trim();
    if (!line) continue;
    const speakerLine = matchSpeakerLine(line);
    if (speakerLine) {
      flush();
      active = {
        speaker: cleanSpeakerName(speakerLine.speaker),
        timestamp: speakerLine.timestamp,
        text: speakerLine.text,
        charCount: 0,
      };
      continue;
    }
    if (active) active.text += ` ${line}`;
    else header.push(line);
  }
  flush();

  const bySpeaker = new Map<string, { chars: number; turns: number; substantiveTurns: number }>();
  for (const turn of turns) {
    const value = bySpeaker.get(turn.speaker) || { chars: 0, turns: 0, substantiveTurns: 0 };
    value.chars += turn.charCount;
    value.turns += 1;
    if (isSubstantive(turn.text)) value.substantiveTurns += 1;
    bySpeaker.set(turn.speaker, value);
  }

  // Unknown automatic speaker labels containing only fillers are transcription noise.
  const excluded = new Set<string>();
  bySpeaker.forEach((stats, name) => {
    const isGeneric = /^(?:(?:speaker|unknown|transcript)\s*\d*|说话人\s*\d+)$/i.test(name);
    if (isGeneric && (stats.substantiveTurns === 0 || stats.chars < 40)) excluded.add(name);
  });

  const denominator = [...bySpeaker.entries()]
    .filter(([name]) => !excluded.has(name))
    .reduce((sum, [, value]) => sum + value.chars, 0);
  const rawSpeakers = [...bySpeaker.entries()]
    .filter(([name]) => !excluded.has(name))
    .map(([name, value]) => ({
      name,
      charCount: value.chars,
      share: denominator ? (value.chars / denominator) * 100 : 0,
      turnCount: value.turns,
    }))
    .sort((a, b) => b.charCount - a.charCount);

  const rounded = roundSharesToHundred(rawSpeakers.map((speaker) => speaker.share));
  const speakers = rawSpeakers.map((speaker, index) => ({ ...speaker, share: rounded[index] }));
  const qualityNotes: string[] = [];
  if (excluded.size) qualityNotes.push(`已排除 ${[...excluded].join('、')} 等无实质内容的自动识别标签。`);
  if (!turns.length) qualityNotes.push('未识别到"发言者 + 时间戳"格式，发言统计可能不完整。');
  if (speakers.length === 1) qualityNotes.push('仅识别到一位实质发言者，不适合生成团队互动结论。');

  return {
    raw,
    header,
    turns,
    speakers,
    durationLabel: detectDuration(header.join(' ')),
    meetingStartedAt: detectMeetingStartedAt(header.join(' ')),
    effectiveTurnCount: turns.filter((turn) => isSubstantive(turn.text)).length,
    qualityNotes,
  };
}

function matchSpeakerLine(line: string): { speaker: string; timestamp?: string; text: string } | null {
  // Feishu: 姓名 00:03:12.500 [optional same-line content]
  const withTimestamp = line.match(/^(.{1,48}?)\s+((?:\d{1,2}:)?\d{1,2}:\d{2}(?:\.\d{1,3})?)\s*(.*)$/);
  if (withTimestamp && isLikelySpeaker(withTimestamp[1])) {
    return { speaker: withTimestamp[1], timestamp: withTimestamp[2], text: withTimestamp[3] || '' };
  }
  // Chat-style transcripts: 姓名：内容
  const withColon = line.match(/^(.{1,32}?)[：:]\s*(.+)$/);
  if (withColon && isLikelySpeaker(withColon[1])) {
    return { speaker: withColon[1], text: withColon[2] };
  }
  return null;
}

function isLikelySpeaker(value: string) {
  const name = value.trim();
  if (!name || /^(?:keywords?|关键词|transcript|转写|会议纪要)$/i.test(name)) return false;
  if (name.length > 24 || /[|，。！？；：,!?;]/.test(name)) return false;
  // 纯日期/时间/日期时间组合 → 排除
  if (/^\d{4}[-/年]/.test(name)) return false;           // 2025-01-01 / 2025/01/01 / 2025年...
  if (/^\d{1,2}月\d{1,2}日/.test(name)) return false;     // 12月24日
  if (/^(上午|下午|早上|中午|晚上|凌晨|夜里|深夜)\s*\d{1,2}:\d{2}/.test(name)) return false; // 下午 3:20
  if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(name)) return false; // 10:30 / 10:30:00
  if (/^\d{4}[-/]\d{1,2}[-/]\d{1,2}\s+\d{1,2}:\d{2}/.test(name)) return false; // 2026-08-18 10:30
  // 纯数字编号 → 排除
  if (/^\d+$/.test(name)) return false;
  // 章节标题格式（第X章 / 第X节 / Part X）→ 排除
  if (/^第[一二三四五六七八九十百千\d]+[章节部分节]/.test(name)) return false;
  if (/^part\s*\d+/i.test(name)) return false;
  // 文档元数据标签 → 排除（精确匹配，不误删真实姓名/昵称）
  if (isDocumentMetadataLabel(name)) return false;
  return true;
}

const DOCUMENT_METADATA_LABELS = new Set([
  '会议主题',
  '文字记录',
]);

function isDocumentMetadataLabel(value: string): boolean {
  const trimmed = value.trim().replace(/[：:]\s*$/, '');
  return DOCUMENT_METADATA_LABELS.has(trimmed);
}

function cleanSpeakerName(value: string) {
  return value.trim().replace(/^[@【[]|[】\]]$/g, '').replace(/\s+/g, ' ');
}

function countMeaningfulChars(value: string) {
  return value.replace(/\s+/g, '').length;
}

function isSubstantive(value: string) {
  const compact = value.replace(/\s+/g, '');
  return compact.length >= 4 && !FILLER_ONLY.test(compact);
}

function normalizeText(value: string) {
  return value.replace(/\r\n?/g, '\n').replace(/\u0000/g, '').trim();
}

function detectDuration(header: string) {
  const source = header.includes('|') ? header.slice(header.indexOf('|') + 1) : header;
  const hour = source.match(/(\d+)\s*(?:小时|h(?:ours?)?)/i)?.[1];
  const minute = source.match(/(\d+)\s*(?:分钟|mins?|minutes?)/i)?.[1];
  const second = source.match(/(\d+)\s*(?:秒|secs?|seconds?|s)(?![a-z])/i)?.[1];
  if (!hour && !minute && !second) return undefined;
  return [
    hour ? `${Number(hour)}小时` : '',
    minute ? `${Number(minute)}分钟` : '',
    second ? `${Number(second)}秒` : '',
  ].filter(Boolean).join(' ');
}

function detectMeetingStartedAt(header: string) {
  const match = header.match(/\b(20\d{2})[-_/\u5e74](\d{1,2})[-_/\u6708](\d{1,2})\u65e5?\s+(\d{1,2}):(\d{2})(?::\d{2})?/);
  if (!match) return undefined;
  const [, year, month, day, hour, minute] = match;
  return `${year}\u5e74${Number(month)}\u6708${Number(day)}\u65e5 ${hour.padStart(2, '0')}:${minute}`;
}

function roundSharesToHundred(values: number[]) {
  if (!values.length) return [];
  const floors = values.map(Math.floor);
  let remainder = 100 - floors.reduce((sum, value) => sum + value, 0);
  const order = values
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((a, b) => b.fraction - a.fraction);
  for (let index = 0; index < order.length && remainder > 0; index += 1, remainder -= 1) {
    floors[order[index].index] += 1;
  }
  return floors;
}
