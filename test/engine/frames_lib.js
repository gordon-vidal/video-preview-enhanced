'use strict';
// Shared body of the test/engine/frames_*.js files: each runs the seeking.js journeys on a few clips,
// one file per group so test/run.js can run the groups in parallel.
const path = require('path');
const { open, checks } = require('./harness');
const J = require('./journeys');
const media = require('../media/make_cases_media');

/** jobs: [[name, clip, async (P) => {...}], ...]; each opens its clip fresh. */
async function runJobs(title, jobs) {
  const c = checks(title);
  for (const [name, clip, fn, opts] of jobs) {
    await c.run(name, async () => {
      const f = media.make(clip);
      if (!f) throw new Error(`${clip} could not be made (ffmpeg with the needed encoder?)`);
      const P = await open(f, opts || {});
      try { await fn(P); } finally { P.close(); }
    });
  }
  c.done();
}

/** step/<clip> and seek/<clip> of seeking.js for each clip. */
const stepSeek = (clips) => clips.flatMap((clip) => [
  [`step/${clip}`, clip, J.steps],
  [`seek/${clip}`, clip, J.seeks],
]);

module.exports = { runJobs, stepSeek, J, path };
