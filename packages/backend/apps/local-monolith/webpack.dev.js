/**
 * Dev/watch build of the local monolith without Nest's built-in type checker.
 *
 * Nest's webpack builder always adds ForkTsCheckerWebpackPlugin, with its default 2 GB heap, whatever `typeCheck` says. On the build
 * machine the checker ran out of memory on a recompile (2026-10-17, W04 gate): the API went down, the BFF answered 502 and checkout
 * specs timed out, five repair attempts in a row. Types are checked by the gates (`tsc --noEmit`), so the watch build only transpiles.
 */
module.exports = (options) => ({
  ...options,
  plugins: (options.plugins ?? []).filter(
    (plugin) => plugin?.constructor?.name !== 'ForkTsCheckerWebpackPlugin',
  ),
});
