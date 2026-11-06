#!/usr/bin/env python3
"""Mutation sweep for PaymentRouter.sol. Works on a scratch copy outside the repo; never edits the repo.
Usage: python scripts/mutate-router.py [scratch_dir]   (needs forge on PATH)"""
import os, re, shutil, subprocess, sys, tempfile

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(REPO, "contracts")
scratch = sys.argv[1] if len(sys.argv) > 1 else os.path.join(tempfile.gettempdir(), "qp-mutants")
shutil.rmtree(scratch, ignore_errors=True)
shutil.copytree(SRC, scratch, ignore=shutil.ignore_patterns("out", "cache", "broadcast"))
# fixtures the tests read live next to the repo; keep the relative layout
fx = os.path.join(os.path.dirname(scratch), "packages")
shutil.rmtree(fx, ignore_errors=True)
os.makedirs(os.path.join(fx, "shared"), exist_ok=True)
shutil.copytree(os.path.join(REPO, "packages/shared/fixtures"), os.path.join(fx, "shared/fixtures"))
shutil.copy(os.path.join(REPO, "packages/shared/token.json"), os.path.join(fx, "shared/token.json"))

target = os.path.join(scratch, "src/PaymentRouter.sol")
orig = open(target, encoding="utf8").read()
lines = orig.split("\n")

mutants = []  # (line_no, description, new_line)
for i, ln in enumerate(lines):
    t = ln.strip()
    if t.startswith("//") or t.startswith("*") or t.startswith("/*"):
        continue
    if re.search(r"\bif \(.*\) revert ", t):
        mutants.append((i, "delete guard", re.sub(r"\bif \(.*\) revert \w+\(\);", ";", ln)))
        for a, b in [(" >= ", " > "), (" > ", " >= "), (" <= ", " < "), (" < ", " <= "), (" != ", " == "), (" || ", " && ")]:
            if a in ln.split("revert")[0]:
                mutants.append((i, f"flip {a.strip()} -> {b.strip()}", ln.replace(a, b, 1)))
    if "onlyOwner" in t or "onlyRelayer" in t:
        mutants.append((i, "drop access modifier", re.sub(r"\s+only(Owner|Relayer)", "", ln)))
    if "+=" in t and "totalRefunded" in t:
        mutants.append((i, "totalRefunded += -> =", ln.replace("+=", "=")))
    if "safeTransfer(" in t:
        mutants.append((i, "delete transfer", "// " + ln))
    if "refundCount" in t and "uint32(index + 1)" in t:
        mutants.append((i, "refundCount not advanced", "// " + ln))
    if "_pull(" in t and "private" not in t and "function" not in t:
        mutants.append((i, "delete pull call", "// " + ln))
    if "if (v < 27) v += 27" in t:
        mutants.append((i, "drop v normalisation", "// " + ln))

env = dict(os.environ)
survivors, killed, skipped = [], 0, 0
print(f"{len(mutants)} mutants")
for n, (i, desc, new) in enumerate(mutants, 1):
    if new == lines[i]:
        continue
    m = lines[:i] + [new] + lines[i + 1:]
    open(target, "w", encoding="utf8").write("\n".join(m))
    r = subprocess.run(["forge", "test", "--no-match-contract", "Invariant|Fork"], cwd=scratch, capture_output=True, text=True, env=env)
    out = r.stdout + r.stderr
    if "Compiler run failed" in out:
        skipped += 1
        continue
    if r.returncode == 0:
        survivors.append((i + 1, desc, lines[i].strip()))
        print(f"SURVIVED line {i+1}: {desc}: {lines[i].strip()}", flush=True)
    else:
        killed += 1
open(target, "w", encoding="utf8").write(orig)
print(f"killed {killed}, survived {len(survivors)}, uncompilable {skipped}")
sys.exit(1 if survivors else 0)
