// Spec 103 §8: the lock / unlock routes are under the owner's guard, answer {slot}, 404 slot_not_found and 409 slot_closed.
import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { TrackingAuthGuard } from '../../tracking/api/tracking-auth.guard';
import { SlotLockController } from './slot-lock.controller';

const row = (over: any = {}) => ({ id: 's1', plan_id: 'p1', channel_key: '@c', scheduled_at: new Date(), kind: 'content', status: 'planned', created_via: 'connector', locked_by: null, locked_at: null, ...over });

/** A fake pool that answers by the SQL's first word. */
function pool(o: { update?: any; current?: any } = {}) {
  return { query: async (sql: string) => (/^\s*UPDATE/i.test(sql) ? { rows: o.update ? [o.update] : [] } : { rows: o.current ? [o.current] : [] }) } as any;
}

test('the routes are POST :id/unlock and :id/lock, under TrackingAuthGuard', () => {
  assert.equal(Reflect.getMetadata('path', SlotLockController), 'api/editor/slots');
  assert.equal(Reflect.getMetadata('path', SlotLockController.prototype.unlock), ':id/unlock');
  assert.equal(Reflect.getMetadata('path', SlotLockController.prototype.lock), ':id/lock');
  assert.equal(Reflect.getMetadata('method', SlotLockController.prototype.unlock), 1, 'POST');
  assert.equal(Reflect.getMetadata('method', SlotLockController.prototype.lock), 1, 'POST');
  assert.deepEqual(Reflect.getMetadata('__guards__', SlotLockController), [TrackingAuthGuard]);
});

test('unlock answers {slot} with the connector marks kept; an unknown id is 404 slot_not_found', async () => {
  const ok = await new SlotLockController(pool({ update: row() })).unlock('s1');
  assert.equal(ok.slot.lockedBy ?? null, null);
  assert.equal(ok.slot.createdVia, 'connector');
  await assert.rejects(new SlotLockController(pool()).unlock('x'), (e: any) => e instanceof NotFoundException && (e.getResponse() as any).error === 'slot_not_found');
});

test('lock answers {slot}; a closed slot is 409 slot_closed; an unknown id is 404', async () => {
  const ok = await new SlotLockController(pool({ update: row({ locked_by: 'owner', locked_at: new Date() }) })).lock('s1');
  assert.equal(ok.slot.lockedBy, 'owner');
  await assert.rejects(new SlotLockController(pool({ current: { status: 'published' } })).lock('s1'), (e: any) => e instanceof ConflictException && (e.getResponse() as any).error === 'slot_closed');
  await assert.rejects(new SlotLockController(pool()).lock('x'), NotFoundException);
});
