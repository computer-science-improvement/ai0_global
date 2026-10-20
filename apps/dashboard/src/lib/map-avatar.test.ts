import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { MapAgentKind } from '../api/map';
import { ACCESSORIES, AVATAR_PALETTE, EYES, GRID, accessoryOf, filledCells, hashHandle, seeded, spriteOf } from './map-avatar';

const KINDS: MapAgentKind[] = ['manager', 'builder', 'orchestrator', 'planner', 'ideator', 'idea_reviewer', 'executor', 'reviewer'];
const handles = Array.from({ length: 120 }, (_, i) => `channel_${i}_${(i * 7919).toString(36)}`);

test('the hash and the generator are stable', () => {
  assert.equal(hashHandle('recipes_ua'), hashHandle('recipes_ua'));
  assert.notEqual(hashHandle('recipes_ua'), hashHandle('recipes_ub'));
  const a = seeded(42);
  const b = seeded(42);
  assert.deepEqual([a(), a(), a()], [b(), b(), b()]);
  assert.ok([a(), a(), a()].every((x) => x >= 0 && x < 1));
});

test('the same handle always gets the same sprite; "@" and case do not matter', () => {
  const s = spriteOf('recipes_ua');
  assert.deepEqual(spriteOf('recipes_ua'), s);
  assert.deepEqual(spriteOf('@Recipes_UA'), s);
  assert.deepEqual(spriteOf(' recipes_ua '), s);
});

test('a sprite is 8 by 8, mirrored left to right, with a body and eyes, and has a palette colour', () => {
  for (const h of handles) {
    const s = spriteOf(h);
    assert.equal(s.cells.length, GRID, h);
    for (const row of s.cells) {
      assert.equal(row.length, GRID, h);
      for (let x = 0; x < GRID; x++) assert.equal(row[x], row[GRID - 1 - x], `${h} is symmetric`);
    }
    for (const [x, y] of EYES) assert.equal(s.cells[y][x], true, `${h} has eyes`);
    for (let y = 2; y <= 5; y++) assert.equal(s.cells[y][3], true, `${h} has a body`);
    assert.ok(filledCells(s).length >= 12 && filledCells(s).length <= 56, `${h} is neither a dot nor a block`);
    assert.ok(AVATAR_PALETTE.includes(s.color));
    assert.equal(s.color, AVATAR_PALETTE[s.colorIndex]);
  }
});

test('different handles give different faces, and the palette is used widely', () => {
  const faces = new Set(handles.map((h) => spriteOf(h).cells.map((r) => r.map(Number).join('')).join('/')));
  assert.ok(faces.size >= 100, `${faces.size} distinct faces of ${handles.length}`);
  const colours = new Set(handles.map((h) => spriteOf(h).colorIndex));
  assert.ok(colours.size >= 5, `${colours.size} colours`);
});

test('the palette is theme variables only', () => {
  for (const c of AVATAR_PALETTE) assert.match(c, /^var\(--color-[a-z0-9-]+\)$/);
});

test('every kind carries an accessory inside the margin, with no repeated cell, and the kinds differ', () => {
  const seen = new Set<string>();
  for (const k of KINDS) {
    const acc = accessoryOf(k);
    assert.ok(acc.length >= 4, k);
    const cells = new Set<string>();
    for (const p of acc) {
      assert.ok(p.x >= -1 && p.x <= GRID && p.y >= -1 && p.y <= GRID, `${k} ${p.x},${p.y} is in the margin`);
      assert.ok(p.tone === 'gold' || p.tone === 'ink');
      assert.ok(!cells.has(`${p.x},${p.y}`), `${k} repeats ${p.x},${p.y}`);
      cells.add(`${p.x},${p.y}`);
    }
    seen.add([...cells].sort().join(';'));
  }
  assert.equal(seen.size, KINDS.length);
  assert.deepEqual(Object.keys(ACCESSORIES).sort(), [...KINDS].sort());
});

test('the manager wears the crown (gold), the reviewer glasses (a frame around each eye)', () => {
  assert.ok(accessoryOf('manager').every((p) => p.tone === 'gold'));
  const frame = new Set(accessoryOf('reviewer').map((p) => `${p.x},${p.y}`));
  for (const [x, y] of EYES) assert.equal(frame.has(`${x},${y}`), false, 'the eye stays visible inside the frame');
  assert.ok(frame.has('1,3') && frame.has('3,3') && frame.has('4,3') && frame.has('6,3'));
});
