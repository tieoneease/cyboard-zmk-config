import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { sha256 } from '../companion/lib/files.mjs';

// Packaged-runtime integration, not UI automation and never a real-device test.
export async function smokeCheck(runtime) {
  const { controller, demoBridge, url } = runtime;
  assert.ok(controller.demo && demoBridge, 'smoke must be fixture-only');
  // The initial check is asynchronous. Its owned promise is exposed by the runtime.
  await runtime.initialCheck;
  const page = await fetch(`${url}/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Imprint Workbench/);
  for (const file of ['/app.js', '/styles.css', '/assets/ibm-plex-sans.ttf', '/guide']) {
    const response = await fetch(`${url}${file}`);
    assert.equal(response.status, 200, file);
    assert.ok((await response.arrayBuffer()).byteLength > 0, file);
  }
  // Pause polling during deterministic controller calls; only this demo is touched.
  await runtime.pausePolling();
  for (const side of ['left', 'right']) {
    await demoBridge.connect(side);
    await controller.capture({ side, confirmed: true });
  }
  await controller.prepare();
  await demoBridge.connect('left');
  await controller.arm({ side: 'left', confirmed: true });
  await controller.tick();
  assert.equal(controller.result?.status, 'submitted');
  assert.equal(controller.result.side, 'left');
  const actual = await fs.readFile(path.join(controller.cacheRoot, 'SIMULATED-ASSIMILATOR', 'FLASH.UF2'));
  assert.equal(sha256(actual), controller.prepared.files.left.sha256);
  await controller.tick();
  assert.equal(controller.armed, null);
  return { pass: true, fixtureOnly: true, assets: true, partialCaptures: 2, matchingOneShotSubmission: true };
}
