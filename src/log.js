const startedAt = Date.now();
let verbose = false;

const stamp = () => `[${((Date.now() - startedAt) / 1000).toFixed(1).padStart(6)}s]`;

export const log = {
  setVerbose(value) {
    verbose = value;
  },
  info: (...args) => console.log(stamp(), ...args),
  warn: (...args) => console.warn(stamp(), 'WARN', ...args),
  error: (...args) => console.error(stamp(), 'ERROR', ...args),
  debug: (...args) => verbose && console.log(stamp(), 'debug', ...args),
};
