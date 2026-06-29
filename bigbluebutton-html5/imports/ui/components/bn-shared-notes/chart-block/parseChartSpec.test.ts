import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseChartSpec } from './parseChartSpec';

test('valid pie spec is accepted', () => {
  const result = parseChartSpec('{"type":"pie","data":[{"label":"Yes","value":12},{"label":"No","value":5}]}');
  assert.equal(result.ok, true);
  assert.ok(result.ok && result.value.type === 'pie');
  assert.deepEqual(result.ok && result.value.data, [
    { label: 'Yes', value: 12 },
    { label: 'No', value: 5 },
  ]);
});

test('valid scatter spec is accepted, label optional', () => {
  const result = parseChartSpec('{"type":"scatter","data":[{"x":1,"y":4,"label":"p1"},{"x":2,"y":9}]}');
  assert.equal(result.ok, true);
  assert.ok(result.ok && result.value.type === 'scatter');
  assert.deepEqual(result.ok && result.value.data, [
    { x: 1, y: 4, label: 'p1' },
    { x: 2, y: 9 },
  ]);
});

test('scatter requires both x and y; entries missing either are dropped', () => {
  const result = parseChartSpec('{"type":"scatter","data":[{"x":1},{"y":2},{"x":3,"y":4}]}');
  assert.equal(result.ok, true);
  assert.deepEqual(result.ok && result.value.data, [{ x: 3, y: 4 }]);
});

test('scatter drops a non-string label but keeps the point', () => {
  const result = parseChartSpec('{"type":"scatter","data":[{"x":1,"y":2,"label":5}]}');
  assert.equal(result.ok, true);
  assert.deepEqual(result.ok && result.value.data, [{ x: 1, y: 2 }]);
});

test('pie entries with missing or wrong-typed fields are dropped', () => {
  const result = parseChartSpec('{"type":"pie","data":[{"label":"A","value":3},{"label":"","value":1},{"label":"B"},{"value":2},{"label":"C","value":"x"}]}');
  assert.equal(result.ok, true);
  assert.deepEqual(result.ok && result.value.data, [{ label: 'A', value: 3 }]);
});

test('pie rejects negative and non-finite values, keeps zero', () => {
  const result = parseChartSpec('{"type":"pie","data":[{"label":"neg","value":-1},{"label":"zero","value":0}]}');
  assert.equal(result.ok, true);
  assert.deepEqual(result.ok && result.value.data, [{ label: 'zero', value: 0 }]);
});

test('empty data yields a "No data" error', () => {
  const result = parseChartSpec('{"type":"pie","data":[]}');
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.error === 'No data');
});

test('empty spec string yields a "No data" error', () => {
  const result = parseChartSpec('   ');
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.error === 'No data');
});

test('malformed JSON yields an "Invalid JSON" error', () => {
  const result = parseChartSpec('{type:pie}');
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.error === 'Invalid JSON');
});

test('unknown chart type is rejected', () => {
  const result = parseChartSpec('{"type":"bar","data":[]}');
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.error === 'Unknown chart type');
});

test('non-array data is rejected', () => {
  const result = parseChartSpec('{"type":"pie","data":{}}');
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.error === '"data" must be an array');
});

test('a top-level array (not an object) is rejected', () => {
  const result = parseChartSpec('[]');
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.error === 'Spec must be an object');
});
