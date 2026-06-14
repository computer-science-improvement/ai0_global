import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseNum, splitIngredients, splitSteps, imageDataUrl } from './carousel-text';

test('parseNum: numeric strings → number, junk/null → null', () => {
  assert.equal(parseNum('84.55'), 84.55);
  assert.equal(parseNum('120'), 120);
  assert.equal(parseNum(null), null);
  assert.equal(parseNum(''), null);
  assert.equal(parseNum('abc'), null);
});

test('splitIngredients: splits on newlines / bullets / semicolons, trims, drops empties', () => {
  assert.deepEqual(splitIngredients('Картопля — 1 кг\n• Масло — 100 г\n\nСіль'),
    ['Картопля — 1 кг', 'Масло — 100 г', 'Сіль']);
  assert.deepEqual(splitIngredients('Цукор; Борошно;'), ['Цукор', 'Борошно']);
  assert.deepEqual(splitIngredients(''), []);
});

test('splitSteps: splits numbered or newline steps, strips leading numbering', () => {
  assert.deepEqual(splitSteps('1. Розтопіть масло.\n2. Додайте картоплю.'),
    ['Розтопіть масло.', 'Додайте картоплю.']);
  assert.deepEqual(splitSteps('Помити.\nПорізати.'), ['Помити.', 'Порізати.']);
  assert.deepEqual(splitSteps(''), []);
});

test('imageDataUrl: sniffs PNG vs JPEG magic bytes', () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]);
  const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);
  assert.match(imageDataUrl(png), /^data:image\/png;base64,/);
  assert.match(imageDataUrl(jpg), /^data:image\/jpeg;base64,/);
});
