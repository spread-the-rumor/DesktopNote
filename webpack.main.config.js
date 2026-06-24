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
};
