# Cyboard Imprint Studio migration

## Objective and baseline

Enable live Studio key editing without replacing the existing source-defined keyboard behavior. This is a source-preserving self-build, **not** Cyboard's full vendor firmware with its runtime trackball configurator.

The preserved source baseline is `2506fead2aaf7351f0c2e95adb47f6a3624bf274` (2026-04-23). GitHub Actions run [24838551182](https://github.com/tieoneease/cyboard-zmk-config/actions/runs/24838551182) successfully built both `assimilator-bt` halves. Its artifacts and logs were no longer available on 2026-10-02. This identifies a successful source revision, not the binary presently flashed on a device.

## Preserved behavior

- Seven layers, each with 64 bindings, in the original order. The last 12 positions are the two thumb arcs on each hand.
- Four source-defined 50 ms combos: positions 20+21 for Backspace, 32+33 for Enter, 14+15 for Escape, and 26+27 for Tab.
- Mod-tap assignments and `tap-preferred`, 175 ms tapping term, 150 ms prior-idle requirement.
- Right/peripheral trackball: layer 2 enables XY-to-scroll mapping, 1/3 scaling, and scroll Y inversion.
- Mouse, RGB, Bluetooth, reset/bootloader and existing Studio-unlock bindings.
- Exact Right-Alt-number, Alt-P/N and shifted Alt-P/N outputs used by the Windows desktop setup. No host remapping is added.

Only the chosen layout declaration changes in `config/imprint.keymap`.

## Build and checks

The migration follows the [official template's pre-July-2026 migration](https://github.com/Cyboard-DigitalTailor/zmk-user-config-template#updating-a-config-repo-created-before-july-2026):

- ZMK and reusable workflow: `v0.3.0` (ZMK tag resolved to `edf5c0814fd3ea202e43aad2d68fd32e882a518c` on 2026-10-02).
- Cyboard boards/layouts: `v2026.07` (resolved to `5a0552e9ddc2df919ec491e89102625a1e39324e`). Its imported trackball driver is also tagged `v2026.07`.
- Chosen layout: `physical_layout_imprint_number_row`, which references `imprint_number_row`.
- Studio USB snippet and `CONFIG_ZMK_STUDIO=y`: left/central build only. The right/peripheral remains a matching non-Studio split build.
- `config/info.json` now matches the existing number-row template's 64 positions, rather than the unrelated 82-position editor layout. This JSON is source-editor metadata, not firmware bindings.

Run the one-time source-preservation check from this checkout with Node.js 22 or later:

```sh
node --test scripts/check-studio-port.test.mjs
```

The check compares against the original Git commit. It intentionally rejects later keymap edits; retire or update it when those edits become intentional. It does **not** compile firmware or prove physical position/timing correctness.

Before flashing, both firmware builds must succeed and their UF2 files must be retained locally with source revision and SHA-256 hashes. Keep the original rollback artifacts in a separate directory. Do not use a settings-reset image as part of this migration by default.

After an explicitly approved flash, connect USB to the left half. The existing `&studio_unlock` bindings are on layer 6 (hold layer 5, then the layer-6 key). The pinned shield also documents an A/F-position hold-to-unlock combo. Check every grid and thumb key, layer switching, all four custom combos, mod-tap timing, right-trackball scroll, Windows shortcuts, mouse buttons, and persistence before accepting the migration.

## Backup boundary

The original source plus full Git history must be kept outside this checkout. A source archive is not a binary rollback: the original manifest tracked moving `main` dependencies.

If each real bootloader exposes `CURRENT.UF2`, copying it **off** its drive is read-only. Save each half separately with its `INFO_UF2.TXT`, repeat the read and compare SHA-256 hashes, then inspect the UF2 family, block sequence, vector table and address coverage. Bootloader-derived images may omit part of application space and normally omit settings/pairing data, MBR, UICR and the bootloader itself. Do not describe them as full-chip backups or copy a raw readback back onto a device without reviewing its contents and restore procedure. A single reset press exits bootloader mode without writing firmware.

Do not publish device readbacks: custom bootloaders may expose private configuration. No readback files belong in this repository.

## Decisions

- Keep the complete source-defined behavior as the first reversible Studio experiment. Do not substitute stock vendor firmware while silently losing combos or tap-hold tuning. The full vendor trackball UI remains a separate migration target.
- Pin the supported release pair rather than rebuild the old moving-`main` manifest. A new build is a port, not a reproduction of the April binary.
- Use the actual chosen 64-position layout and preserve binding order; do not use the stale 82-position editor JSON as the hardware definition.
- Do not rely on a temporary Studio build to carry settings into vendor firmware. ZMK persists edited keymap entries, not a full copy of compiled defaults, and firmware-defined combos/behavior properties are not key bindings.
- For full vendor firmware, ordinary bindings could be transferred with device-aware tooling, but no such importer is included here. Preservation of combos and hold-tap properties requires a supported vendor path or explicit acceptance of changed behavior. See [Cyboard's workflow limitations](https://docs.cyboard.digital/user-manual/quick-start/configure-layout).
