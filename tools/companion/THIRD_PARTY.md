# Reused components and attribution

- **ZMK Keymap Editor**, Nick Coutsos: https://github.com/nickcoutsos/keymap-editor . Used as a linked hosted application; its application code is not bundled here. GitHub App permission is granted separately by the user.
- **ZMK / Cyboard user configuration and firmware workflow**: existing repository configuration and dependency references are retained. This tooling does not change their licenses or represent itself as a Cyboard vendor application.
- **yauzl 3.4.0**, Josh Wolfe and contributors, MIT: installed through npm, with its license in the installed package. Its `pend` dependency is also MIT. Both versions are locked in `package-lock.json`.
- **Electrobun 2.0.2 / Bun 1.4.0**: desktop runtime and system-webview shell. The exact devkit is pinned; upstream license texts and source pointers are bundled under `tools/desktop/licenses/` → `app/licenses/`. See [desktop redistribution notes](../desktop/licenses/SOURCES.md) for inspected Windows components and remaining limits. Cottontail/Hutch are build tooling, not the app runtime. No CEF/Chromium or WGPU is redistributed by this config.
- **IBM Plex Sans**, IBM, SIL Open Font License 1.1: local font from https://github.com/google/fonts/tree/main/ofl/ibmplexsans . The required license is bundled at `public/assets/OFL.txt`. No runtime font service is contacted.
- **UF2**: protocol and mounted-volume deployment references at https://github.com/microsoft/uf2 and Cyboard's firmware-update documentation. Validation and orchestration here are custom JavaScript code running on Node/Bun, not copied flasher implementations.

The unlicensed `why-trv/zmk-fw-deployer` project informed the feasibility comparison only. Its implementation was not copied. No new repository-wide license is asserted by this setup.
