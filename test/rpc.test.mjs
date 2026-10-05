/**
 * Tests for the Host half of the "QQ-bot" settings page: the Connection RPC
 * channel the Web client calls.
 */

import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import { RPC_CHANNEL, createRpcHandler, pageState, registerRpc } from '../lib/rpc.js';
import { cleanupAll, makeBridge } from './harness.mjs';

after(async () => {
  await cleanupAll();
});

/** A fake Connection service that records channel registrations. */
function fakeConnection() {
  const registered = [];
  const state = { disposed: false };
  return {
    registered,
    state,
    service: {
      rpc: {
        handle: (channel, handler) => {
          registered.push({ channel, handler });
          return async () => { state.disposed = true; };
        },
      },
    },
  };
}

test('the RPC channel is registered on the connection service and disposed again', async () => {
  const connection = fakeConnection();
  const { bridge, ctx } = await makeBridge({ services: { connection: connection.service } });
  const logger = { info() {}, warn() {}, debug() {}, error() {} };

  const dispose = await registerRpc(ctx, bridge, logger);
  assert.equal(connection.registered.length, 1);
  assert.equal(connection.registered[0].channel, RPC_CHANNEL);
  assert.equal(typeof connection.registered[0].handler, 'function');

  await dispose();
  assert.equal(connection.state.disposed, true);
});

test('registerRpc survives a profile without a connection service', async () => {
  const { bridge, ctx } = await makeBridge();
  const warnings = [];
  const logger = { info() {}, debug() {}, error() {}, warn: (message) => warnings.push(message) };
  const dispose = await registerRpc(ctx, bridge, logger);
  assert.equal(typeof dispose, 'function');
  await dispose();
});

test('status returns the page state without ever leaking secrets', async () => {
  const { bridge } = await makeBridge({ config: { accessToken: 'super-secret-token', reportSecret: 'hmac-secret' } });
  const handler = createRpcHandler(bridge);

  const result = await handler('status', {}, new AbortController().signal, null);
  assert.equal(result.ok, true);
  const value = result.value;
  assert.equal(value.config.accessTokenSet, true);
  assert.equal(value.config.reportSecretSet, true);
  assert.equal(Object.hasOwn(value.config, 'accessToken'), false);
  assert.equal(Object.hasOwn(value.config, 'reportSecret'), false);
  const serialized = JSON.stringify(value);
  assert.ok(!serialized.includes('super-secret-token'), '响应里不应出现 token');
  assert.ok(!serialized.includes('hmac-secret'), '响应里不应出现 reportSecret');
  // 页面实际用到的字段
  assert.equal(typeof value.onebot.baseUrl, 'string');
  assert.equal(typeof value.server.reportUrl, 'string');
  assert.ok(Array.isArray(value.sessions));
  assert.ok(Array.isArray(value.groups));
  assert.equal(typeof value.dataDir, 'string');
});

test('setConfig writes runtime overrides and rejects unknown keys', async () => {
  const { bridge } = await makeBridge();
  const handler = createRpcHandler(bridge);

  const dry = await handler('setConfig', { key: 'dryRun', value: true }, null, null);
  assert.equal(dry.ok, true);
  assert.equal(dry.value.dryRun, true);
  assert.equal(bridge.config.dryRun, true);

  const mode = await handler('setConfig', { key: 'defaultGroupMode', value: 'auto' }, null, null);
  assert.equal(mode.ok, true);
  assert.equal(bridge.config.defaultGroupMode, 'auto');
  assert.equal(bridge.modeFor('99999'), 'auto');

  const bad = await handler('setConfig', { key: 'enabled', value: false }, null, null);
  assert.equal(bad.ok, false);
  assert.match(bad.error.message, /不允许在运行时修改/);

  const missing = await handler('setConfig', {}, null, null);
  assert.equal(missing.ok, false);

  // 空字符串 = 清除覆盖，回到 patch 里的值
  const cleared = await handler('setConfig', { key: 'dryRun', value: '' }, null, null);
  assert.equal(cleared.ok, true);
  assert.equal(bridge.config.dryRun, false);
  assert.deepEqual(bridge.overrides(), { defaultGroupMode: 'auto' });
});

test('the owner endpoint adds and removes QQ numbers with validation', async () => {
  const { bridge } = await makeBridge();
  const handler = createRpcHandler(bridge);

  const added = await handler('owner', { ownerId: '123456789' }, null, null);
  assert.equal(added.ok, true);
  assert.deepEqual(added.value.config.ownerIds, ['20001', '123456789']);
  assert.equal(bridge.isOwner('123456789'), true);

  const rejected = await handler('owner', { ownerId: 'abc' }, null, null);
  assert.equal(rejected.ok, false);
  assert.match(rejected.error.message, /5~12 位数字/);

  const removed = await handler('owner', { ownerId: '123456789', remove: true }, null, null);
  assert.equal(removed.ok, true);
  assert.deepEqual(removed.value.config.ownerIds, ['20001']);
});

test('setGroupMode writes, validates, and can reset to the patch value', async () => {
  const { bridge } = await makeBridge({ config: { groups: { 11111: 'auto' } } });
  const handler = createRpcHandler(bridge);

  const set = await handler('setGroupMode', { groupId: '22222', mode: 'off' }, null, null);
  assert.equal(set.ok, true);
  assert.equal(bridge.modeFor('22222'), 'off');

  const bad = await handler('setGroupMode', { groupId: '22222', mode: 'shout' }, null, null);
  assert.equal(bad.ok, false);
  assert.match(bad.error.message, /不支持的群模式/);

  const noId = await handler('setGroupMode', { mode: 'off' }, null, null);
  assert.equal(noId.ok, false);

  await handler('setGroupMode', { groupId: '11111', mode: 'off' }, null, null);
  assert.equal(bridge.modeFor('11111'), 'off');
  const reset = await handler('setGroupMode', { groupId: '11111', mode: null }, null, null);
  assert.equal(reset.ok, true);
  assert.equal(bridge.modeFor('11111'), 'auto', '重置后应回到配置里的值');
});

test('an unknown endpoint fails with not-found instead of throwing', async () => {
  const { bridge } = await makeBridge();
  const handler = createRpcHandler(bridge);
  const result = await handler('nope', {}, null, null);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'not-found');
});

test('pageState is plain JSON-safe data', async () => {
  const { bridge } = await makeBridge();
  const state = pageState(bridge);
  assert.equal(JSON.parse(JSON.stringify(state)).config.apiBaseUrl, state.config.apiBaseUrl);
});
