require('dotenv').config();
const webpack = require('webpack');

module.exports = {
  /**
   * This is the main entry point for your application, it's the first file
   * that runs in the main process.
   */
  entry: './main.js',
  // Put your normal webpack config below here
  module: {
    rules: require('./webpack.rules'),
  },
  // Keep the Recall SDK out of the webpack bundle so that, at runtime,
  // require() resolves the real package in node_modules. This preserves the
  // SDK's __dirname so it can find its native agent (agent-windows.exe) and
  // the accompanying DLLs that ship alongside index.js. Bundling the SDK
  // breaks this: __dirname becomes .webpack/main/ where the binary isn't.
  externals: {
    '@recallai/desktop-sdk': 'commonjs @recallai/desktop-sdk',
  },
  plugins: [
    // Bake VERCEL_BACKEND_URL into the packaged bundle at build time so the
    // app calls Vercel for create_sdk_recording without needing a .env file.
    // Falls back to empty string (→ localhost) when not set (local dev).
    new webpack.DefinePlugin({
      'process.env.VERCEL_BACKEND_URL': JSON.stringify(process.env.VERCEL_BACKEND_URL || ''),
    }),
  ],
};
