import type { ElectrobunConfig } from "electrobun";

export default {
  app: {
    name: "Imprint Workbench",
    identifier: "io.github.tieoneease.imprint-workbench",
    version: "1.0.0",
    description: "Source-managed Cyboard Imprint builds and guarded per-half installation",
  },
  build: {
    mainProcess: "bun",
    bun: { entrypoint: "tools/desktop/main.ts", minify: false },
    buildFolder: "desktop-build",
    artifactFolder: "desktop-artifacts",
    copy: {
      "tools/companion/public": "companion/public",
      "tools/companion/config.json": "companion/config.json",
      "WORKFLOW.md": "companion/WORKFLOW.md",
      "tools/companion/THIRD_PARTY.md": "companion/THIRD_PARTY.md",
      "tools/desktop/licenses": "licenses",
    },
    mac: { bundleCEF: false, bundleWGPU: false, defaultRenderer: "native", icons: "tools/desktop/assets/icon.iconset",
      codesign: process.env.IMPRINT_SIGN_MAC === "1", notarize: process.env.IMPRINT_SIGN_MAC === "1" },
    win: { bundleCEF: false, bundleWGPU: false, defaultRenderer: "native", autoGrantPermissions: [], icon: "tools/desktop/assets/icon.ico" },
    linux: { bundleCEF: false, bundleWGPU: false, defaultRenderer: "native", icon: "tools/desktop/assets/icon.png" },
  },
  runtime: { exitOnLastWindowClosed: false },
  // No automatic updater, previous-release download, or release upload.
  release: { generatePatch: false },
} satisfies ElectrobunConfig;
