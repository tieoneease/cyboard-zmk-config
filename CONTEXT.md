# Cyboard Imprint source-managed workbench

## Objective and baseline

Keep the custom keyboard configuration in source and use the fork's GitHub builds. The owner now requests delivery through `main` with downloaded per-half UF2 files for manual flashing. The optional guarded workbench remains configured for `migration/studio-preserve-current`; it has not been retargeted to `main`. See [WORKFLOW.md](WORKFLOW.md) for setup, daily use, and recovery boundaries.

The earlier migration enabled standard live Studio key editing while preserving the source definitions. It remains a source-preserving self-build, **not** Cyboard's full vendor firmware with its runtime trackball configurator. The source-managed workflow is now the primary route; live Studio settings are not synchronized into Git.

The preserved source baseline is `2506fead2aaf7351f0c2e95adb47f6a3624bf274` (2026-04-23). GitHub Actions run [24838551182](https://github.com/tieoneease/cyboard-zmk-config/actions/runs/24838551182) successfully built both `assimilator-bt` halves. Its artifacts and logs were no longer available on 2026-10-02. This identifies a successful source revision, not the binary presently flashed on a device.

## Preserved behavior

- Original layers 0–6 retain their indices and 64 bindings. An eighth, automatic game-protection layer is appended at index 7. The last 12 positions are the two thumb arcs on each hand.
- Four source-defined 50 ms combos: positions 20+21 for Backspace and 32+33 for Enter remain global; 14+15 for Escape and 26+27 for Tab are available only outside game mode.
- Mod-tap assignments and `tap-preferred`, 175 ms tapping term, 150 ms prior-idle requirement.
- Right/peripheral trackball: layer 2 enables XY-to-scroll mapping, 1/3 scaling, and scroll Y inversion.
- Mouse, RGB, Bluetooth, reset/bootloader and existing Studio-unlock bindings.
- Exact Right-Alt-number, Alt-P/N and shifted Alt-P/N outputs used by the Windows desktop setup. No host remapping is added.

The original Studio migration changed only the chosen layout declaration in `config/imprint.keymap`. Subsequent changes intentionally add the game protection below and replace the two bracket keys directly below comma/period (positions 50/51) with Left/Right. Whenever layer 1 is active, those positions send Down/Up instead; all higher layers remain transparent there. The layer-1 bracket bindings remain available at their existing positions.

### Game toggle

The existing `&tog 3` left-thumb key still enters and exits game mode. While layer 3 is active, a conditional layer 7 takes precedence over all existing layers on the left: plain letters/numbers, dedicated Ctrl/Shift/Escape/Tab, and thumb Space remain; both left Windows-key positions send plain F8 for game binding, while both left Alt keys and unused thumb keys are blocked with `&none`. This also prevents left-hand desktop shortcuts, media controls, and keyboard-control actions from leaking through while a right-hand layer key is held. The right-thumb MO2 key (position 62) remains a momentary layer-2 hold, preserving right-trackball scrolling in game mode. MO5 immediately to its right (position 63) sends mouse button 5 (`&mkp MB5`). This override lives in layer 7 so higher non-gaming overlays cannot mask it; all other right-hand bindings stay transparent, including MO2 and its two combos. Toggle game mode off to restore MO5 media-layer access and left-hand non-gaming layers.

Escape/Tab combos allow only layers `0 1 2 4 5 6`. [ZMK v0.3.0 filters combos by the highest active layer](https://github.com/zmkfirmware/zmk/blob/v0.3.0/app/src/combo.c), not by whether layer 3 is somewhere in the stack. The automatic layer 7 therefore keeps the exclusion effective even with higher non-gaming layers held, without renumbering saved layer references. Do not toggle layer 7 directly. Release held keys before switching modes; this is not a cancellation mechanism for an already-pressed modifier or an in-flight combo.

The separate Cyboard A+F 3-second Studio-unlock chord is disabled globally with `CONFIG_ZMK_STUDIO_UNLOCK_COMBO=n` in `config/imprint.conf`, as approved by the owner. Its pinned listener has no layer filter, so the game guard alone cannot block it. The module's [Kconfig](https://github.com/Cyboard-DigitalTailor/zmk-keyboards/blob/5a0552e9ddc2df919ec491e89102625a1e39324e/Kconfig) and [CMake gate](https://github.com/Cyboard-DigitalTailor/zmk-keyboards/blob/5a0552e9ddc2df919ec491e89102625a1e39324e/CMakeLists.txt) make this independent of Studio locking and the explicit layer-6 unlock bindings, which remain available.

`npm run test:game` checks the source configuration, all 32 combinations of other layers with game mode on/off, left-side protection/F8 substitution, the gaming-only MO5 mouse-button override and its normal-mode restoration, preserved MO2 access and right-trackball scroll rules, transparency of the remaining right-side bindings, and the arrow pair's layer-1 override. It is also included in `npm test`; it does not run firmware or establish physical timing. Firmware compilation and keyboard acceptance remain required before installation.

## Build and checks

The migration follows the [official template's pre-July-2026 migration](https://github.com/Cyboard-DigitalTailor/zmk-user-config-template#updating-a-config-repo-created-before-july-2026):

- ZMK and reusable workflow: `v0.3.0` (ZMK tag resolved to `edf5c0814fd3ea202e43aad2d68fd32e882a518c` on 2026-10-02).
- Cyboard boards/layouts: `v2026.07` (resolved to `5a0552e9ddc2df919ec491e89102625a1e39324e`). Its imported trackball driver is also tagged `v2026.07`.
- Chosen layout: `physical_layout_imprint_number_row`, which references `imprint_number_row`.
- Studio USB snippet and `CONFIG_ZMK_STUDIO=y`: left/central build only. The right/peripheral remains a matching non-Studio split build.
- `config/info.json` now matches the existing number-row template's 64 positions, rather than the unrelated 82-position editor layout. This JSON is source-editor metadata, not firmware bindings.

Run the one-time source-preservation check from this checkout with Node.js 24 or later:

```sh
node --test scripts/check-studio-port.test.mjs
```

The check compares against the original Git commit. It intentionally rejects later keymap edits; retire or update it when those edits become intentional. It does **not** compile firmware or prove physical position/timing correctness.

Before flashing, both firmware builds must succeed and their UF2 files must be retained locally with source revision and SHA-256 hashes. Keep the original rollback artifacts in a separate directory. Do not use a settings-reset image as part of this migration by default.

After an explicitly approved flash, connect USB to the left half. The existing `&studio_unlock` bindings are on layer 6 (hold layer 5, then the layer-6 key). The shield's A/F-position hold-to-unlock combo is deliberately disabled in this build. Check every grid and thumb key, layer switching, all four custom combos, mod-tap timing, right-trackball scroll, Windows shortcuts, mouse buttons, and persistence before accepting the migration.

## Backup boundary

The original source plus full Git history must be kept outside this checkout. A source archive is not a binary rollback: the original manifest tracked moving `main` dependencies.

If each real bootloader exposes `CURRENT.UF2`, copying it **off** its drive is read-only. Save each half separately with its `INFO_UF2.TXT`, repeat the read and compare SHA-256 hashes, then inspect the UF2 family, block sequence, vector table and address coverage. Bootloader-derived images may omit part of application space and normally omit settings/pairing data, MBR, UICR and the bootloader itself. Do not describe them as full-chip backups or copy a raw readback back onto a device without reviewing its contents and restore procedure. A single reset press exits bootloader mode without writing firmware.

Do not publish device readbacks: custom bootloaders may expose private configuration. No readback files belong in this repository.

## Local workbench

`tools/companion/` is the shared loopback dashboard and safety core. `tools/desktop/` packages it with Electrobun 2.0.2 and the devkit's actual Bun 1.4.0 runtime; end users do not install Node or `gh`. The desktop defaults to read-only and requires a separate per-session confirmation to enable writes, then both distinct labelled partial backups and fresh one-shot per-half arming. Tokens use direct GitHub REST access; Windows is session-only on this pinned runtime, while optional macOS/Linux remembering uses the OS credential store, never plaintext fallback. Source-checkout commands remain available under Node.js 24+: `companion` uses `gh` and is read-only; `companion:flash` explicitly enables the write permission. `companion:demo` confines all operations to temporary synthetic files. Neither implementation changes firmware configuration, authorizes the hosted editor, or pushes source.

Before installation it verifies repository, branch, source SHA, successful run/attempt, artifact digest/length, exact filenames, ZIP CRCs, UF2 family/application boundaries, cached-file hashes, and the connected half's current-image hash. The app freezes the selected image at arming; a later branch update does not silently substitute a different image. TTL and browser-heartbeat checks expire abandoned arms. It does not retry writes automatically or equate disconnect with success.

Private readbacks and build caches are kept outside the Git checkout. Both sides need distinct, explicitly labelled current-image records. Volume labels and FAT serials are not unique side identities. Current-image matching narrows wrong-half risk but is not an atomic hardware identity lock; do not unplug, swap devices, or reset during preflight/writing. Windows/macOS/Linux discovery implementations and tests exist; simulated tests are not physical validation on those platforms.

`npm test` exercises the companion, HTTP/auth boundaries, session permissions and shutdown races. `.github/workflows/companion.yml` runs Node checks on three operating systems; `.github/workflows/desktop.yml` adds Node/Bun tests, native packaging and fixture-only runtime smoke on Windows x64, Apple Silicon macOS, Linux x64 and Linux ARM64. The owner approved publishing this setup on `migration/studio-preserve-current`; current remote job results, not workflow definitions alone, establish CI evidence. Local Windows packaged smoke, direct read-only GitHub retrieval and a synthetic OS credential-store roundtrip are not macOS/Linux or physical keyboard acceptance. The historical baseline test is intentionally not a mandatory gate for deliberate keymap edits.

## Decisions

- Choose Electrobun rather than Electron for a smaller system-webview shell and JavaScript reuse. The owner explicitly needs only Apple Silicon Macs, so its missing Intel Mac release target is acceptable. Use its actual Bun runtime rather than the new Cottontail compatibility runtime; re-prove safety behavior under the exact bundled version. Native builds remain per-host, not cross-platform execution claims from Windows.
- Use a repository-restricted fine-grained token for standalone GitHub access rather than bundle `gh` or invent an OAuth client/service. Remembering access is opt-in OS storage; the separate editor App authorization stays user-controlled. No automatic import of existing `gh` credentials, no plaintext fallback, no automatic updater or release publishing.
- Disable Windows Remember on Bun 1.4.0: source inspection and actual synthetic credential metadata showed its `persist` option is ignored and records use enterprise persistence. Reject silent roaming rather than claim a local-only boundary from a mocked option. Session-only access remains functional; defer a supported local-only adapter or runtime upgrade until it can be tested.
- Fence shutdown before asynchronous preflight can finish; an already-started write refuses normal quit. Keep forced process termination and OS shutdown outside that guarantee. Test socket teardown explicitly because Bun's server-close callback can precede actual connection closure.
- Package unsigned local/test artifacts without weakening OS security. Signing, notice/source-offer review, native CI execution and physical installation are distinct acceptance/release gates.
- Reuse the existing visual editor and GitHub compilation rather than build another editor or attempt to clone private vendor Studio features. Integrate only exact-build retrieval, local readbacks, and guarded per-half UF2 submission. No external flasher source was copied.
- Treat the repository as the master configuration. Source commits require compilation/installation; separate runtime Studio settings can diverge and are not presented as synchronized.
- Retain partial captures as evidence, not as a claimed rollback solution. Require both side records and current-image matching, but keep full recovery and physical acceptance as separate gates. The first hardware installation still needs explicit approval.
- Disable the layer-independent A+F Studio-unlock listener globally rather than allow accidental unlock during gaming or maintain a custom listener fork. The owner approved removing the chord; Studio locking and explicit layer-6 unlock keys remain.
- Append an automatic highest-priority game guard instead of renumbering existing layers or merely excluding layer 3 from combo allow-lists. This preserves existing layer references and right-hand access while preventing higher overlays from re-enabling left-side typing chords or desktop modifiers during gaming.
- Keep the complete source-defined behavior as the first reversible Studio experiment. Do not substitute stock vendor firmware while silently losing combos or tap-hold tuning. The full vendor trackball UI remains a separate migration target.
- Pin the supported release pair rather than rebuild the old moving-`main` manifest. A new build is a port, not a reproduction of the April binary.
- Use the actual chosen 64-position layout and preserve binding order; do not use the stale 82-position editor JSON as the hardware definition.
- Do not rely on a temporary Studio build to carry settings into vendor firmware. ZMK persists edited keymap entries, not a full copy of compiled defaults, and firmware-defined combos/behavior properties are not key bindings.
- For full vendor firmware, ordinary bindings could be transferred with device-aware tooling, but no such importer is included here. Preservation of combos and hold-tap properties requires a supported vendor path or explicit acceptance of changed behavior. See [Cyboard's workflow limitations](https://docs.cyboard.digital/user-manual/quick-start/configure-layout).
