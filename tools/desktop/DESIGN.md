# Desktop packaging contract

## Objective

Ship the source-managed Imprint Workbench as an Electrobun desktop app. Users install the app, not Node.js or GitHub CLI. Preserve the existing firmware configuration, exact-build validation, partial-readback identity checks, read-only default and explicit one-shot installation gates.

Targets: Windows 11 x64, macOS 14+ Apple Silicon, and Linux x64/ARM64 (Ubuntu 24.04 baseline). Electrobun 2.0.2 has no published Intel Mac core; the owner explicitly uses only Apple Silicon Macs. Native builds and tests run separately per target; a Windows build is not evidence of macOS/Linux execution.

## Architecture and decisions

- Pin Electrobun 2.0.2 / paired Hutch 0.27.1. Select the actual Bun main process (devkit-pinned Bun 1.4.0), not the new Cottontail compatibility runtime. Cottontail remains build tooling, not the firmware-write runtime. Keep npm's lockfile for project dependencies.
- Reuse the Node-compatible safety core and the existing HTML/CSS/JS surface. Revalidate its behavior under Bun. No native-language rewrite and no bundled Chromium; use the system webview. Linux needs documented system libraries.
- Keep a loopback-only HTTP boundary, now on an OS-assigned port for desktop. The webview has no native command RPC or filesystem URL-scheme privileges; its event-only readiness marker carries no secret or authority. Navigation stays in the local app; explicitly allowlisted guide/GitHub/editor links open in the default browser.
- Use direct GitHub REST calls in desktop, with bounded bodies/timeouts and no credential forwarding to artifact storage. The source CLI can still use the existing `gh` transport. No source pushes, editor authorization, or firmware dispatch on startup.
- GitHub access uses a fine-grained token restricted to this fork. Contents read and Actions read are needed; Actions write is optional for Rebuild. The user creates/pastes it themselves; the separate editor App consent is not delegated to this token.
- Windows tokens are session-only: Bun 1.4.0 ignores `persist` and cannot enforce local-computer-only storage, so the Windows credential adapter is disabled. On macOS/Linux, tokens stay in memory unless the user opts into the OS credential store via Bun.secrets. No plaintext fallback, environment-token auto-import, analytics, or token logging. Credential stores protect at rest, not against hostile code running as the same user. Linux without a working keyring supports explicitly chosen session-only access.
- Enable installations through a separate explicit per-session confirmation, not a command-line prerequisite. This only changes the hardware-write permission: both distinct backups, current verified firmware and fresh per-half arming remain mandatory. Restart returns to read-only.
- Closing fences all future operations immediately and cancels pending arming/preflight. Once writing begins, normal window close/quit is refused until a result exists. Process kills and OS shutdown cannot be made safe by UI guards.
- No automatic updates or release upload. Produce local/test artifacts; signed distribution requires the owner's credentials and separate publication permission. Keep the source CLI as a fallback and development surface.

## UI plan

Mode: operate, same single owner and same job as `tools/companion/DESIGN.md`. Preserve paper #f7f6f2, white, ink #202820, muted #5d675e, pine #1d654d, danger #a13c27; Plex headings, system body and monospace provenance. Keep the paired-half selector as the signature element.

Add one compact GitHub access disclosure in the existing build workspace and one inline session-permission disclosure in the installation rail. No new dashboard grid, onboarding wizard, or decorative modal.

```text
Imprint Workbench                     READ-ONLY / WRITES ENABLED
[ Source / hosted editor          ]  [ Left / Right + bootloader ]
[ GitHub access: connect / forget ]  [ Confirm physical identity ]
[ Current commit + verify build  ]  [ Capture labelled readback  ]
[ Verified filenames and hashes  ]  [ Enable session writes      ]
[ Activity + exact outcomes      ]  [ Arm once / cancel / result ]
```

Loading and errors retain state and never imply authentication or successful hardware execution. Remembering access is opt-in. Consent is consumed by actions; unchanged polling must preserve text selection. The native window opens with no automatic flash.

## Completion evidence

- Existing safety tests and new transport/auth/lifecycle tests pass under Node and the bundled Bun version.
- Windows packaged runtime loads the real assets, uses no installed Node/gh, and runs a fixture-only startup/installation smoke check.
- Browser proofs exercise the integrated UI, token-state rendering, session-write gate, and existing simulated per-half flow. Browser proof of the loopback surface is separate from native webview/OS interaction evidence.
- `.github/workflows/desktop.yml` packages and smoke-tests the four released CPU/OS targets on native hosts when published. Until those runs happen, non-Windows packages and runtime acceptance remain unverified.
- Independent final review covers credentials, tool execution, session shutdown, packaging, and the retained hardware-write boundary.
- No device captures or hardware installation without separate physical identification and explicit first-flash approval; no push/publication without permission.

## Primary references

- https://github.com/blackboardsh/electrobun/releases/tag/v2.0.2
- https://framework.blackboard.sh/electrobun/guides/cottontail/
- https://framework.blackboard.sh/electrobun/guides/compatability/
- https://framework.blackboard.sh/electrobun/guides/bundling-and-distribution/
- https://framework.blackboard.sh/electrobun/guides/code-signing/
- https://bun.com/docs/runtime/secrets
- https://docs.github.com/en/rest/actions/artifacts

These are implementation decisions, not claims that every acceptance gate has already passed.
