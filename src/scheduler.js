// Backwards-compatible entry point: the scheduler grew into jobs.js in
// v0.2 (interval / daily / runonce kinds, persisted run state). This shim
// keeps `node src/scheduler.js` working; new setups should use jobs.js.
import { main } from "./jobs.js";

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
