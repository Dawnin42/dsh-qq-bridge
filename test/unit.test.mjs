/**
 * Pure-function tests: CQ parsing, segment rendering, config normalization, and
 * tool-pattern expansion. These need no host and no network.
 *
 *   node --test test/
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { expandToolAllowList } from '../lib/bridge.js';
import { resolveConfig } from '../lib/config.js';
import { normalizeBaseUrl } from '../lib/onebot.js';
import {
  buildTextMessage,
  isSelfMention,
  mentionsSelf,
  normalizeSegments,
  parseCqString,
  segmentsToPlainText,
  senderName,
  stripSelfMentions,
  truncate,
  unescapeCqValue,
} from '../lib/text.js';

test('parseCqString splits text and CQ segments', () => {
  const segments = parseCqString('你好[CQ:at,qq=10001] 在吗[CQ:image,file=a.png]');
  assert.deepEqual(segments, [
    { type: 'text', data: { text: '你好' } },
    { type: 'at', data: { qq: '10001' } },
    { type: 'text', data: { text: ' 在吗' } },
    { type: 'image', data: { file: 'a.png' } },
  ]);
});

test('parseCqString decodes CQ escapes', () => {
  const segments = parseCqString('[CQ:at,qq=1,name=a&#44;b]');
  assert.equal(segments[0].data.name, 'a,b');
  assert.equal(unescapeCqValue('&#91;x&#93;'), '[x]');
});

test('normalizeSegments accepts strings, arrays and junk', () => {
  assert.deepEqual(normalizeSegments('hi'), [{ type: 'text', data: { text: 'hi' } }]);
  assert.deepEqual(normalizeSegments([{ type: 'text', data: { text: 'hi' } }]), [{ type: 'text', data: { text: 'hi' } }]);
  assert.deepEqual(normalizeSegments(null), []);
  assert.deepEqual(normalizeSegments([{ type: 'face', data: null }]), [{ type: 'face', data: {} }]);
});

test('segmentsToPlainText renders every common segment type', () => {
  const segments = normalizeSegments([
    { type: 'at', data: { qq: '10001' } },
    { type: 'text', data: { text: ' 看图 ' } },
    { type: 'image', data: { file: 'x.png' } },
    { type: 'face', data: { id: '1' } },
    { type: 'reply', data: { id: '9' } },
    { type: 'file', data: { name: '报告.pdf' } },
    { type: 'unknown_kind', data: {} },
  ]);
  assert.equal(segmentsToPlainText(segments), '@10001 看图 [图片][表情][回复某条消息][文件:报告.pdf][unknown_kind]');
});

test('mentionsSelf matches the bot, @all, and nothing else', () => {
  assert.equal(isSelfMention({ type: 'at', data: { qq: '10001' } }, '10001'), true);
  assert.equal(isSelfMention({ type: 'at', data: { qq: 10001 } }, '10001'), true);
  assert.equal(isSelfMention({ type: 'at', data: { qq: '10002' } }, '10001'), false);
  assert.equal(isSelfMention({ type: 'at', data: { qq: 'all' } }, '10001'), true);
  assert.equal(isSelfMention({ type: 'text', data: { text: '@10001' } }, '10001'), false);
  assert.equal(mentionsSelf(normalizeSegments([{ type: 'at', data: { qq: '10001' } }]), '10001'), true);
});

test('stripSelfMentions removes only the bot mention', () => {
  const segments = normalizeSegments([
    { type: 'at', data: { qq: '10001' } },
    { type: 'text', data: { text: ' 帮我看下' } },
    { type: 'at', data: { qq: '20002' } },
  ]);
  const stripped = stripSelfMentions(segments, '10001');
  assert.equal(segmentsToPlainText(stripped), ' 帮我看下@20002');
});

test('buildTextMessage produces at-then-text segments', () => {
  assert.deepEqual(buildTextMessage('你好', ['20002']), [
    { type: 'at', data: { qq: '20002' } },
    { type: 'text', data: { text: ' ' } },
    { type: 'text', data: { text: '你好' } },
  ]);
  assert.deepEqual(buildTextMessage('', []), [{ type: 'text', data: { text: ' ' } }]);
});

test('senderName prefers card, then nickname, then id', () => {
  assert.equal(senderName({ card: '群主大人', nickname: '主人' }, '20001'), '群主大人');
  assert.equal(senderName({ nickname: '主人' }, '20001'), '主人');
  assert.equal(senderName({}, '20001'), '20001');
  assert.equal(senderName(undefined, undefined), '未知');
});

test('truncate clips long text and marks it', () => {
  assert.equal(truncate('abc', 10), 'abc');
  assert.equal(truncate('abcdef', 3), 'abc…(已截断 3 字)');
});

test('resolveConfig fills defaults and normalizes user values', () => {
  const config = resolveConfig({});
  assert.equal(config.enabled, true);
  assert.equal(config.dryRun, false);
  assert.equal(config.apiBaseUrl, 'http://127.0.0.1:3000');
  assert.equal(config.listenPort, 8799);
  assert.equal(config.defaultGroupMode, 'mention');
  assert.deepEqual(config.ownerIds, []);
  assert.equal(config.remote.sessionId, 'qq-remote');
  assert.deepEqual(config.groupSessions.toolAllow, ['qq_*', 'web_search', 'web_fetch']);
  assert.equal(config.remote.toolAllow, null);
  assert.ok(config.persona.group.includes('qq_reply'));
});

test('resolveConfig rejects junk and keeps valid overrides', () => {
  const config = resolveConfig({
    enabled: 'yes',
    dryRun: true,
    listenPort: 99999,
    defaultGroupMode: 'shout',
    ownerIds: [20001, '20001', '', null, 20002],
    denyGroups: ['1', 1],
    groups: { 111: 'auto', 222: 'bogus', 333: { mode: 'off' }, '': 'auto' },
    requestTimeoutMs: -5,
    remote: { sessionId: '  my-session  ', toolAllow: ['read'] },
    groupSessions: { toolAllow: [] },
  });
  assert.equal(config.enabled, true);
  assert.equal(config.dryRun, true);
  assert.equal(config.listenPort, 8799);
  assert.equal(config.defaultGroupMode, 'mention');
  assert.deepEqual(config.ownerIds, ['20001', '20002']);
  assert.deepEqual(config.denyGroups, ['1']);
  assert.deepEqual(config.groups, { 111: 'auto', 333: 'off' });
  assert.equal(config.requestTimeoutMs, 15000);
  assert.equal(config.remote.sessionId, 'my-session');
  assert.deepEqual(config.remote.toolAllow, ['read']);
  assert.deepEqual(config.groupSessions.toolAllow, []);
});

test('expandToolAllowList expands prefixes against real names only', () => {
  const names = new Set(['qq_status', 'qq_send_group', 'read', 'web_search']);
  assert.deepEqual(expandToolAllowList(['qq_*'], names), ['qq_status', 'qq_send_group']);
  assert.deepEqual(expandToolAllowList(['qq_*', 'read', 'nope'], names), ['qq_status', 'qq_send_group', 'read']);
  assert.deepEqual(expandToolAllowList(['*'], names), ['qq_status', 'qq_send_group', 'read', 'web_search']);
  assert.deepEqual(expandToolAllowList(['typo'], names), []);
});

test('normalizeBaseUrl repairs common mistakes', () => {
  assert.equal(normalizeBaseUrl(''), 'http://127.0.0.1:3000');
  assert.equal(normalizeBaseUrl('127.0.0.1:3010/'), 'http://127.0.0.1:3010');
  assert.equal(normalizeBaseUrl('https://qq.example.com/api/'), 'https://qq.example.com/api');
});
