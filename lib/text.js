/**
 * OneBot v11 message-segment helpers.
 *
 * Kept dependency-free on purpose: this plugin is installed into a DSH profile
 * whose `node_modules` only holds profile bundles, so only Node builtins and
 * intra-package files are safe to import.
 */

/** OneBot CQ escape table (reverse of the one below). */
const CQ_UNESCAPE = [
  ['&amp;', '&'],
  ['&#91;', '['],
  ['&#93;', ']'],
  ['&#44;', ','],
];

/** Decode a CQ parameter value. */
export function unescapeCqValue(value) {
  let out = String(value);
  for (const [from, to] of CQ_UNESCAPE) out = out.split(from).join(to);
  return out;
}

/** Encode a CQ parameter value. */
export function escapeCqValue(value) {
  return String(value)
    .split('&').join('&amp;')
    .split('[').join('&#91;')
    .split(']').join('&#93;')
    .split(',').join('&#44;');
}

/** Parse a raw CQ-code string into OneBot message segments. */
export function parseCqString(raw) {
  const text = String(raw ?? '');
  const segments = [];
  const pattern = /\[CQ:([A-Za-z0-9_.-]+)((?:,[^\]]*)?)\]/g;
  let cursor = 0;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > cursor) {
      const plain = text.slice(cursor, match.index);
      if (plain.length > 0) segments.push({ type: 'text', data: { text: plain } });
    }
    const data = {};
    const rest = match[2] ?? '';
    if (rest.length > 1) {
      for (const pair of rest.slice(1).split(',')) {
        if (pair.length === 0) continue;
        const eq = pair.indexOf('=');
        if (eq < 0) continue;
        data[pair.slice(0, eq)] = unescapeCqValue(pair.slice(eq + 1));
      }
    }
    segments.push({ type: match[1], data });
    cursor = pattern.lastIndex;
  }
  if (cursor < text.length) {
    const plain = text.slice(cursor);
    if (plain.length > 0) segments.push({ type: 'text', data: { text: plain } });
  }
  return segments;
}

/** Normalize whatever OneBot sent in `message` into a segment array. */
export function normalizeSegments(message) {
  if (Array.isArray(message)) {
    return message
      .filter((segment) => segment !== null && typeof segment === 'object')
      .map((segment) => ({
        type: String(segment.type ?? 'unknown'),
        data: (segment.data !== null && typeof segment.data === 'object') ? { ...segment.data } : {},
      }));
  }
  if (typeof message === 'string') return parseCqString(message);
  return [];
}

/** True when the segment addresses the bot itself (or the whole group). */
export function isSelfMention(segment, selfId, answerAll = true) {
  if (segment?.type !== 'at') return false;
  const qq = String(segment.data?.qq ?? '');
  if (qq === 'all') return answerAll;
  return selfId !== null && selfId !== undefined && qq === String(selfId);
}

/** True when any segment @-es the bot. */
export function mentionsSelf(segments, selfId) {
  return segments.some((segment) => isSelfMention(segment, selfId));
}

/** Remove the segments that @ the bot, so the model sees a clean instruction. */
export function stripSelfMentions(segments, selfId) {
  return segments.filter((segment) => !isSelfMention(segment, selfId));
}

/** Drop leading/trailing blank text segments. */
export function trimTextSegments(segments) {
  const out = segments.slice();
  while (out.length > 0) {
    const first = out[0];
    if (first.type !== 'text') break;
    const trimmed = String(first.data?.text ?? '').replace(/^[\s\u200b]+/, '');
    if (trimmed.length === 0) { out.shift(); continue; }
    out[0] = { type: 'text', data: { ...first.data, text: trimmed } };
    break;
  }
  while (out.length > 0) {
    const last = out[out.length - 1];
    if (last.type !== 'text') break;
    const trimmed = String(last.data?.text ?? '').replace(/[\s\u200b]+$/, '');
    if (trimmed.length === 0) { out.pop(); continue; }
    out[out.length - 1] = { type: 'text', data: { ...last.data, text: trimmed } };
    break;
  }
  return out;
}

/** Human-readable rendering of one segment for model context. */
function renderSegment(segment) {
  const data = segment.data ?? {};
  switch (segment.type) {
    case 'text':
      return String(data.text ?? '');
    case 'at':
      return data.qq === 'all' ? '@全体成员' : `@${data.name ?? data.qq ?? '某人'}`;
    case 'image':
      return data.summary ? `[图片:${data.summary}]` : '[图片]';
    case 'face':
      return data.raw ? `[表情:${data.raw}]` : '[表情]';
    case 'mface':
      return '[表情]';
    case 'reply':
      return '[回复某条消息]';
    case 'record':
      return '[语音]';
    case 'video':
      return '[视频]';
    case 'file':
      return `[文件:${data.name ?? data.file ?? ''}]`;
    case 'forward':
      return '[合并转发]';
    case 'json':
    case 'xml':
      return '[卡片消息]';
    case 'markdown':
      return String(data.content ?? '[markdown]');
    case 'poke':
      return '[戳一戳]';
    case 'dice':
      return '[骰子]';
    case 'rps':
      return '[猜拳]';
    default:
      return `[${segment.type}]`;
  }
}

/** Flatten segments to the plain text the model reads. */
export function segmentsToPlainText(segments) {
  return segments.map(renderSegment).join('');
}

/** Build outgoing text segments, optionally prefixing @-mentions. */
export function buildTextMessage(text, mentions = []) {
  const segments = [];
  for (const userId of mentions) {
    if (userId === null || userId === undefined || String(userId).length === 0) continue;
    segments.push({ type: 'at', data: { qq: String(userId) } });
    segments.push({ type: 'text', data: { text: ' ' } });
  }
  if (text !== undefined && text !== null && String(text).length > 0) {
    segments.push({ type: 'text', data: { text: String(text) } });
  }
  if (segments.length === 0) segments.push({ type: 'text', data: { text: ' ' } });
  return segments;
}

/** Best display name for a OneBot sender object. */
export function senderName(sender, fallbackId) {
  if (sender && typeof sender === 'object') {
    const card = typeof sender.card === 'string' ? sender.card.trim() : '';
    if (card.length > 0) return card;
    const nickname = typeof sender.nickname === 'string' ? sender.nickname.trim() : '';
    if (nickname.length > 0) return nickname;
  }
  return fallbackId === null || fallbackId === undefined ? '未知' : String(fallbackId);
}

/** Clip a string to `max` characters, marking the cut. */
export function truncate(text, max) {
  const value = String(text ?? '');
  if (!Number.isFinite(max) || max <= 0 || value.length <= max) return value;
  return `${value.slice(0, max)}…(已截断 ${value.length - max} 字)`;
}

/** Collapse whitespace runs and clip, for log lines. */
export function oneLine(text, max = 160) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
}
