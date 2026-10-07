// Source-level regression checks, not a firmware build or hardware timing test.
// Model ZMK v0.3.0's highest-layer combo filter and conditional-layer activation:
// https://github.com/zmkfirmware/zmk/blob/v0.3.0/app/src/combo.c
// https://github.com/zmkfirmware/zmk/blob/v0.3.0/app/src/conditional_layer.c
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../config/imprint.keymap', import.meta.url), 'utf8')
  .replace(/\/\/[^\n]*/g, '');
const layout = JSON.parse(readFileSync(new URL('../config/info.json', import.meta.url), 'utf8'))
  .layouts.Imprint.layout;
const layers = [...source.matchAll(/^\s*(\w+)\s*\{\s*bindings\s*=\s*<([^>]+)>;\s*\};/gm)]
  .map((match) => ({
    name: match[1],
    bindings: match[2].split(/(?=&)/).map((binding) => binding.trim().replace(/\s+/g, ' ')).filter(Boolean),
  }));
const left = layout.flatMap(({ col }, index) => col < 8 ? [index] : []);
const right = layout.flatMap(({ col }, index) => col >= 8 ? [index] : []);
const nonGameLayers = [0, 1, 2, 4, 5, 6];

function node(name) {
  const match = source.match(new RegExp(`\\b${name}\\s*\\{([^{}]*)\\};`));
  assert.ok(match, `missing node ${name}`);
  return match[1];
}

function cells(body, property) {
  const match = body.match(new RegExp(`\\b${property}\\s*=\\s*<([^>]+)>`));
  return match ? match[1].trim().split(/\s+/).map(Number) : null;
}

function activeLayers(active) {
  const state = new Set([0, ...active]);
  const condition = node('game_guard');
  const required = cells(condition, 'if-layers');
  const [target] = cells(condition, 'then-layer');
  if (required.every((layer) => state.has(layer))) state.add(target);
  else state.delete(target);
  return [...state].sort((a, b) => b - a);
}

function bindingAt(position, active) {
  for (const layer of active) {
    const binding = layers[layer].bindings[position];
    if (binding !== '&trans') return binding;
  }
  return '&none';
}

function comboEnabled(name, active) {
  const allowed = cells(node(name), 'layers');
  return allowed === null || allowed.includes(Math.max(...active));
}

// Include every combination of right-hand overlays, including ones held before TG3.
const overlayStates = Array.from({ length: 32 }, (_, mask) =>
  [1, 2, 4, 5, 6].filter((_, bit) => mask & (1 << bit)));
const expectedLeft = new Map([
  [0, '&kp ESC'], [1, '&kp N1'], [2, '&kp N2'], [3, '&kp N3'], [4, '&kp N4'], [5, '&kp N5'],
  [12, '&kp TAB'], [13, '&kp Q'], [14, '&kp W'], [15, '&kp E'], [16, '&kp R'], [17, '&kp T'],
  [24, '&kp LCTRL'], [25, '&kp A'], [26, '&kp S'], [27, '&kp D'], [28, '&kp F'], [29, '&kp G'],
  [36, '&kp LSHFT'], [37, '&kp Z'], [38, '&kp X'], [39, '&kp C'], [40, '&kp V'], [41, '&kp B'],
  [48, '&kp F8'], [49, '&none'],
  [52, '&tog 3'], [53, '&none'], [54, '&none'],
  [58, '&kp F8'], [59, '&none'], [60, '&kp SPACE'],
]);

test('game protection appends one 64-position layer without renumbering existing layers', () => {
  assert.deepEqual(layers.map(({ name }) => name), [
    'default_layer', 'layer_1', 'layer_2', 'game_layer', 'layer_4', 'layer_5', 'keyboard_control',
    'game_guard_layer',
  ]);
  for (const layer of layers) assert.equal(layer.bindings.length, 64, layer.name);
  assert.equal(left.length, 32);
  assert.equal(right.length, 32);
  assert.deepEqual(cells(node('game_guard'), 'if-layers'), [3]);
  assert.deepEqual(cells(node('game_guard'), 'then-layer'), [7]);
  assert.match(source, /compatible\s*=\s*"zmk,conditional-layers"/);
});

test('Escape and Tab chords remain available off and are excluded throughout game mode', () => {
  for (const [name, positions, output] of [
    ['combo_esc', [14, 15], 'ESC'], ['combo_tab', [26, 27], 'TAB'],
  ]) {
    assert.deepEqual(cells(node(name), 'key-positions'), positions);
    assert.deepEqual(cells(node(name), 'timeout-ms'), [50]);
    assert.match(node(name), new RegExp(`bindings\\s*=\\s*<&kp ${output}>`));
    assert.deepEqual(cells(node(name), 'layers'), nonGameLayers);
    for (const overlays of overlayStates) {
      assert.equal(comboEnabled(name, activeLayers(overlays)), true, `${name}: off ${overlays}`);
      assert.equal(comboEnabled(name, activeLayers([3, ...overlays])), false, `${name}: on ${overlays}`);
    }
  }
});

test('left game keys stay plain, Windows keys send F8, Alt stays blocked, and TG3 remains reachable under every overlay', () => {
  assert.deepEqual([...expectedLeft.keys()], left);
  for (const overlays of overlayStates) {
    const active = activeLayers([3, ...overlays]);
    assert.equal(active[0], 7);
    for (const [position, expected] of expectedLeft) {
      assert.equal(bindingAt(position, active), expected, `position ${position}, overlays ${overlays}`);
    }
  }
});

test('turning TG3 off removes protection and restores normal left typing/modifiers', () => {
  for (const overlays of overlayStates) assert.ok(!activeLayers(overlays).includes(7));
  const active = activeLayers([]);
  for (const [position, binding] of [
    [25, '&mt LCTRL A'], [37, '&mt LSHFT Z'],
    [48, '&kp LGUI'], [49, '&kp LALT'], [58, '&kp LGUI'], [59, '&kp LALT'],
    [52, '&tog 3'], [60, '&mo 1'],
  ]) assert.equal(bindingAt(position, active), binding, `position ${position}`);
});

test('keys below comma and period are Left/Right, or Down/Up whenever layer 1 is active', () => {
  for (const [above, below] of [[44, 50], [45, 51]]) {
    assert.equal(layout[below].col, layout[above].col);
    assert.equal(layout[below].row, layout[above].row + 1);
  }
  assert.equal(layers[0].bindings[44], '&kp COMMA');
  assert.equal(layers[0].bindings[45], '&kp DOT');
  assert.deepEqual(layers[0].bindings.slice(50, 52), ['&kp LEFT', '&kp RIGHT']);
  assert.deepEqual(layers[1].bindings.slice(50, 52), ['&kp DOWN', '&kp UP']);
  for (const layer of layers.slice(2)) {
    assert.deepEqual(layer.bindings.slice(50, 52), ['&trans', '&trans'], layer.name);
  }
  for (const overlays of overlayStates) {
    const expected = overlays.includes(1) ? ['&kp DOWN', '&kp UP'] : ['&kp LEFT', '&kp RIGHT'];
    for (const game of [false, true]) {
      const active = activeLayers(game ? [3, ...overlays] : overlays);
      assert.deepEqual([50, 51].map(position => bindingAt(position, active)), expected,
        `game ${game}, overlays ${overlays}`);
    }
  }
});

test('global Studio unlock chord is disabled while explicit layer-6 unlock keys remain', () => {
  const config = readFileSync(new URL('../config/imprint.conf', import.meta.url), 'utf8');
  const settings = config.split(/\r?\n/).filter((line) => /^CONFIG_ZMK_STUDIO_UNLOCK_COMBO=/.test(line));
  assert.deepEqual(settings, ['CONFIG_ZMK_STUDIO_UNLOCK_COMBO=n']);
  assert.doesNotMatch(config, /^CONFIG_ZMK_STUDIO(?:_LOCKING)?=n\s*$/m);
  assert.equal(layers[6].bindings[17], '&studio_unlock');
  assert.equal(layers[6].bindings[18], '&studio_unlock');
  assert.equal(bindingAt(49, activeLayers([5])), '&mo 6');
  assert.equal(bindingAt(17, activeLayers([5, 6])), '&studio_unlock');
});

test('right MO2/MO5 thumbs send mouse 4/5 only in game mode, across every overlay', () => {
  assert.equal(layout[62].row, 7);
  assert.equal(layout[62].col, 9);
  assert.equal(layout[63].row, layout[62].row);
  assert.equal(layout[63].col, layout[62].col + 1);
  assert.deepEqual(layers[0].bindings.slice(62, 64), ['&mo 2', '&mo 5']);
  for (const layer of layers.slice(1, 7)) {
    assert.deepEqual(layer.bindings.slice(62, 64), ['&trans', '&trans'], layer.name);
  }
  assert.deepEqual(layers[7].bindings.slice(62, 64), ['&mkp MB4', '&mkp MB5']);
  for (const overlays of overlayStates) {
    const on = activeLayers([3, ...overlays]);
    const off = activeLayers(overlays);
    assert.deepEqual([62, 63].map(position => bindingAt(position, on)), ['&mkp MB4', '&mkp MB5'],
      `game on, overlays ${overlays}`);
    assert.deepEqual([62, 63].map(position => bindingAt(position, off)), ['&mo 2', '&mo 5'],
      `game off, overlays ${overlays}`);
  }
});

test('other right-hand bindings and global Backspace/Enter chords are not masked by the guard', () => {
  const unchangedRight = right.filter(position => position !== 62 && position !== 63);
  for (const position of unchangedRight) assert.equal(layers.at(-1).bindings[position], '&trans', `position ${position}`);
  for (const overlays of overlayStates) {
    const active = activeLayers([3, ...overlays]);
    for (const position of unchangedRight) {
      assert.equal(bindingAt(position, active), bindingAt(position, active.filter((layer) => layer !== 7)));
    }
  }
  for (const [name, positions, output] of [
    ['combo_bspc', [20, 21], 'BSPC'], ['combo_enter', [32, 33], 'ENTER'],
  ]) {
    assert.deepEqual(cells(node(name), 'key-positions'), positions);
    assert.deepEqual(cells(node(name), 'timeout-ms'), [50]);
    assert.match(node(name), new RegExp(`bindings\\s*=\\s*<&kp ${output}>`));
    assert.equal(cells(node(name), 'layers'), null);
  }
});
