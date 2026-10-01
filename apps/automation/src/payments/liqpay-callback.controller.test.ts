import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LiqpayCallbackController } from './liqpay-callback.controller';

function make(verifyResult: any, env: Record<string, string | undefined> = {}) {
  const calls: any[] = [];
  const liqpay = { verifyCallback: (d: string, s: string) => { calls.push(['verify', d, s]); return verifyResult; } } as any;
  const repo = { markPaid: async (oid: string) => { calls.push(['markPaid', oid]); } } as any;
  const config = { get: (k: string) => env[k] } as any;
  return { ctrl: new LiqpayCallbackController(liqpay, repo, config), calls };
}

test('valid success callback marks the order paid', async () => {
  const { ctrl, calls } = make({ valid: true, status: 'success', orderId: 'o1' });
  const r = await ctrl.callback({ data: 'D', signature: 'S' });
  assert.deepEqual(r, { ok: true });
  assert.ok(calls.some(c => c[0] === 'markPaid' && c[1] === 'o1'));
});

test('invalid signature does NOT mark paid and reports 400', async () => {
  const { ctrl, calls } = make({ valid: false });
  await assert.rejects(() => ctrl.callback({ data: 'D', signature: 'bad' }), /invalid/i);
  assert.ok(!calls.some(c => c[0] === 'markPaid'));
});

test('valid but non-success status does not mark paid', async () => {
  const { ctrl, calls } = make({ valid: true, status: 'failure', orderId: 'o1' });
  const r = await ctrl.callback({ data: 'D', signature: 'S' });
  assert.deepEqual(r, { ok: true });
  assert.ok(!calls.some(c => c[0] === 'markPaid'));
});

test('wait_accept is NOT paid (money not settled yet)', async () => {
  const { ctrl, calls } = make({ valid: true, status: 'wait_accept', orderId: 'o1' });
  await ctrl.callback({ data: 'D', signature: 'S' });
  assert.ok(!calls.some(c => c[0] === 'markPaid'));
});

test('sandbox is NOT paid by default', async () => {
  const { ctrl, calls } = make({ valid: true, status: 'sandbox', orderId: 'o1' });
  await ctrl.callback({ data: 'D', signature: 'S' });
  assert.ok(!calls.some(c => c[0] === 'markPaid'));
});

test('sandbox IS paid when LIQPAY_SANDBOX=true', async () => {
  const { ctrl, calls } = make({ valid: true, status: 'sandbox', orderId: 'o1' }, { LIQPAY_SANDBOX: 'true' });
  await ctrl.callback({ data: 'D', signature: 'S' });
  assert.ok(calls.some(c => c[0] === 'markPaid' && c[1] === 'o1'));
});

test('success stays paid when LIQPAY_SANDBOX=true', async () => {
  const { ctrl, calls } = make({ valid: true, status: 'success', orderId: 'o2' }, { LIQPAY_SANDBOX: 'true' });
  await ctrl.callback({ data: 'D', signature: 'S' });
  assert.ok(calls.some(c => c[0] === 'markPaid' && c[1] === 'o2'));
});
