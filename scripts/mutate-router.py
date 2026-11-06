#!/usr/bin/env python3
"""Low-memory, resumable mutation sweep for PaymentRouter.sol.

Works on a scratch copy OUTSIDE the repo; never edits the repo. One mutant at a time, lean profile
(optimizer off, 50 fuzz runs, invariant/fork tests skipped), a free-memory check before each mutant, and the
result file is rewritten after every mutant so a stop resumes where it left off.

  python scripts/mutate-router.py [--scratch DIR] [--max N] [--min-free-gb 1.5]
Needs forge on PATH. Result: <scratch>/mutants.json  (also summarised on stdout).
"""
import argparse, ctypes, json, os, re, shutil, subprocess, sys, tempfile, time

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ap = argparse.ArgumentParser()
ap.add_argument("--scratch", default=os.path.join(tempfile.gettempdir(), "qp-mutants"))
ap.add_argument("--max", type=int, default=60)
ap.add_argument("--min-free-gb", type=float, default=1.5)
args = ap.parse_args()
scratch = args.scratch
resfile = os.path.join(os.path.dirname(scratch), "qp-mutants.json")


def free_gb():
    class MS(ctypes.Structure):
        _fields_ = [("l", ctypes.c_ulong), ("load", ctypes.c_ulong), ("tp", ctypes.c_ulonglong), ("ap", ctypes.c_ulonglong),
                    ("tpf", ctypes.c_ulonglong), ("apf", ctypes.c_ulonglong), ("tv", ctypes.c_ulonglong),
                    ("av", ctypes.c_ulonglong), ("ae", ctypes.c_ulonglong)]
    try:
        m = MS(); m.l = ctypes.sizeof(MS)
        ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(m))
        return m.ap / 2**30
    except Exception:
        try:
            for ln in open("/proc/meminfo"):
                if ln.startswith("MemAvailable"):
                    return int(ln.split()[1]) / 2**20
        except Exception:
            pass
    return 99.0


done = {}
if os.path.exists(resfile):
    done = {f"{r['line']}|{r['desc']}": r for r in json.load(open(resfile))}

shutil.rmtree(scratch, ignore_errors=True)
shutil.copytree(os.path.join(REPO, "contracts"), scratch, ignore=shutil.ignore_patterns("out", "cache", "broadcast"))
fx = os.path.join(os.path.dirname(scratch), "packages")
shutil.rmtree(fx, ignore_errors=True)
os.makedirs(os.path.join(fx, "shared"))
shutil.copytree(os.path.join(REPO, "packages/shared/fixtures"), os.path.join(fx, "shared/fixtures"))
shutil.copy(os.path.join(REPO, "packages/shared/token.json"), os.path.join(fx, "shared/token.json"))

target = os.path.join(scratch, "src/PaymentRouter.sol")
orig = open(target, encoding="utf8", newline="").read()
nl = "\r\n" if "\r\n" in orig else "\n"
lines = orig.split(nl)

# priority 0 = security guards, 1 = comparisons, 2 = the rest
mutants = []
for i, ln in enumerate(lines):
    t = ln.strip()
    if t.startswith(("//", "*", "/*")):
        continue
    if re.search(r"\bif \(.*\) revert ", t):
        mutants.append((0, i, "delete guard", re.sub(r"\bif \(.*\) revert \w+\(\);", ";", ln)))
        head = ln.split("revert")[0]
        for a, b in [(" >= ", " > "), (" > ", " >= "), (" <= ", " < "), (" < ", " <= "), (" != ", " == "), (" == ", " != "), (" || ", " && ")]:
            if a in head:
                mutants.append((1, i, f"flip{a}->{b}", ln.replace(a, b, 1)))
    if re.search(r"\bonly(Owner|Relayer)\b|whenNotPaused|nonReentrant", t) and "function" in t:
        mutants.append((0, i, "drop modifier", re.sub(r"\s+(onlyOwner|onlyRelayer|whenNotPaused|nonReentrant)", "", ln)))
    if "totalRefunded +=" in t:
        mutants.append((0, i, "totalRefunded += -> =", ln.replace("+=", "=")))
    if "safeTransfer(" in t:
        mutants.append((0, i, "delete transfer", "// " + ln))
    if "uint32(index + 1)" in t:
        mutants.append((1, i, "refundCount not advanced", "// " + ln))
    if re.match(r"\s*_pull\(", ln) or "_pull(" in t and "function" not in t and "private" not in t:
        mutants.append((0, i, "delete pull call", "// " + ln))
    if "if (v < 27) v += 27" in t:
        mutants.append((2, i, "drop v normalisation", "// " + ln))
    if "after_ - before_ != value" in t:
        mutants.append((0, i, "balance delta check weakened", ln.replace("after_ - before_ != value", "false")))
    if "r.settled" in t and "revert" in t:
        mutants.append((0, i, "settled check removed", "// " + ln))
mutants.sort(key=lambda m: (m[0], m[1]))
mutants = mutants[: args.max]
print(f"{len(mutants)} mutants selected", flush=True)

env = dict(os.environ, FOUNDRY_OPTIMIZER="false", FOUNDRY_FUZZ_RUNS="50", FOUNDRY_INVARIANT_RUNS="1", FOUNDRY_INVARIANT_DEPTH="1")
results = list(done.values())
for pr, i, desc, new in mutants:
    key = f"{i+1}|{desc}"
    if key in done or new == lines[i]:
        continue
    while free_gb() < args.min_free_gb:
        print(f"free memory {free_gb():.1f} GB < {args.min_free_gb}; waiting 60s", flush=True)
        time.sleep(60)
    open(target, "w", encoding="utf8", newline="").write(nl.join(lines[:i] + [new] + lines[i + 1:]))
    r = subprocess.run(["forge", "test", "-q", "--no-match-test", "invariant", "--no-match-contract", "Invariant|Fork|ExpectedLimitations|DeployScripts"],
                       cwd=scratch, capture_output=True, text=True, env=env)
    out = r.stdout + r.stderr
    status = "uncompilable" if "Compiler run failed" in out else ("survived" if r.returncode == 0 else "killed")
    rec = {"line": i + 1, "desc": desc, "original": lines[i].strip(), "status": status}
    results.append(rec)
    json.dump(results, open(resfile, "w"), indent=1)
    print(f"{status:12} line {i+1}: {desc}: {lines[i].strip()[:80]}", flush=True)

open(target, "w", encoding="utf8", newline="").write(orig)
s = {k: sum(1 for r in results if r["status"] == k) for k in ("killed", "survived", "uncompilable")}
print("SUMMARY", s, "results:", resfile)
sys.exit(1 if s["survived"] else 0)
