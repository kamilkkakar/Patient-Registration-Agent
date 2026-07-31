import { defineConfig } from 'vitest/config';

// Run the whole suite in a NON-UTC zone, on purpose.
//
// The DOB day-shift bug (see src/lib/serialize.ts) is invisible under TZ=UTC:
// `new Date("02/15/1992")` happens to be correct there and wrong everywhere
// else. A suite that only passes at UTC has not tested the thing that breaks.
// Set at module scope in the config, which is evaluated in the parent process,
// so forked workers inherit it through process.env.
process.env.TZ = 'America/Los_Angeles';

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
    env: { TZ: 'America/Los_Angeles' },
    // The suite drives one shared Postgres. Serial files keep list-endpoint
    // assertions from racing another file's fixtures.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});