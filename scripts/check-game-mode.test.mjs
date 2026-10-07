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
  [48, '&kp F8'], [49, '&kp LALT'],
  [52, '&tog 3'], [53, '&none'], [54, '&none'],
  [58, '&kp F8'], [59, '&kp LALT'], [60, '&kp SPACE'],
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

test('left game keys stay plain, Windows keys send F8, Alt stays Left Alt, and TG3 remains reachable under every overlay', () => {
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

test('Media plus dedicated Ctrl toggles audio mute without changing base Ctrl or game protection', () => {
  assert.equal(layers[0].bindings[24], '&kp LCTRL');
  assert.equal(layers[5].bindings[24], '&kp C_MUTE');
  assert.deepEqual(layers[5].bindings.slice(25, 29), [
    '&kp C_VOL_DN', '&kp C_VOL_UP', '&kp C_BRI_DN', '&kp C_BRI_UP',
  ]);
  for (const overlays of overlayStates) {
    if (!overlays.includes(6)) {
      const expected = overlays.includes(5) ? '&kp C_MUTE' : '&kp LCTRL';
      assert.equal(bindingAt(24, activeLayers(overlays)), expected, `overlays ${overlays}`);
    }
    assert.equal(bindingAt(24, activeLayers([3, ...overlays])), '&kp LCTRL',
      `game on, overlays ${overlays}`);
  }
  // The separately accessed keyboard-control layer keeps its existing bootloader key.
  assert.equal(bindingAt(24, activeLayers([5, 6])), '&bootloader');
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

test('Control access is Media then MO1, never the reverse order or Alt', () => {
  assert.equal(layers[5].bindings[60], '&mo 6');
  assert.equal(layers[5].bindings[49], '&trans');
  assert.equal(bindingAt(49, activeLayers([5])), '&kp LALT');
  // Model ZMK's press-time layer selection and matching release, not firmware execution.
  // https://github.com/zmkfirmware/zmk/blob/v0.3.0/app/src/keymap.c
  function sequence(initial = []) {
    const enabled = new Set(initial);
    const held = new Map();
    return {
      active: () => activeLayers([...enabled]),
      press(position) {
        const binding = bindingAt(position, activeLayers([...enabled]));
        held.set(position, binding);
        if (binding.startsWith('&mo ')) enabled.add(Number(binding.split(' ')[1]));
        return binding;
      },
      release(position) {
        const binding = held.get(position);
        assert.ok(binding, `position ${position} must be held`);
        if (binding.startsWith('&mo ')) enabled.delete(Number(binding.split(' ')[1]));
        held.delete(position);
      },
    };
  }
  for (const releaseOrder of [[60, 63], [63, 60]]) {
    const state = sequence();
    assert.equal(state.press(63), '&mo 5');
    assert.equal(state.press(60), '&mo 6');
    assert.deepEqual(state.active(), [6, 5, 0]);
    state.release(releaseOrder[0]);
    assert.deepEqual(state.active(), releaseOrder[0] === 60 ? [5, 0] : [6, 0]);
    state.release(releaseOrder[1]);
    assert.deepEqual(state.active(), [0]);
  }
  const reverse = sequence();
  assert.equal(reverse.press(60), '&mo 1');
  assert.equal(reverse.press(63), '&mo 5');
  assert.deepEqual(reverse.active(), [5, 1, 0]);
  reverse.release(60);
  assert.equal(reverse.press(60), '&mo 6');
  reverse.release(60);
  reverse.release(63);
  assert.deepEqual(reverse.active(), [0]);
  const game = sequence([3]);
  assert.equal(game.press(63), '&mkp MB5');
  assert.equal(game.press(60), '&kp SPACE');
  assert.deepEqual(game.active(), [7, 3, 0]);
});

test('global Studio unlock chord is disabled while explicit layer-6 unlock keys remain', () => {
  const config = readFileSync(new URL('../config/imprint.conf', import.meta.url), 'utf8');
  const settings = config.split(/\r?\n/).filter((line) => /^CONFIG_ZMK_STUDIO_UNLOCK_COMBO=/.test(line));
  assert.deepEqual(settings, ['CONFIG_ZMK_STUDIO_UNLOCK_COMBO=n']);
  assert.doesNotMatch(config, /^CONFIG_ZMK_STUDIO(?:_LOCKING)?=n\s*$/m);
  assert.equal(layers[6].bindings[17], '&studio_unlock');
  assert.equal(layers[6].bindings[18], '&studio_unlock');
  assert.equal(bindingAt(60, activeLayers([5])), '&mo 6');
  assert.equal(bindingAt(17, activeLayers([5, 6])), '&studio_unlock');
});

test('right MO2 stays a layer hold and MO5 sends mouse 5 only in game mode, across every overlay', () => {
  assert.equal(layout[62].row, 7);
  assert.equal(layout[62].col, 9);
  assert.equal(layout[63].row, layout[62].row);
  assert.equal(layout[63].col, layout[62].col + 1);
  assert.deepEqual(layers[0].bindings.slice(62, 64), ['&mo 2', '&mo 5']);
  for (const layer of layers.slice(1, 7)) {
    assert.deepEqual(layer.bindings.slice(62, 64), ['&trans', '&trans'], layer.name);
  }
  assert.deepEqual(layers[7].bindings.slice(62, 64), ['&trans', '&mkp MB5']);
  for (const overlays of overlayStates) {
    const on = activeLayers([3, ...overlays]);
    const off = activeLayers(overlays);
    assert.deepEqual([62, 63].map(position => bindingAt(position, on)), ['&mo 2', '&mkp MB5'],
      `game on, overlays ${overlays}`);
    assert.deepEqual([62, 63].map(position => bindingAt(position, off)), ['&mo 2', '&mo 5'],
      `game off, overlays ${overlays}`);
  }
});

test('MO2 retains right-trackball scroll mapping, scaling, and vertical inversion', () => {
  assert.match(source, /&trackball_peripheral_listener\s*\{\s*scroll_mode\s*\{/);
  const scroll = node('scroll_mode');
  assert.deepEqual(cells(scroll, 'layers'), [2]);
  assert.match(scroll, /input-processors\s*=\s*<&zip_xy_scaler 1 3>,\s*<&zip_xy_to_scroll_mapper>,\s*<&zip_scroll_transform INPUT_TRANSFORM_Y_INVERT>;/);
});

test('other right-hand bindings and global Backspace/Enter chords are not masked by the guard', () => {
  const unchangedRight = right.filter(position => position !== 63);
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
