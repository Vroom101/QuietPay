import { randomBytes } from "node:crypto";
import { closeSync, mkdirSync, openSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Writes every file to a temp name first, then renames them into place, so a crash or full disk never leaves a
 * half-written CSV or sidecar under the final name. All temps are written before the first rename.
 * Temp names carry a random suffix and are created exclusively (wx), so a planted file or symlink is never followed.
 */
export function writeFilesAtomic(files: { path: string; data: string }[]): void {
  const temps: { path: string; data: string; tmp: string }[] = [];
  try {
    for (const f of files) {
      mkdirSync(dirname(f.path), { recursive: true });
      const tmp = `${f.path}.${randomBytes(12).toString("hex")}.tmp`;
      temps.push({ ...f, tmp });
      const fd = openSync(tmp, "wx", 0o644);
      try {
        writeFileSync(fd, f.data);
      } finally {
        closeSync(fd);
      }
    }
    for (const f of temps) renameSync(f.tmp, f.path);
  } catch (e) {
    for (const f of temps) rmSync(f.tmp, { force: true });
    throw e;
  }
}
