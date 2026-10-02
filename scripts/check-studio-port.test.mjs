// One-time migration guard against the April 23 source baseline.
// Intentional future keymap changes require retiring/updating this baseline check.
// This checks source preservation, not compilation or physical keyboard behavior.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
const baseline = '2506fead2aaf7351f0c2e95adb47f6a3624bf274';
const normalize = (text) => text.replace(/\r\n/g, '\n');
const read = (path) => normalize(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'));
const original = (path) => normalize(execFileSync('git', ['show', `${baseline}:${path}`], {
  cwd: root,
  encoding: 'utf8',
}));

test('all bindings, combos, mod-tap properties and trackball code remain unchanged', () => {
  const oldChosen = 'chosen { zmk,matrix-transform = &imprint_number_row; };';
  const newChosen = 'chosen { zmk,physical-layout = &physical_layout_imprint_number_row; };';
  assert.equal(original('config/imprint.keymap').split(oldChosen).length, 2);
  assert.equal(read('config/imprint.keymap'), original('config/imprint.keymap').replace(oldChosen, newChosen));
});

test('all seven layers have 64 ordered bindings with the original last twelve thumb bindings', () => {
  const extract = (text) => [...text.matchAll(/^\s*(\w+)\s*\{\s*bindings\s*=\s*<([^>]+)>;\s*\};/gm)]
    .map((match) => ({ name: match[1], bindings: match[2].split(/(?=&)/).map((binding) => binding.trim()).filter(Boolean) }));
  const layers = extract(read('config/imprint.keymap'));
  const oldLayers = extract(original('config/imprint.keymap'));
  assert.deepEqual(layers.map((layer) => layer.name), [
    'default_layer', 'layer_1', 'layer_2', 'game_layer', 'layer_4', 'layer_5', 'keyboard_control',
  ]);
  layers.forEach((layer, index) => {
    assert.equal(layer.bindings.length, 64, layer.name);
    assert.deepEqual(layer.bindings.slice(-12), oldLayers[index].bindings.slice(-12), layer.name);
  });
});

test('source-editor metadata matches the original 64-position number-row template', () => {
  const layout = JSON.parse(read('config/info.json'));
  const template = JSON.parse(original('config/default keymaps/imprint_number_row/info.json'));
  assert.deepEqual(layout, template);
  const positions = layout.layouts.Imprint.layout;
  assert.equal(positions.length, 64);
  assert.equal(new Set(positions.map(({ row, col }) => `${row},${col}`)).size, 64);
  assert.ok(positions.slice(-12).every(({ row }) => row === 6 || row === 7));
});

test('Studio USB is enabled only for the original left central build', () => {
  const expected = original('build.yaml').replace(
    '  - board: assimilator-bt\n    shield: imprint_left',
    '  # Only the left (central) half exposes Studio over USB.\n' +
      '  - board: assimilator-bt\n    shield: imprint_left\n' +
      '    snippet: studio-rpc-usb-uart\n    cmake-args: -DCONFIG_ZMK_STUDIO=y',
  );
  assert.equal(read('build.yaml'), expected);
});

test('firmware and board dependencies are pinned to the supported stable template', () => {
  const expected = original('config/west.yml')
    .replace('      revision: main\n      import: app/west.yml',
      '      # Match Cyboard\'s supported stable Studio template.\n      revision: v0.3.0\n      import: app/west.yml')
    .replace('      revision: main\n      import: config/west.yml',
      '      # Freeze the physical layouts and the transitive trackball driver.\n      revision: v2026.07\n      import: config/west.yml');
  assert.equal(read('config/west.yml'), expected);
});

test('the reusable workflow matches the firmware release', () => {
  const expected = original('.github/workflows/build.yml').replace(
    'build-user-config.yml@main', 'build-user-config.yml@v0.3.0',
  );
  assert.equal(read('.github/workflows/build.yml'), expected);
});

test('the existing RGB configuration is unchanged', () => {
  assert.equal(read('config/imprint.conf'), original('config/imprint.conf'));
});
