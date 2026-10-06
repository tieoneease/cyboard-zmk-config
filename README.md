# Cyboard Imprint Workbench

Your configuration, kept in source: **visual editor → GitHub build → guarded per-half UF2 installation**.

This fork retains the original seven-layer, 64-key Imprint configuration, with an eighth automatic layer protecting the left side during game mode. Custom combos and hold-taps, Windows shortcuts, and right-trackball source rules remain available outside game mode. See [Game mode](WORKFLOW.md#game-mode) for the toggle's scope. The global A+F Studio-unlock chord is disabled; explicit layer-6 unlock keys remain. It targets `migration/studio-preserve-current` and leaves `main` unchanged.

## Desktop app

The app uses **Electrobun with a bundled Bun runtime and system webview**. Users do not install Node.js or GitHub CLI.

- **Windows 11 x64:** extract the whole Setup ZIP, keeping its hidden `.installer` folder, then run **Imprint Workbench-Setup.exe**.
- **macOS 14+ Apple Silicon:** DMG. No Intel Mac target.
- **Linux x64 / ARM64:** installer archive; requires the documented GTK/WebKit runtime libraries.

**Delivery status:** a local Windows package and packaged-runtime smoke check are verified. The setup lives on `migration/studio-preserve-current`; check [Desktop packages](https://github.com/tieoneease/cyboard-zmk-config/actions/workflows/desktop.yml) for native CI results and installer artifacts. macOS/Linux acceptance requires those native jobs to pass. Test packages are unsigned. Signing, public release, and physical keyboard acceptance remain separate gates.

The desktop window starts **read-only**. Public build checks work without a credential. Connect a fine-grained GitHub token restricted to this repository for downloads; Actions write is optional for Rebuild. Windows access is session-only in this build. On macOS/Linux, remembering access in the OS credential store is opt-in. This is separate from the visual editor's GitHub App authorization.

- **[Setup, daily workflow, backups and recovery](WORKFLOW.md)**
- **[Desktop builds, supported targets and release gates](tools/desktop/README.md)**
- **[Configuration baseline and decisions](CONTEXT.md)**
- [Visual ZMK Keymap Editor](https://nickcoutsos.github.io/keymap-editor/)
- [Firmware builds](https://github.com/tieoneease/cyboard-zmk-config/actions/workflows/build.yml)

## Source-checkout fallback

Requires **Node.js 24+** and authenticated **GitHub CLI**. No local firmware compiler is needed.

```sh
npm ci --ignore-scripts
gh auth status
npm run companion
```

Open **http://127.0.0.1:4765**. On Windows, [`scripts/start-companion.cmd`](scripts/start-companion.cmd) also starts it after dependencies are installed.

```sh
npm run companion:demo   # temporary simulated devices; no GitHub or host-volume scans
npm test                # game-mode source checks, validation and safety checks
npm run desktop:build   # native desktop package for this host
npm run desktop:smoke   # packaged fixture-only check; needs a desktop/display
```

The helper downloads the exact current build, verifies provenance/digests/UF2 structure, records private partial readbacks, and requires fresh, explicit one-shot arming for each half. Desktop hardware-write permission is a separate per-session confirmation; the source fallback uses `npm run companion:flash`. Neither gate starts an installation by itself.

**Safety boundary:** no physical installation is established by software tests. Partial readbacks are not full or restore-tested rollback images. A completed copy is reported as submitted, not proof of correct keyboard behavior. Read the guide before enabling writes.

## Firmware distinction

This is a source-preserving ZMK self-build with standard Studio support. It is **not** Cyboard's full vendor firmware and does not add the vendor-only live trackball configuration GUI. The repository is the source of truth; separate live Studio edits are not synchronized back into it.

The historical migration guard remains available as `npm run test:baseline`. It compares against the April source and intentionally fails after deliberate keymap edits; it is not the normal ongoing keymap CI rule.
