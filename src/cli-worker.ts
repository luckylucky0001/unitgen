// Internal worker. The public cli.ts entry owns the project lock and process supervision.
import { main } from "./cli-main.ts";
import { cancelRuns, exitAfterFlush, runSignal, RunCancelled, log } from "./util.ts";

for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, cancelRuns);
main(process.argv.slice(2)).then(
  (code) => exitAfterFlush(runSignal.aborted ? 130 : code),
  (e) => {
    log(`error: ${(e as Error).message}`);
    if (process.env.UNITGEN_VERBOSE === "1") console.error(e);
    exitAfterFlush(e instanceof RunCancelled || runSignal.aborted ? 130 : 1);
  },
);
