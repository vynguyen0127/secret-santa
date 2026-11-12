// Vercel entry point: every request is sent here (see vercel.json) and handled
// by the same code that `npm start` runs.
//
// If the app fails while starting up (e.g. a missing setting), show the reason
// on the page instead of Vercel's generic "FUNCTION_INVOCATION_FAILED".
let handler;
let startupError;
try {
  handler = require('../server').handler;
} catch (e) {
  startupError = e;
  console.error('Startup error:', e);
}

module.exports = (req, res) => {
  if (startupError) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end(`Secret Santa couldn't start:\n\n${startupError.message}`);
    return;
  }
  return handler(req, res);
};
