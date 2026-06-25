// Vercel serverless entry point — exports the Express app so Vercel can wrap
// it as a serverless function. main.js requires server.js directly (in-process)
// and never imports this file.
const { app } = require('../server');
module.exports = app;
