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
    'game_guard_layer', 'game_media_layer',
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

test('Media plus J/K sends F19/F20 for host playback-device cycling, and only on the two media layers', () => {
  assert.deepEqual(layers[5].bindings.slice(31, 33), ['&kp F19', '&kp F20']);
  assert.deepEqual(layers[8].bindings.slice(31, 33), ['&kp F19', '&kp F20']);
  assert.ok(right.includes(31) && right.includes(32));
  for (const layer of [...layers.slice(0, 5), ...layers.slice(6, 8)]) {
    for (const position of [31, 32]) {
      assert.notEqual(layer.bindings[position], '&kp F19', `${layer.name} ${position}`);
      assert.notEqual(layer.bindings[position], '&kp F20', `${layer.name} ${position}`);
    }
  }
  assert.deepEqual([31, 32].map((position) => bindingAt(position, activeLayers([]))), ['&kp J', '&kp K']);
  // Game mode owns J as Mouse 5; MO5 is Mouse 5 there too, so layer 5 is only reachable if held before TG3.
  assert.deepEqual([31, 32].map((position) => bindingAt(position, activeLayers([3]))), ['&mkp MB5', '&kp K']);
  assert.deepEqual([31, 32].map((position) => bindingAt(position, activeLayers([3, 5]))), ['&mkp MB5', '&kp F20']);
  for (const overlays of overlayStates) {
    const actual = [31, 32].map((position) => bindingAt(position, activeLayers(overlays)));
    // Keyboard control sits above Media and keeps its RGB keys there.
    if (overlays.includes(6)) assert.deepEqual(actual, ['&rgb_ug RGB_HUD', '&rgb_ug RGB_SAD'], `overlays ${overlays}`);
    else if (overlays.includes(5)) assert.deepEqual(actual, ['&kp F19', '&kp F20'], `overlays ${overlays}`);
    else assert.notDeepEqual(actual, ['&kp F19', '&kp F20'], `overlays ${overlays}`);
  }
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
  assert.equal(game.press(63), '&mo 8');
  assert.equal(game.press(60), '&kp SPACE');
  assert.deepEqual(game.active(), [8, 7, 3, 0]);
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

test('right MO2 stays a layer hold and MO5 holds the game-mode media layer only in game mode, across every overlay', () => {
  assert.equal(layout[62].row, 7);
  assert.equal(layout[62].col, 9);
  assert.equal(layout[63].row, layout[62].row);
  assert.equal(layout[63].col, layout[62].col + 1);
  assert.deepEqual(layers[0].bindings.slice(62, 64), ['&mo 2', '&mo 5']);
  for (const layer of [...layers.slice(1, 7), layers[8]]) {
    assert.deepEqual(layer.bindings.slice(62, 64), ['&trans', '&trans'], layer.name);
  }
  assert.deepEqual(layers[7].bindings.slice(62, 64), ['&trans', '&mo 8']);
  for (const overlays of overlayStates) {
    const on = activeLayers([3, ...overlays]);
    const off = activeLayers(overlays);
    assert.deepEqual([62, 63].map(position => bindingAt(position, on)), ['&mo 2', '&mo 8'],
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

test('game mode turns H, J and the right Space thumb into right click, Mouse 5 and Mouse 4 under every overlay', () => {
  const buttons = new Map([[30, '&mkp RCLK'], [31, '&mkp MB5'], [61, '&mkp MB4']]);
  for (const position of buttons.keys()) assert.ok(right.includes(position), `position ${position}`);
  assert.deepEqual([30, 31, 61].map((position) => layers[0].bindings[position]), ['&kp H', '&kp J', '&kp SPACE']);
  assert.equal(layers[7].bindings[60], '&kp SPACE', 'left Space thumb stays the jump key');
  for (const layer of layers.slice(0, 7)) {
    for (const [position, binding] of buttons) assert.notEqual(layer.bindings[position], binding, `${layer.name} ${position}`);
  }
  for (const overlays of overlayStates) {
    const on = activeLayers([3, ...overlays]);
    const off = activeLayers(overlays);
    for (const [position, binding] of buttons) {
      assert.equal(bindingAt(position, on), binding, `game on, position ${position}, overlays ${overlays}`);
      assert.notEqual(bindingAt(position, off), binding, `game off, position ${position}, overlays ${overlays}`);
    }
  }
  // Layer 2 puts tab-switching macros on H/J; holding MO2 to scroll must not leak them while gaming.
  assert.deepEqual([30, 31].map((position) => bindingAt(position, activeLayers([2]))), ['&kp LC(LS(PG_UP))', '&kp LC(LS(TAB))']);
  assert.deepEqual([30, 31].map((position) => bindingAt(position, activeLayers([3, 2]))), ['&mkp RCLK', '&mkp MB5']);
});

test('holding MO5 in game mode gives the layer-5 media cluster and J/K audio keys without lifting the guard elsewhere', () => {
  const media = new Map([
    [24, '&kp C_MUTE'], [25, '&kp C_VOL_DN'], [26, '&kp C_VOL_UP'], [27, '&kp C_BRI_DN'], [28, '&kp C_BRI_UP'],
    [31, '&kp F19'], [32, '&kp F20'],
  ]);
  for (const [position, binding] of media) assert.equal(layers[5].bindings[position], binding, `layer 5 ${position}`);
  for (let position = 0; position < 64; position++) {
    assert.equal(layers[8].bindings[position], media.get(position) ?? '&trans', `layer 8 ${position}`);
  }
  // Layer 8 is reachable only through the guard's MO5; it never activates from a normal-mode binding.
  for (const layer of layers.filter((_, index) => index !== 7)) {
    assert.ok(!layer.bindings.some((binding) => binding === '&mo 8' || binding === '&tog 8' || binding === '&to 8'), layer.name);
  }
  for (const overlays of overlayStates) {
    const held = activeLayers([3, 8, ...overlays]);
    const released = activeLayers([3, ...overlays]);
    assert.equal(held[0], 8);
    for (let position = 0; position < 64; position++) {
      const expected = media.has(position) ? media.get(position) : bindingAt(position, released);
      assert.equal(bindingAt(position, held), expected, `position ${position}, overlays ${overlays}`);
    }
    // Media held while gaming: letters stay guarded, mouse buttons stay, keyboard control stays blocked.
    assert.equal(bindingAt(14, held), '&kp W');
    assert.equal(bindingAt(30, held), '&mkp RCLK');
    assert.equal(bindingAt(61, held), '&mkp MB4');
    assert.equal(bindingAt(60, held), '&kp SPACE');
    assert.equal(bindingAt(29, held), '&kp G');
    for (const name of ['combo_esc', 'combo_tab']) assert.equal(comboEnabled(name, held), false, name);
  }
});

test('other right-hand bindings and global Backspace/Enter chords are not masked by the guard', () => {
  const unchangedRight = right.filter(position => ![30, 31, 61, 63].includes(position));
  for (const position of unchangedRight) assert.equal(layers[7].bindings[position], '&trans', `position ${position}`);
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
