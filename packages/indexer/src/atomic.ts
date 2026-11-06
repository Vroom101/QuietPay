import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Writes every file to a temp name first, then renames them into place, so a crash or full disk never leaves a
 * half-written CSV or sidecar under the final name. All temps are written before the first rename.
 */
export function writeFilesAtomic(files: { path: string; data: string }[]): void {
  const temps = files.map((f) => ({ ...f, tmp: `${f.path}.${process.pid}.tmp` }));
  try {
    for (const f of temps) {
      mkdirSync(dirname(f.path), { recursive: true });
      writeFileSync(f.tmp, f.data);
    }
    for (const f of temps) renameSync(f.tmp, f.path);
  } catch (e) {
    for (const f of temps) rmSync(f.tmp, { force: true });
    throw e;
  }
}
