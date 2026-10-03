# Desktop builds and release boundaries

Electrobun wraps the existing Imprint Workbench; it does not replace the firmware stack or the source editor. Read [WORKFLOW.md](../../WORKFLOW.md) for use and recovery limitations.

## Exact toolchain

- Electrobun **2.0.2**, explicitly pinned in `hutch.config.ts` and `package-lock.json`.
- The npm bootstrap acquires its paired **Hutch 0.27.1**, which verifies the native devkit.
- Main process: actual **Bun 1.4.0**, pinned by that devkit. `main.ts` refuses an unexpected Bun version rather than silently running safety logic on a new runtime.
- Cottontail is Hutch's build/configuration runtime, not the application's main process.
- Native system webviews: WebView2, WKWebView, WebKitGTK. No CEF/Chromium or WGPU is bundled.
- Project packages remain npm-managed. Use `npm ci --ignore-scripts`; no `curl | sh` installer or global Hutch installation is required by these commands.

First build downloads platform/runtime artifacts. Subsequent builds can reuse the verified tool cache. Runtime/framework upgrades require retesting filesystem identity, subprocesses/timeouts, HTTP shutdown, ZIP extraction/CRC, auth/redirects, and every arming/write gate—not just changing a version string.

## Targets

| CI host | CPU | Installer |
|---|---|---|
| `windows-latest` | x64 | `win-x64-ImprintWorkbench-Setup.zip` |
| `macos-latest` | ARM64 | `macos-arm64-ImprintWorkbench.dmg` |
| `ubuntu-24.04` | x64 | `linux-x64-ImprintWorkbench-Setup.tar.gz` |
| `ubuntu-24.04-arm` | ARM64 | `linux-arm64-ImprintWorkbench-Setup.tar.gz` |

Build on each native host. Cross-packaging on Windows does not demonstrate macOS/Linux execution. Minimum target baselines are Windows 11, macOS 14+ Apple Silicon, and Ubuntu 24.04; other Linux distributions must supply compatible libraries. Windows ARM emulation is not a separately tested native release target. The owner uses Apple Silicon Macs; the pinned release has no published Intel Mac core.

On Ubuntu 24.04 the native webview needs GTK 3, WebKitGTK 4.1, Ayatana AppIndicator and librsvg; tests additionally use `xvfb`. Keep the OS sandbox/security defaults. Missing libraries should be installed through the distribution's package manager, not bypassed by disabling security.

## Build locally

From the repository root with Node.js 24+ and npm:

```sh
npm ci --ignore-scripts
npm test
npm run desktop:build
npm run desktop:smoke
```

The package bundles Bun; these developer prerequisites are not end-user prerequisites. A source `bun test tools/companion/test` check should use **1.4.0**, not an arbitrary installed Bun version. `desktop:smoke` executes the exact bundled runtime.

- `desktop-build/`: native build output; ignored by Git.
- `desktop-artifacts/`: installers, compressed app payload and update metadata; ignored by Git.
- `tools/desktop/assets/`: paired-half app icon and platform sizes. `icon.svg` is the editable authority; `scripts/make-desktop-icons.ps1` regenerates icon sizes from its 1024px PNG on Windows.
- `tools/desktop/licenses/`: upstream notices and source pointers copied into the app. [SOURCES.md](licenses/SOURCES.md) records Windows binary provenance and unresolved attribution/source-offer limits; it is not legal certification or a new license for this repository.

The framework's Windows build-folder `bin/launcher.exe` is an installer stub. Do not run that stub as if it were the expanded runtime, or copy the Setup EXE without its sidecar payload. Use the whole installer ZIP. The smoke script decompresses the generated app payload into an owned temporary directory, then executes the actual payload launcher.

## What smoke proves

The smoke check:

1. Removes installed Node, Bun and `gh` from the child's `PATH`.
2. Runs the bundled launcher/runtime with fixture-only access and a hidden native webview.
3. Waits for native document readiness **and** the app script's session-initialized marker.
4. Checks packaged UI/font/guide assets and uses two distinct fake half readbacks.
5. Verifies and submits the exact selected fake UF2 once, then exits cleanly.

It does not enumerate host drives, read real credentials, dispatch a GitHub build, or install firmware. It is not an installer UX test, native interactive accessibility test, physical cross-platform transfer test, or rollback certification. Node/Bun unit tests and browser proofs provide separate evidence.

For Linux CI use `xvfb-run -a npm run desktop:smoke`. A working display/session is required; do not use `--no-sandbox` as a workaround.

For an interactive developer rehearsal, set `IMPRINT_WORKBENCH_DEMO=1` and run `npm run desktop:dev` (PowerShell: `$env:IMPRINT_WORKBENCH_DEMO = '1'`). Unset it before normal use. This environment flag can only reduce access to synthetic fixtures. No command-line flag or remembered setting enables hardware writes in the desktop app.

## Credentials and local privileges

Direct REST calls go only to the fixed GitHub API origin. Authorization headers never follow the signed artifact redirect; archive size/digest and existing provenance checks remain mandatory. Windows tokens stay in memory only: Remember is disabled, and the app does not access Windows Credential Manager. Bun 1.4.0 ignores the `persist` option and writes enterprise-persistent (potentially roamable) records, so it cannot enforce the intended local-computer boundary. On macOS/Linux, explicitly choosing Remember uses this app/repository's record via Bun.secrets, with unrestricted macOS access disabled. No plaintext fallback or automatic `gh` token import exists.

This local, unpublished earlier build used only synthetic Windows credential tests, whose records were deleted. If an earlier development build was used separately with a real saved token, this build will neither load nor remove it; remove that app record in Windows Credential Manager. Re-enable Windows persistence only after a tested implementation proves `CRED_PERSIST_LOCAL_MACHINE` in actual stored metadata, not merely that a mock received an option.

The webview has no application RPC handlers or filesystem-backed URL-scheme access. It emits only an event-based readiness marker; all product commands use the same-origin loopback API with CSRF/Host/Origin checks. External links have a closed allowlist and open in the default browser, rather than loading third-party content with local privileges.

Enabling writes is explicit and lasts only for the session. Normal close fences asynchronous arming and cancels preflight, but is refused while a write is active. Forced process termination or OS shutdown remains outside that guarantee.

## CI and publication

`.github/workflows/desktop.yml` runs Node/Bun checks, native builds and fixture-only packaged smoke on all four targets. Uploaded Actions artifacts are build outputs, not automatically published releases. The workflow intentionally has no release write permission or automatic updater upload.

**Native acceptance gate:** check [Desktop packages](https://github.com/tieoneease/cyboard-zmk-config/actions/workflows/desktop.yml) on `migration/studio-preserve-current` for the current commit's results. The local Windows payload has runtime evidence. Do not label macOS/Linux packages tested until those native jobs pass; physical media tests remain a further gate.

## Signing and release

Unsigned packages are useful for controlled local validation but are not a frictionless public distribution promise. Do not tell recipients to disable SmartScreen/Gatekeeper or remove quarantine attributes.

- macOS: Electrobun supports Developer ID signing, notarization and stapling. The config enables both only with `IMPRINT_SIGN_MAC=1`. Configure the upstream `ELECTROBUN_DEVELOPER_ID` and notarization credentials in a trusted build environment, never in Git or PR jobs. No signing credentials were supplied here.
- Windows: the pinned Hutch pipeline does not integrate release signing. A public signed distribution needs an explicit signing step and the owner's certificate/cloud-signing setup.
- Before publication, review the bundled-runtime license/source obligations. The notices include upstream pointers and known gaps, not an assurance of complete redistribution compliance.
- No auto-update endpoint is configured. Install future reviewed packages manually. `generatePatch: false` avoids fetching a previous release during builds.

Publication, certificate use and the first real hardware installation require separate approval. The firmware files, keymap and `main` are not changed by packaging.

## Upstream references

- https://github.com/blackboardsh/electrobun/releases/tag/v2.0.2
- https://framework.blackboard.sh/electrobun/guides/compatability/
- https://framework.blackboard.sh/electrobun/guides/bundling-and-distribution/
- https://framework.blackboard.sh/electrobun/guides/code-signing/
- https://bun.com/docs/runtime/secrets
