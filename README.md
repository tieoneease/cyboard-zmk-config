# ZMK Configuration Template
Wireless Cyboard keyboard configuration repository template for using ZMK firmware. [Instructions for use are located on our documentation site](https://docs.cyboard.digital/user-manual/quick-start/configure-layout).

## Current Studio migration

See [CONTEXT.md](CONTEXT.md) for the preserved April 23 source baseline, migration checks, and backup/flash gates. This branch enables live Studio key editing while retaining the custom source keymap; it does not add Cyboard's vendor-only trackball configuration UI.

```sh
node --test scripts/check-studio-port.test.mjs
```

These checks prove source preservation only. A successful build, validated rollback files for both halves, and physical keyboard checks are separate requirements.