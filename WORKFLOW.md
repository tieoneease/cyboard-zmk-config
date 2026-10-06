# Your Imprint: edit → build → install

This is the source-managed workflow for `tieoneease/cyboard-zmk-config`. It reuses **ZMK Keymap Editor**, the existing **GitHub Actions firmware build**, and a small **local UF2 workbench**. It does not substitute Cyboard's stock firmware or attempt to recreate its private Studio extensions.

**Current delivery:** the owner uses successful `main` firmware builds and manually flashes the downloaded left/right UF2 files. The optional workbench/editor setup below still targets `migration/studio-preserve-current`; it is not the delivery path for newer `main`-only changes. Match every download to the intended source commit.

The source configuration remains in `config/imprint.keymap`. Original layers 0–6, four combos, custom hold-tap timing, Windows shortcuts, and the right-trackball source rules are retained outside game mode. An eighth automatic layer protects the left side while the existing game toggle is active; see [Game mode](#game-mode). Physical equivalence of the new firmware is still a hardware-validation task.

## One-time setup

### 1. Install the desktop app

The **Electrobun desktop package bundles its own Bun runtime**. You do not need Node.js, Git, GitHub CLI, or a local firmware compiler to use it. The editor and firmware compilation remain hosted services.

| Platform | Package and prerequisites |
|---|---|
| Windows 11 x64 | Extract the entire `win-x64-ImprintWorkbench-Setup.zip`, then run **Imprint Workbench-Setup.exe**. Keep its hidden `.installer` folder beside Setup; the EXE alone is not the whole installer. Uses the Microsoft WebView2 Runtime. Windows ARM can use x64 emulation; it is not a separately validated native target. |
| macOS 14+ Apple Silicon | Open `macos-arm64-ImprintWorkbench.dmg` and copy the app to Applications. Intel Macs are not supported by the pinned Electrobun release. |
| Linux x64 / ARM64 | Extract the matching `linux-<arch>-ImprintWorkbench-Setup.tar.gz`, then run `./installer` as your normal user. Ubuntu 24.04 is the baseline; GTK 3, WebKitGTK 4.1, Ayatana AppIndicator, and librsvg runtime packages are required. |

**Current delivery boundary:** the setup is on `migration/studio-preserve-current`. A Windows package has been built and its bundled-runtime smoke check exercised. Check [Desktop packages](https://github.com/tieoneease/cyboard-zmk-config/actions/workflows/desktop.yml) for current native CI results and installer artifacts; macOS/Linux acceptance requires their native jobs to pass. Do not assume an installer exists for an incomplete or failed job. See [tools/desktop/README.md](tools/desktop/README.md) for developer builds and release requirements.

Local packages are unsigned unless signing credentials are explicitly configured. Windows may display an unknown-publisher warning; public macOS distribution needs Developer ID signing and notarization. Do not disable SmartScreen, Gatekeeper, browser security, or the Linux sandbox to make a package run. Signing and public publication are separate release gates, not provided by a successful local build.

Launch **Imprint Workbench**. Each launch starts in **read-only hardware mode**, on an automatically assigned loopback port inside the desktop window. It does not enable writes, arm an installation, authorize the editor, or dispatch a build.

### 2. Connect GitHub access in the desktop app

Public source/build checks can run without credentials. Firmware downloads need authenticated Actions access; Rebuild additionally needs Actions write permission.

1. Expand **GitHub access**, then open GitHub's **fine-grained token settings** in your browser. Create and approve the token yourself; never enter your GitHub password in this app.
2. Restrict repository access to **only `tieoneease/cyboard-zmk-config`**. Select **Contents: Read-only** and **Actions: Read-only**. Choose **Actions: Read and write** instead only if you intend to use Rebuild. Set an expiry you will maintain.
3. Paste the token into **Fine-grained token**, then select **Connect**. The field is cleared before the request completes. The app checks the account and workflow access before replacing the current credential. This cannot prove Actions write permission without an actual Rebuild request.
4. **Windows: access is session-only**, and Remember is disabled. The pinned runtime cannot enforce local-computer-only Windows credential storage, so the app does not read or write that store. On **macOS/Linux**, Remember is optional and unchecked by default; it uses macOS Keychain or Linux Secret Service. A locked/missing keyring can prevent remembering; explicitly choose session-only access instead. Without Remember, the token stays in memory only until quit. There is no plaintext fallback.
5. Use **Check now** to refresh the build with the connected token. A saved token loaded at launch is labelled unverified until you select **Verify saved token**. **Disconnect** clears in-memory access and attempts to remove this app's saved record; a failed removal is reported, not hidden.

The desktop app does not automatically import an existing `gh` login. OS storage protects credentials at rest, not against hostile software running as your user. Do not commit tokens or publish the private cache. The visual editor's separate GitHub App consent is still yours to grant.

### Source-checkout fallback

For development, or when no desktop package is available, install Node.js 24+, Git, and GitHub CLI. Clone the prepared branch:

```sh
git clone --branch migration/studio-preserve-current https://github.com/tieoneease/cyboard-zmk-config.git
cd cyboard-zmk-config
npm ci --ignore-scripts
gh auth status
npm run companion
```

Complete `gh auth login` yourself if necessary. This fallback delegates authentication to `gh`, rather than using the desktop token form. Open **http://127.0.0.1:4765** or the printed address. `scripts/start-companion.cmd` (Windows) and `sh scripts/start-companion.sh` (macOS/Linux) also launch it. Keep using `127.0.0.1`, not a reverse proxy or tunnel. This optional fallback still follows the migration branch rather than the current manual-delivery branch, `main`.

### 3. Connect the visual editor

Open https://nickcoutsos.github.io/keymap-editor/ in Chrome or Edge.

1. Select **GitHub** as the source.
2. Complete the GitHub authorization/installation yourself. Grant the editor access to **only `tieoneease/cyboard-zmk-config`**, not unrelated repositories.
3. Select that repository and the **`migration/studio-preserve-current`** branch in the editor's branch picker. Do not leave it on `main`.
4. Confirm the loaded keymap is `config/imprint.keymap` (choose it if prompted). The matching `config/info.json` describes your **64-position number-row layout**.
5. Confirm eight layers (the original seven plus automatic `game_guard_layer`), the thumb-key order, and the four combos before saving a change. Preserve the conditional rule from layer 3 to layer 7 and the Escape/Tab combo layer restrictions.

The editor's source supports selecting and committing to non-default branches. Its initial default can still be `main`; branch selection matters. Before the migration was merged, `main` had stale 82-position metadata; current `main` has the corrected 64-position profile too.

The isolated pre-setup browser check loaded a copy of this keymap and metadata and confirmed seven layers, 64 positions, four combos, and editable `tap-preferred` / 175 ms / 150 ms Mod-Tap settings. A temporary timing edit and restore left the right-trackball source expressions present. This was not a new compile or a complete round-trip proof.

**Privacy/authorization:** the hosted editor is a third-party GitHub integration. Only you grant that access. The local workbench cannot and does not click through consent. For a no-OAuth alternative, use the editor's File System source on your local config, review changes with `git diff`, then commit and push them yourself. A local save without a push does not update GitHub's build.

### 4. Check the session mode

Confirm the header says **Read-only hardware**. This permits authenticated build requests/downloads and read-only device captures, but cannot flash hardware. The app binds only to IPv4 loopback, not your LAN.

Close the desktop window to end the session; closing cancels pending arming/preflight. Once **Writing firmware** begins, normal desktop close/quit is refused until a result is available. In the source fallback, use Ctrl+C when no write is active. Forced termination, power loss, and OS shutdown cannot be made safe by these guards.

## Daily edit/build flow

1. Open the visual editor from the workbench. Make the desired source changes and **Save** them to the configured branch.
2. GitHub Actions automatically compiles both halves on a push. No local ZMK toolchain or Docker installation is needed.
3. **Check now** refreshes immediately. Connected sessions also check GitHub periodically when idle; the signed-out desktop makes a public check at startup rather than exhausting GitHub's lower anonymous rate limit. The source commit and run link identify exactly what is being built.
4. When the current commit's build succeeds, choose **Download & verify firmware**.
5. The app downloads the `firmware` artifact for that exact run, checks GitHub's size and SHA-256 digest, validates the ZIP and both UF2s, then caches the files privately.

Only use **Rebuild current commit** when you intend to trigger a GitHub Actions run. It is available even in read-only hardware mode; that mode restricts device writes, not GitHub workflow dispatch.

**Rebuild current commit** dispatches the existing workflow on the configured branch. It does not commit or push local changes. Failed, incomplete, expired, unrelated-branch, fork/PR, mismatched-commit, or malformed artifacts cannot become installation inputs. A newer build attempt must be prepared before installation; the app does not silently fall back to an old success.

The two accepted files are:

- `imprint_left-assimilator-bt-zmk.uf2`
- `imprint_right-assimilator-bt-zmk.uf2`

Settings-reset images, bootloader images, and raw device readbacks are not normal installation inputs. Structural UF2 validation alone cannot identify everything a firmware program does; the fixed filenames and exact trusted-repository/build provenance are also essential.

## Before the first hardware installation

**Do not treat this document as confirmation that rollback is complete.** The earlier preservation work captured the left half only. The right-half readback was still pending when this setup started. Existing backups under `Documents/Keyboard Backups/Cyboard-Imprint` are retained separately; this app does not import or overwrite them.

The workbench requires a fresh pair of its own partial readback records before arming installation:

1. Leave only one half connected in bootloader mode. Select its physical **Left** or **Right** identity in the app and confirm it explicitly.
2. Double-tap the reset button next to the USB-C port. A compatible `ASSIMILATOR` volume should appear. Your source also contains per-half `&bootloader` bindings on keyboard-control layer 6; the physical reset method does not depend on a working keymap.
3. Click **Capture left backup** or **Capture right backup**. This reads `CURRENT.UF2` twice, requires identical bytes and valid UF2 blocks, and saves both reads plus metadata outside the repo. It writes nothing to the device.
4. Single-tap reset to leave bootloader mode; repeat for the other half. Confirmation is consumed by each capture and arm action, and cleared when the app detects a changed connection. Select and confirm the physical half again; a remembered drive label is not identity.

An existing side record is never replaced silently. The **Replace the saved … identity record** checkbox and **Replace … backup** button explicitly authorize a new capture while keeping earlier files. If an image is already labelled as the other half, stop and verify the physical half and saved labels. Do not swap cables just to make that warning disappear.

These readbacks **may exclude settings, Bluetooth bonds, application-tail regions, the MBR, bootloader, UICR, and other chip data**. They are not full-chip backups and have not been restore-tested. Never copy raw `CURRENT.UF2` back onto the keyboard without reviewing the address coverage and restore procedure.

The same volume name, drive letter, bootloader board ID, or FAT volume serial can appear on both halves. The app does not infer left/right from those values. It records your explicit identification and, before writing, compares the connected device's current image with that side's saved readback. Identical images cannot safely identify two different halves, so such an ambiguous capture is rejected.

## Install when you explicitly choose to

**Desktop:** acknowledge the separate session-write confirmation, then select **Enable hardware writes**. This only grants permission for this session; it does not arm or start an installation. **Return to read-only** is available when no job or arm is active. Restart always returns to read-only.

**Source fallback:** close the read-only workbench and run `npm run companion:flash` instead. This explicit launch mode also does not arm anything.

The first physical installation still needs explicit approval after reviewing both real partial captures and recovery limits; a software rehearsal is not that approval.

1. **Prepare** the desired current successful build in this session.
2. Select the physical half and freshly confirm the backup limitation. A previous capture does not leave confirmation active for installation. The replacement checkbox is only for making a new backup, not for arming. Keep only one half in bootloader mode.
3. Click **Arm left install** or **Arm right install**. This authorizes **one installation of the displayed commit to the selected half**.
4. Connect that half and enter bootloader mode if it is not there already. The app checks its current image against the selected backup and submits the matching UF2 automatically.
5. Once writing starts, **do not unplug, reset, or close the process**. Cancellation is only available before writing begins.
6. Check the result and test the half. Repeat explicitly for the other half.

Arming freezes the verified commit; a later branch update does not silently substitute a different image. Cancel and prepare again if you want that new build. Arming expires after two minutes and is cancelled when the browser stops renewing its short heartbeat lease. Merely launching the app, entering bootloader mode, downloading a build, or capturing a backup does not authorize flashing. Each half needs its own arm action. A submitted transfer never causes an automatic second write.

**Result meanings:**

- **Submitted:** all file-write/sync/close calls completed. This is not proof of successful execution or hardware parity.
- **Unverified:** an error or disconnect occurred after writing began. Bootloader resets can interrupt OS acknowledgements, but the app does not assume success. Test the keyboard before deciding what to do; no automatic retry occurs.
- **Not written:** the destination could not be opened safely or a precondition failed. Correct the issue, then explicitly arm again.

After an installation changes a half's current image, explicitly replace that half's saved identity record with a new capture before a future installation. Earlier captures remain in their own timestamped private folders. A mismatch is a stop condition, not a reason to bypass the check.

## Game mode

Use the existing left-thumb **TG3** key to toggle game mode. Layer 3 automatically enables the highest-priority protection layer 7; do not activate layer 7 directly.

- **Disabled on the left:** W+E → Escape, S+D → Tab, A/Ctrl and Z/Shift mod-taps, Windows/Alt modifier outputs, and non-gaming actions from higher layers.
- **Game-bindable key:** both left Windows-key positions send plain **F8** while gaming, even with other layers held. Outside game mode they keep their normal Windows bindings. Both left Alt keys remain blocked while gaming.
- **Kept on the left:** plain letters and numbers, dedicated Escape/Tab/Ctrl/Shift, thumb Space, and the same game toggle to exit.
- **Right side:** bindings, Backspace/Enter chords, mouse controls, and layer access remain unchanged. Holding a right-hand layer key does not remove left-side protection.
- **Toggle off:** normal left bindings and Escape/Tab chords return. Release held keys before toggling; already-pressed keys or combos are not retroactively cancelled.

The separate built-in A+F 3-second Studio-unlock chord is disabled in all modes with `CONFIG_ZMK_STUDIO_UNLOCK_COMBO=n`. Studio still requires unlocking: with game mode off, hold MO5, hold the left pinky's layer-6 key, then press either explicit Studio-unlock key (the T/Y positions). This preserves access without a global gaming chord.

These are source changes, not live Studio edits. They need a successful firmware build and an explicitly approved installation before the keyboard changes. Existing saved Studio key bindings can override compiled bindings; check them if the flashed behavior differs. Do not use a settings-reset image casually.

## Arrow keys below comma and period

The two keys directly below **`,`** and **`.`** (source positions 50/51, previously the base-layer brackets) send **Left** and **Right**, respectively. Whenever layer 1 is active, they instead send **Down** and **Up**. All higher layers, including the game guard, remain transparent at these positions so the rule holds across layer combinations. MO1 remains a hold-layer key; this does not add a layer-1 toggle or change its game-mode Space behavior. Brackets remain available on layer 1 in their other existing positions.

## Hardware acceptance checklist

Before accepting the new firmware, verify:

- All grid and thumb positions and original layer transitions; game protection layer 7 automatically follows TG3.
- All four combos and the original 50 ms combo timing with game mode off. With game mode on, W+E and S+D must remain independent keys, even while MO2/MO5 are held; right-hand Backspace/Enter combos still work.
- Game mode makes both left Windows positions send F8, blocks both left Alt keys, keeps Ctrl/Shift/Space available, prevents higher-layer left shortcuts, and exits using the same thumb toggle.
- The keys below comma/period send Left/Right across all layers, changing to Down/Up whenever layer 1 is active, including with higher overlays held.
- Holding A+F for more than three seconds does not unlock a locked Studio session in either mode; explicit layer-6 unlock still works with game mode off.
- Ctrl/A, Ctrl/semicolon, Shift/Z, and right-Shift/slash Mod-Taps and typing feel.
- Windows Right-Alt-number, Alt-P/N, and shifted Alt-P/N shortcuts.
- Right trackball: cursor mode normally, scrolling on layer 2, intended speed and scroll direction, unchanged cursor direction.
- Mouse buttons, RGB, Bluetooth profile behavior, USB behavior, and split reconnection after power cycling.

The candidate changes underlying ZMK/driver versions relative to the unknown currently flashed source. Unchanged definitions, a successful compiler run, and a successful UF2 transfer do not prove identical physical behavior.

## Keep one source of truth

Use the Git repository as the master configuration. The prepared firmware also has standard Studio support, but independent live Studio key edits are not automatically exported back into source and may persist as settings overriding compiled defaults. Do not casually mix those workflows. Neither this tool nor the visual editor provides the vendor-only live trackball panel.

Existing trackball rules stay in `config/imprint.keymap`. GUI controls for those custom input processors are not part of this setup.

## Files, configuration, and updates

- `tools/companion/config.json`: repository, branch, workflow and exact per-half filenames.
- `.github/workflows/build.yml`: existing automatic firmware build; dependency pins remain unchanged.
- `.github/workflows/companion.yml`: Node unit/integration tests on Windows, macOS and Linux.
- `.github/workflows/desktop.yml`: native package builds, Node/Bun tests, and fixture-only packaged smoke checks for Windows x64, Apple Silicon macOS, Linux x64 and Linux ARM64. It uploads CI artifacts, not public releases.
- `tools/companion/`: shared local server, UI, validation and tests; `cli.mjs` is the source launcher.
- `tools/desktop/`: native shell, permissions/link policy, package smoke check, assets and upstream notices.
- `electrobun.config.ts` / `hutch.config.ts`: desktop package and exact framework pin.
- `CONTEXT.md`: preserved configuration, decisions, backup boundaries.

Private data locations:

- Windows: `%LOCALAPPDATA%\CyboardImprintWorkbench`
- macOS: `~/Library/Application Support/CyboardImprintWorkbench`
- Linux: `${XDG_DATA_HOME:-~/.local/share}/CyboardImprintWorkbench`
- Simulation: a new `imprint-workbench-demo-*` directory under the OS temporary directory.

`builds/` contains original downloaded ZIPs, matching UF2s, hashes and source/build provenance. `readbacks/` contains timestamped private device captures. `readbacks.json` indexes the latest capture for each explicitly identified side. Do not publish this cache. Nothing in it is automatically added to Git.

Desktop updates are manual: install the next reviewed package. No automatic updater is enabled. The source fallback updates by reviewing/pulling the chosen branch and running `npm ci --ignore-scripts` again. A different configured branch must be reflected in `tools/companion/config.json`, rebuilt into the desktop package, and selected in the visual editor. The companion never pushes or merges branches on your behalf.

## Safe rehearsal and tests

```sh
npm run companion:demo
```

The UI is explicitly labelled **Simulation**. Its fake GitHub build and fake bootloader drives live in a new temporary directory; it never enumerates real volumes or calls GitHub. Use **Simulate bootloader connection** to capture both fake halves, prepare the fake build, arm one half and observe the one-shot transfer. Do not confuse a passing rehearsal with a hardware flash.

```sh
npm test
npm run test:game
npm run test:baseline
```

`test:game` is the ongoing source-level game-mode regression check, also included in `npm test`. It checks all combinations of existing overlay layers but is not a firmware simulator or a hardware timing test.

The main tests cover provenance, ZIP bounds/CRC, UF2 bounds, readback identity, arming/cancellation/shutdown, GitHub HTTP credential/redirect protections, auth/storage failures, HTTP origin/session protections, and simulated transfers. Desktop CI also runs them under the exact bundled Bun version. See `tools/desktop/README.md` for native package smoke checks; neither those checks nor browser proofs establish physical keyboard behavior. Some real-file symlink tests may skip on Windows without symlink privilege; the in-memory rejection test and junction tests still run. Optional evidence tests accept `UF2_CANDIDATE_DIR` (the directory of both UF2s), `FIRMWARE_ARTIFACT_ZIP` (the original ZIP), and `GITHUB_EVIDENCE_DIR` (the retention root containing both `firmware-artifact.zip` and the `evidence/` subdirectory), all outside the repo.

`test:baseline` is the original one-time preservation guard. It now intentionally fails because game-mode protection changes the keymap, so it is **not** a required check for everyday edits. Keep it as historical evidence or explicitly update its baseline when requirements change; do not confuse its expected failure after editing with the normal firmware build.

## Troubleshooting

| Symptom | Action |
|---|---|
| GitHub request fails | Desktop: verify/reconnect the token and check its expiry, selected repository and permissions. Source fallback: use `gh auth status` / `gh auth login`. Check the network; never paste credentials into logs. |
| Remember unavailable or fails | Windows intentionally supports session-only access in this build. On macOS/Linux, unlock/configure the OS credential store or explicitly choose session-only access. A failed Disconnect warning means a saved record may remain; remove this app's record in the system store before sharing the account. |
| Rebuild times out | The run may or may not have started. Use Check now / GitHub Actions before retrying; the app does not retry dispatch automatically. |
| No current build | Confirm the editor saved to the configured branch, inspect GitHub Actions, or request Rebuild current commit. |
| Artifact expired or wrong digest | Rebuild the selected source and download again. Never bypass integrity checks. |
| No compatible drive | Use a data cable, connect directly, double-tap reset. Normal HID/serial mode is not a bootloader volume. |
| Two drives found | Leave only the intended half in bootloader mode. |
| Wrong-half/readback mismatch | Confirm which half is connected. If its firmware intentionally changed, capture its current image again. |
| Existing `FLASH.UF2` prevents writing | Reset out of bootloader and re-enter it. The app never overwrites an existing destination or link. |
| Readback missing/unreadable | Stop. Preserve the existing source and any known original binaries; assess recovery before installing. |
| Drive vanishes during transfer | Outcome is unverified, not automatically failed or successful. Check keyboard operation and re-enter bootloader only if recovery is needed. |
| Loopback/port error | Close another workbench, or use `npm run companion -- --port 4766` and the printed URL. Do not expose it on a LAN or via a tunnel. |

## Reuse and scope

- Visual editor: https://github.com/nickcoutsos/keymap-editor — reused as the hosted editor, not forked or embedded with native privileges.
- Firmware build: the existing ZMK reusable workflow and your configuration repository.
- UF2 mechanism: the standard mounted-volume deployment pattern from https://github.com/microsoft/uf2 and Cyboard's flashing documentation.
- Automatic artifact deployment precedent: https://github.com/why-trv/zmk-fw-deployer . Its implementation was not copied: it has no declared license and makes device/side assumptions unsuitable here.
- Desktop shell: pinned Electrobun with its actual Bun runtime and system webviews; upstream notices and source pointers are bundled under `app/licenses/`. Cottontail/Hutch are build tooling, not the application's firmware-write runtime.
- ZIP reader: pinned `yauzl`, with bounded entries, explicit CRC checks, and GitHub's independent archive digest.
- Typeface: IBM Plex Sans, self-hosted under its bundled SIL Open Font License.

The small custom integration exists for exact-build selection, Windows support, side/readback guards, explicit one-shot authorization, and honest outcomes. It is not a new firmware stack or a replacement for the visual editor.
