# Imprint Workbench

Mode: operate. One owner managing a two-half keyboard at their desk. One job: move a known source commit through build verification into an explicitly approved, side-correct installation.

## Direction

There is no existing product UI in this firmware repository. Use a light instrument-panel layout suited to reading build provenance and physical device instructions, not a marketing landing page. The distinctive element is a paired left/right keyboard-half selector with a real installation state for each half.

Palette: paper #f7f6f2; surface #ffffff; ink #202820; secondary #5d675e; pine #1d654d; warning/error #a13c27. Borders and state backgrounds are mixtures of these tokens. IBM Plex Sans is the self-hosted display face; body uses the platform UI sans; commit IDs and measurements use the platform monospace.

Layout: a quiet repository header, one horizontal source/build/install process indicator, a wide build/provenance workspace beside a narrower physical-installation rail, and a compact activity record below. Collapse to one column on mobile.

```
Imprint Workbench                 LOCAL / READ-ONLY or WRITES ENABLED
repo / branch                    Guide
Source -> Build -> Install
[ Visual editor + source branch ] [ Left / Right physical half ]
[ Build status + commit         ] [ Backup                     ]
[ GitHub access (disclosure)    ] [ Write mode (desktop only)  ]
[ Prepare / rebuild + files     ] [ Arm / cancel               ]
[ Logs and precise outcome      ] [ Device / recovery          ]
```

The initial generic dashboard-card idea was rejected: the source/build area is a continuous work surface and the installation rail is visibly a separate, consequential operation. Numbering reflects the real sequence. Do not add metrics, generic icon cards, or a fake percentage for flash progress.

## State contract

- First run: explain editor authorization; no hardware writes by default. The command-line companion still explains its Node/gh prerequisites and `npm run companion:flash`; the desktop companion needs neither and never shows npm instructions.
- GitHub access (`state.auth`; `null` in the command-line and demo modes, which keep their gh behavior and show no access panel): a compact disclosure inside Build & verify, above the build actions, not a separate card. Signed out it opens by default with the fine-grained token steps (selected repository only; Contents read and Actions read; Actions write only for Rebuild), a password field, and an unchecked Remember option that is disabled when the build has no supported credential adapter (including Windows on pinned Bun 1.4.0, which cannot enforce local-computer-only persistence). The token is cleared from the field before the request and never echoed, previewed, or kept in the page or browser storage. Text separates this token from the editor's GitHub authorization and never asks for a password. Signed in shows the GitHub login or, for a loaded but unchecked saved token, "Saved token loaded · not verified yet" with Verify; Disconnect is always available; session-only versus system-store storage is stated. Storage warnings stay visible outside the disclosure. Status checks work without a token; Download and Rebuild are disabled with a visible reason until one is connected. Connecting does not check the build; the UI points to Check now. Claims stay to what GitHub accepted: Actions write is checked only when Rebuild is used. Any change in access resets the install confirmations.
- Write mode (desktop only, `canChangeWriteMode`; never in demo): read-only by default. Enabling needs its own fresh checkbox acknowledging that it does not arm an install and that a partial backup is not a rollback; the checkbox is consumed on click. Returning to read-only needs no confirmation. Both are disabled while busy or armed. A mode change resets the physical-half confirmation. Enabling writes is not arming: every install still needs both backups, the prepared latest build, a fresh physical-half confirmation, and Arm.
- Loading: preserve previous information and identify the operation; repeat actions disabled.
- No build/current build failed: keep editor and GitHub run links available; no stale fallback flash.
- Prepared: show the exact source SHA, run, both filenames and hashes.
- No bootloader: instruct the user to connect the selected physical half and double-tap reset.
- Multiple compatible drives: block and ask to leave only one in bootloader mode.
- Backup: save two matching CURRENT.UF2 reads outside the repo. Explicitly partial, not full rollback.
- Armed: one selected side and immutable prepared build; cancel prominently; browser heartbeat and expiration disarm abandoned operations.
- Writing: prevent cancellation, reiterate not to unplug. Never retry automatically.
- Submitted: state that bytes were submitted, not that firmware behavior was verified. If the drive drops during the write, report an unverified outcome rather than success.
- Demo: conspicuous simulation label; discovery and writes confined to a new temporary directory, never real volumes.

Every action uses an accessible text label; focus is visible; status announcements are polite; errors are actionable. No external fonts, analytics, device chooser, or secrets in UI. No native dialogs: inline confirmations are the gates. Repo remains source of truth; do not present live Studio settings as synced source.
