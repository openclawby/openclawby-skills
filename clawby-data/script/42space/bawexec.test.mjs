// bawexec.mjs tests — run from this dir: node --test
// Fully offline: the `baw` CLI is never spawned — every call injects a fake `run(args) -> parsed JSON body`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { proxyEnv, bawSend, bawReady, bawBscAddress, bawSignin, bawVerify } from './bawexec.mjs';

const ok = (data) => ({ success: true, data });
const fail = (error) => ({ success: false, error });

test('proxyEnv: hardcodes NO proxy — passes the ambient env through; opt-in via CLAWBY_BAW_PROXY or an existing HTTPS_PROXY', () => {
  const none = proxyEnv({ PATH: '/x' });
  assert.equal(none.PATH, '/x', 'carries the env through');
  assert.equal(none.HTTPS_PROXY, undefined, 'no hardcoded proxy for users who have none');
  assert.equal(none.NODE_USE_ENV_PROXY, undefined);
  const explicit = proxyEnv({ CLAWBY_BAW_PROXY: 'http://p:9' });
  assert.equal(explicit.HTTPS_PROXY, 'http://p:9');
  assert.equal(explicit.https_proxy, 'http://p:9');
  assert.equal(explicit.NODE_USE_ENV_PROXY, '1');
  const ambient = proxyEnv({ HTTPS_PROXY: 'http://q:8' });
  assert.equal(ambient.HTTPS_PROXY, 'http://q:8', 'passes an existing proxy through');
  assert.equal(ambient.NODE_USE_ENV_PROXY, '1', 'and enables NODE_USE_ENV_PROXY so baw respects it');
});

function previewExecRun({ preview, execute }) {
  const calls = [];
  const run = async (args) => {
    calls.push(args);
    if (args[0] === 'contract-call' && args[1] === 'preview') return preview;
    if (args[0] === 'contract-call' && args[1] === 'execute') return execute;
    throw new Error('unexpected args ' + args.join(' '));
  };
  run.calls = calls;
  return run;
}

test('bawSend: previews with the exact --from/--to/--value/--inputData, executes the requestId, returns the broadcast hash', async () => {
  const run = previewExecRun({
    preview: ok({ requestId: 'R1', simulationResult: { simulationCode: '000000000' }, risks: { riskDetails: [] }, requireConfirmation: false }),
    execute: ok({ status: 'BROADCASTED', txHash: '0xabc' }),
  });
  const r = await bawSend({ from: '0xFrom', to: '0xTo', value: 0n, data: '0xdead' }, { run });
  assert.deepEqual(r, { hash: '0xabc', status: 'BROADCASTED' });
  assert.deepEqual(run.calls[0], ['contract-call', 'preview', '--binanceChainId', '56', '--from', '0xFrom', '--to', '0xTo', '--value', '0', '--inputData', '0xdead']);
  assert.deepEqual(run.calls[1], ['contract-call', 'execute', '--requestId', 'R1']);
});

test('bawSend: fails CLOSED on blocked / sim-fail / RISK / pending-confirmation — nothing is ever executed', async () => {
  const only = (preview) => previewExecRun({ preview, execute: ok({ status: 'BROADCASTED', txHash: '0xSHOULD_NOT_SEND' }) });
  let run = only(fail({ code: 351803, name: 'AGENT_DEV_MODE_RISK_BLOCKED' }));
  await assert.rejects(bawSend({ from: 'a', to: 'b', data: '0x' }, { run }), /preview/i);
  assert.equal(run.calls.length, 1, 'blocked: no execute');
  run = only(ok({ requestId: 'R', simulationResult: { simulationCode: '351805', simulationMsg: 'gas cap' } }));
  await assert.rejects(bawSend({ from: 'a', to: 'b', data: '0x' }, { run }), /simulation/i);
  assert.equal(run.calls.length, 1, 'sim-fail: no execute');
  run = only(ok({ requestId: 'R', simulationResult: { simulationCode: '000000000' }, risks: { riskDetails: [{ riskType: 'RISK', title: 'drains wallet' }] } }));
  await assert.rejects(bawSend({ from: 'a', to: 'b', data: '0x' }, { run }), /RISK|drains/);
  assert.equal(run.calls.length, 1, 'RISK: no execute');
  run = only(ok({ requestId: 'R', simulationResult: { simulationCode: '000000000' }, requireConfirmation: true }));
  await assert.rejects(bawSend({ from: 'a', to: 'b', data: '0x' }, { run }), /confirm/i);
  assert.equal(run.calls.length, 1, 'requireConfirmation: no execute');
});

test('bawSend: a preview with a requestId but NO simulationResult fails closed (never executes without a clean 000000000 sim)', async () => {
  const run = previewExecRun({
    preview: ok({ requestId: 'R', risks: { riskDetails: [] }, requireConfirmation: false }),   // no simulationResult at all
    execute: ok({ status: 'BROADCASTED', txHash: '0xSHOULD_NOT_SEND' }),
  });
  await assert.rejects(bawSend({ from: 'a', to: 'b', data: '0x' }, { run }), /simulation/i);
  assert.equal(run.calls.length, 1, 'no execute without a clean simulation code');
});

test('bawSend: an execute with no txHash fails closed (never returns an undefined hash to sendStep)', async () => {
  const run = previewExecRun({
    preview: ok({ requestId: 'R', simulationResult: { simulationCode: '000000000' }, risks: { riskDetails: [] }, requireConfirmation: false }),
    execute: ok({ status: 'QUEUED' }),   // success:true but no txHash and not BROADCASTED
  });
  await assert.rejects(bawSend({ from: 'a', to: 'b', data: '0x' }, { run }), /no tx hash|did not broadcast/i);
});

test('bawSend: a CAUTION risk is allowed (only RISK blocks)', async () => {
  const run = previewExecRun({
    preview: ok({ requestId: 'R', simulationResult: { simulationCode: '000000000' }, risks: { riskDetails: [{ riskType: 'CAUTION', title: 'approval' }] } }),
    execute: ok({ status: 'BROADCASTED', txHash: '0xfeed' }),
  });
  assert.equal((await bawSend({ from: 'a', to: 'b', data: '0x' }, { run })).hash, '0xfeed');
});

test('bawReady: connected + devMode on / off / expired', async () => {
  const mk = (status, dm, sess = 123) => async (args) => {
    if (args[0] === 'wallet' && args[1] === 'status') return ok({ status });
    if (args[0] === 'wallet' && args[1] === 'settings') return ok({ devMode: dm, sessionExpireTime: sess });
    throw new Error('x');
  };
  assert.deepEqual(await bawReady({ run: mk('CONNECTED', { enabled: true, expiresAt: '2999-01-01T00:00:00Z' }) }),
    { connected: true, devModeOn: true, devModeExpiresAt: '2999-01-01T00:00:00Z', sessionExpireTime: 123 });
  assert.equal((await bawReady({ run: mk('CONNECTED', { enabled: false }) })).devModeOn, false);
  assert.equal((await bawReady({ run: mk('CONNECTED', { enabled: true, expiresAt: '2000-01-01T00:00:00Z' }) })).devModeOn, false);
  assert.equal((await bawReady({ run: mk('UNCONNECTED', {}) })).connected, false);
});

test('bawBscAddress: picks the chain-56 address (checksummed); bawSignin / bawVerify parse', async () => {
  const lower = '0x067af9c770e09a64f86e4f190070038e1fcd8dab';
  const run = async (args) => {
    if (args[0] === 'wallet' && args[1] === 'address') return ok({ addresses: [{ binanceChainId: '1', address: lower }, { binanceChainId: '56', address: lower }] });
    if (args[0] === 'auth' && args[1] === 'signin') return ok({ qrCodeId: 'Q', pairingCode: '123456', urlForWeb: 'https://x', expireAt: 9 });
    if (args[0] === 'auth' && args[1] === 'verify') return ok({ status: 'SUCCESS' });
    throw new Error('x');
  };
  assert.equal(await bawBscAddress({ run }), '0x067Af9c770e09a64f86e4F190070038e1fcd8dab');
  assert.deepEqual(await bawSignin({ run }), { qrCodeId: 'Q', pairingCode: '123456', urlForWeb: 'https://x', expireAt: 9 });
  assert.deepEqual(await bawVerify('Q', { run }), { success: true, status: 'SUCCESS' });
});
