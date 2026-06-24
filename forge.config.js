const { FusesPlugin } = require('@electron-forge/plugin-fuses');
const { FuseV1Options, FuseVersion } = require('@electron/fuses');

module.exports = {
  packagerConfig: {
    // Unpack the Recall SDK from the asar archive: its native agent binary
    // and DLLs must exist as real files on disk to be spawned/loaded.
    asar: {
      unpackDir: 'node_modules/@recallai',
    },
  },
  rebuildConfig: {},
  makers: [
    {
      name: '@electron-forge/maker-squirrel',
      config: {},
    },
    {
      name: '@electron-forge/maker-zip',
      platforms: ['darwin'],
    },
    {
      name: '@electron-forge/maker-deb',
      config: {},
    },
    {
      name: '@electron-forge/maker-rpm',
      config: {},
    },
  ],
  publishers: [
    {
      name: '@electron-forge/publisher-github',
      config: {
        repository: {
          owner: 'spread-the-rumor',
          name: 'DesktopNote',
        },
        prerelease: false,
        // Upload as a draft so a release never goes live (and auto-updates to
        // users) until you explicitly publish it in the GitHub UI. Flip to
        // false later for fully-automated releases.
        draft: true,
      },
    },
  ],
  plugins: [
    {
      name: '@electron-forge/plugin-auto-unpack-natives',
      config: {},
    },
    {
      name: '@electron-forge/plugin-webpack',
      config: {
        mainConfig: './webpack.main.config.js',
        renderer: {
          config: './webpack.renderer.config.js',
          entryPoints: [
            {
              html: './index.html',
              js: './renderer.js',
              name: 'main_window',
              preload: {
                js: './preload.js',
              },
            },
            // Granola-style "Meeting Detected" popup — a separate frameless,
            // always-on-top window. Its own entry produces POPUP_WINDOW_WEBPACK_ENTRY
            // and POPUP_WINDOW_PRELOAD_WEBPACK_ENTRY globals (mirrors main_window).
            {
              html: './popup.html',
              js: './popup.js',
              name: 'popup_window',
              preload: {
                js: './popupPreload.js',
              },
            },
          ],
        },
      },
    },
    // Ensures the externalized Recall SDK (and its native deps) is copied into
    // the packaged app, since plugin-webpack otherwise strips node_modules.
    // Must come after plugin-webpack.
    {
      name: '@timfish/forge-externals-plugin',
      config: {
        externals: ['@recallai/desktop-sdk'],
        includeDeps: true,
      },
    },
    // Fuses are used to enable/disable various Electron functionality
    // at package time, before code signing the application
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};
