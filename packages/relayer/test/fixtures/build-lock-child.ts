import { acquireInstanceLock } from "../../src/instance-lock.js";

const dbPath = process.argv[2]!;
try {
  const lock = acquireInstanceLock(dbPath);
  console.log("LOCKED");
  if (process.argv[3] === "exit-now") {
    lock.release();
    process.exit(0);
  }
  process.stdin.resume();
  process.stdin.on("end", () => process.exit(0));
} catch (e) {
  console.error("REFUSED: " + (e as Error).message);
  process.exit(3);
}
