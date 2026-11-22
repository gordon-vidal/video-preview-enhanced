// The Node entry point is loaded only after the runner records this process on the lock.
// If the runner dies before then, the IPC channel closes and no test code runs.
const authorized = await new Promise((resolve) => {
  process.once('disconnect', () => resolve(false));
  process.once('message', (message) => resolve(message === 'start'));
});
if (!authorized) process.exit(1);
if (process.connected) process.disconnect();
