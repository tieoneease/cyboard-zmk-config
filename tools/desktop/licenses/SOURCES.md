# Redistribution notices and source pointers (Windows x64 desktop payload)

This folder holds the license texts shipped inside the desktop app (`app/licenses/`) and records where each came from. It is a good-faith attribution bundle copied from upstream maintainers, **not** legal advice or a compliance certification. It does not assert a license for this repository; the project's own code is separately unlicensed (see `tools/companion/THIRD_PARTY.md`).

Inspected baseline build (before application-icon branding): Electrobun 2.0.2 (paired Hutch 0.27.1), `win-x64`, `stable`, Bun main process, `defaultRenderer: native`, `bundleCEF/bundleWGPU: false`. Other targets (macOS, Linux) ship different native files and are **not** covered here.

## What ships (Windows)

`ImprintWorkbench/bin/`: `bun.exe`, `launcher.exe`, `ElectrobunCore.dll`, `libNativeWrapper.dll`, `libasar.dll`, `zig-zstd.exe`, `bspatch.exe`.
`Resources/`: `main.js`, `preload-full.js`, `preload-sandboxed.js`, `uninstall` (= Electrobun `extractor.exe`), `app/bun/index.js` (uncompiled bundled JS), `app/companion/*`. The installer ZIP contains `Setup.exe` (the extractor) and adjacent archive/metadata in `.installer/`; the EXE is not the entire installer.
Not shipped: CEF/Chromium, Dawn/WGPU (`webgpu_dawn.dll`, `d3dcompiler_47.dll`), `WebView2Loader.dll`, `bsdiff.exe`, `zig-asar.exe`, Cottontail, Hutch, and the Microsoft WebView2 Runtime (a Windows/Edge system component).

## Components

| Shipped item | License | Upstream (exact) | Text here |
|---|---|---|---|
| Electrobun runtime + TS API bundled into `app/bun/index.js`, `main.js`, `preload-*.js`, `launcher.exe`, `ElectrobunCore.dll`, `libNativeWrapper.dll`, `extractor.exe` | MIT, Blackboard Technologies Inc. | https://github.com/blackboardsh/electrobun tag `v2.0.2` = commit `e424efbc8af0315e565811fcef0920d3b757e3fc`, `LICENSE` | `electrobun.txt` |
| `bun.exe` 1.4.0 (`1.4.0+34cbb9a40`), unmodified, separate replaceable executable | MIT + statically linked libraries (see below) | https://github.com/oven-sh/bun tag `bun-v1.4.0` = commit `34cbb9a40b4bd1bd767d134a7065e66c2432a676`, `LICENSE.md` (byte-identical to `bun.txt`); same text at `docs/project/license.mdx` | `bun.txt` |
| JavaScriptCore/WebKit statically linked in Bun (LGPL-2) | LGPL-2 | https://github.com/oven-sh/WebKit commit `0f966e81b78c84bb23213e391bc679c4ef83e56b` (`WEBKIT_VERSION` in Bun's `scripts/build/deps/webkit.ts` at the tag); `Source/JavaScriptCore/COPYING.LIB` | `webkit-jsc-COPYING.LIB.txt` |
| WTF-bundled code in that WebKit tree (dragonbox, simde, libc++, LLVM) | various permissive (see each file header) | same commit, `Source/WTF/LICENSE-*.txt` | `webkit-wtf-bundled.txt` |
| `zstd` (in Bun, `zig-zstd.exe`, `bspatch.exe`) | BSD (dual BSD/GPLv2; BSD elected) | https://github.com/facebook/zstd, commit `1168da0e567960d50cba1b58c9b0ba047ece4733` (submodule pin of zig-zstd v0.1.7), `LICENSE` | `zstd-bsd.txt` |
| `zig-zstd.exe` | MIT, Blackboard Technologies Inc. | https://github.com/blackboardsh/zig-zstd tag `v0.1.7` = `3d17f485a6250456df263a05cb8b0f23f6ab0b3e` | `zig-zstd.txt` |
| `bspatch.exe` | MIT (Blackboard) over BSD-2-clause-style bsdiff notice (Colin Percival, Yoav Givati) | https://github.com/blackboardsh/zig-bsdiff tag `v0.1.23` = `cc974fb3e23356c7a0ab44d7e6482a5de57ee88d`; header of `bspatch.zig`; zstd submodule pin `448cd340879adc0ffe36ed1e26823ee2dcb3217b` | `zig-bsdiff.txt` |
| `libasar.dll` | MIT per `package.json` (no LICENSE file in repo) | https://github.com/blackboardsh/zig-asar tag `v0.2.7` = `de5b3c9018da6dd7462329847cead606d376b967` | none (see limitations); Blackboard MIT text is `electrobun.txt` |
| Microsoft WebView2 loader, **statically linked into `libNativeWrapper.dll`** (`WebView2LoaderStatic.lib`, WebView2 headers) | Microsoft BSD-3-style | NuGet `Microsoft.Web.WebView2`, `LICENSE.txt` (identical in 1.0.2592.51 and 1.0.4258.31). Electrobun's `package/build.ts` runs an unpinned `nuget install Microsoft.Web.WebView2`, so the exact version is **not recorded** | `webview2-sdk.txt` |
| `yauzl` 3.4.0 bundled into `app/bun/index.js` | MIT, Josh Wolfe | npm `yauzl@3.4.0` | `yauzl.txt` |
| `pend` 1.2.0 bundled into `app/bun/index.js` | MIT, Andrew Kelley | npm `pend@1.2.0` | `pend.txt` |
| `fd-slicer` code adapted inside yauzl | MIT, Andrew Kelley | https://github.com/andrewrk/node-fd-slicer `LICENSE` (default branch; adapted revision not recorded) | `fd-slicer.txt` |
| `buffer-crc32` code adapted inside yauzl (`crc32.js`) | MIT, Brian J. Brennan | https://github.com/brianloveswords/buffer-crc32 tag `v0.2.13` `LICENSE` | `buffer-crc32.txt` |
| IBM Plex Sans font | SIL OFL 1.1 | https://github.com/google/fonts/tree/main/ofl/ibmplexsans | `public/assets/OFL.txt` (companion UI), not in this folder |

## Bun and the LGPL

- Bun's own notice (`bun.txt`) states Bun statically links JavaScriptCore/WebKit under LGPL-2 and gives the relink route: clone https://github.com/oven-sh/WebKit into `vendor/WebKit`, `bun sync-webkit-source` (checks out `WEBKIT_VERSION`), `bun run build:local`, using the Bun source at the commit above.
- Here `bun.exe` is the unmodified official 1.4.0 binary, shipped as a separate file (`bin/bun.exe`) that the user can replace. The application JS is not compiled into it (no `bun --compile`). `bun.exe` SHA-256 `627d2e4775c24bdedee2cd7ccc18dcadae061e5345274ab6e3c4c797927bfb8f` equals Hutch's downloaded `toolchains/bun/1.4.0/windows-x64/bun.exe`, `bun.exe --revision` prints `1.4.0+34cbb9a40`, matching the tag commit. It is also byte-identical to `bun.exe` inside the official release asset `https://github.com/oven-sh/bun/releases/download/bun-v1.4.0/bun-windows-x64.zip` (zip SHA-256 `e6f093d39da486b20262ca8cdd5ed6a9e8bc9c2f275b78e6d3a0c5b28cc95901`, matching that release's `SHASUMS256.txt`).
- Bun's `LICENSE.md` table is the maintainers' own list; Bun's dependency pins at the tag are `scripts/build/deps/*.ts` (also covers items absent from the table, e.g. HdrHistogram, SQLite, rust-argon2). Per-library license texts for Bun's ~30 static libraries are **not** reproduced here beyond the ones listed above; they are referenced by Bun's table.

## Verified build provenance (Windows, 2.0.2)

The unbranded baseline payload files were byte-identical to the Electrobun 2.0.2 devkit (`~/.hutch/releases/electrobun/2.0.2/windows-x64`), and `bspatch.exe`, `zig-zstd.exe`, `libasar.dll` are byte-identical to the artifacts Electrobun's `package/src/shared/build-dependencies.ts` pins (`zig-bsdiff` 0.1.23, `zig-zstd` 0.1.7, `zig-asar` 0.2.7) at `https://electrobun-artifacts.blackboard.sh/<name>/releases/<version>/<name>-win32-x64.tar.gz`:

- `bspatch.exe` `5439ffce337a5b8c25397e713665f26bc7b9b039db5e8c53e758ff09c0aeb290`
- `zig-zstd.exe` `ce8efe668010cb3f2c418cbaa3b3ec393e4bf00267d83d395739a280d5209603`
- `libasar.dll` `9f7cdefdd957d925cafd4c38d05066eec8c51b94ad8d30b1863a7b62cf27e592`
- `libNativeWrapper.dll` `22c517b7edf0874e448d74cd939e6777234d1e0a5128b008628cc564637e4fd5`, `ElectrobunCore.dll` `bd9a90c724feb076069133ce5130b61c1f451cf3df23fb9b410cbe00e8af8560`, `launcher.exe` `f13bb9d4ae3320ac9b03324da96f0989d746abd173ae494ac8c59956b09ab5a4`, `extractor.exe` (`uninstall`, `Setup.exe`) `0ebc01b0d45a78461b02c6656400f90159b76099556011b094bc8c5795af8ef5`

## Limitations

- No aggregated third-party notice file was found in the Electrobun v2.0.2 tree (only `LICENSE`); the table above is assembled from build scripts and per-repo licenses. The WebView2 SDK version, Zig standard-library/compiler-rt (MIT) in the Zig-built binaries, and any MSVC runtime code in `libNativeWrapper.dll` are not itemised.
- `zig-asar` has no license file at its tag, only `"license": "MIT"` in `package.json`; no copyright line could be copied.
- `webkit-wtf-bundled.txt` reproduces the license files present in the pinned WebKit tree; whether each is linked into this `bun.exe` was not verified.
- LGPL-2 offers a "provide object form so the user can relink" route. Pointing at upstream URLs, as Bun does, is not the same as shipping a written offer or the source yourself; if you want a stronger position, retain copies of the Bun tag and WebKit commit above alongside releases. Not decided here.
- Hashes and pins describe the unbranded baseline inspected on 2026-10-03. App-icon branding can change launcher/extractor PE resources and their hashes without changing executable source; final installer checksums are recorded separately. Re-derive runtime provenance on any Electrobun/Bun upgrade.
