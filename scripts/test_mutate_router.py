"""Safety tests for scripts/mutate-router.py scratch handling. Run: python -m unittest scripts/test_mutate_router.py

Only the argument/path guard is exercised: every refusal case must exit 2 BEFORE anything is deleted or copied.
(The red phase of these tests was NOT run against the old script: it would have deleted the repo.)
"""
import os, subprocess, sys, tempfile, unittest

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
SCRIPT = os.path.join(HERE, "mutate-router.py")


def run(scratch):
    return subprocess.run([sys.executable, SCRIPT, "--scratch", scratch, "--max", "0"], capture_output=True, text=True)


class ScratchGuard(unittest.TestCase):
    def test_refuses_repo_root(self):
        r = run(REPO)
        self.assertEqual(r.returncode, 2, r.stdout + r.stderr)
        self.assertTrue(os.path.isdir(os.path.join(REPO, "contracts")))

    def test_refuses_inside_repo(self):
        r = run(os.path.join(REPO, "contracts", "qp-victim-scratch"))
        self.assertEqual(r.returncode, 2, r.stdout + r.stderr)
        self.assertTrue(os.path.isfile(os.path.join(REPO, "contracts", "src", "PaymentRouter.sol")))

    def test_refuses_parent_of_repo(self):
        r = run(os.path.dirname(REPO))
        self.assertEqual(r.returncode, 2, r.stdout + r.stderr)
        self.assertTrue(os.path.isdir(os.path.join(REPO, "contracts")))

    def test_refuses_nonempty_unmarked_directory(self):
        with tempfile.TemporaryDirectory() as t:
            s = os.path.join(t, "scratch")
            os.makedirs(s)
            keep = os.path.join(s, "precious.txt")
            open(keep, "w").write("x")
            r = run(s)
            self.assertEqual(r.returncode, 2, r.stdout + r.stderr)
            self.assertTrue(os.path.exists(keep))

    def test_refuses_unmarked_sibling_packages_dir(self):
        with tempfile.TemporaryDirectory() as t:
            pk = os.path.join(t, "packages")
            os.makedirs(pk)
            keep = os.path.join(pk, "precious.txt")
            open(keep, "w").write("x")
            r = run(os.path.join(t, "scratch"))
            self.assertEqual(r.returncode, 2, r.stdout + r.stderr)
            self.assertTrue(os.path.exists(keep))

    def test_refuses_symlink_into_repo(self):
        with tempfile.TemporaryDirectory() as t:
            link = os.path.join(t, "lnk")
            try:
                os.symlink(REPO, link, target_is_directory=True)
            except (OSError, NotImplementedError):
                self.skipTest("symlinks unavailable")
            r = run(link)
            self.assertEqual(r.returncode, 2, r.stdout + r.stderr)
            self.assertTrue(os.path.isdir(os.path.join(REPO, "contracts")))

    def test_accepts_fresh_scratch_and_creates_markers(self):
        with tempfile.TemporaryDirectory() as t:
            s = os.path.join(t, "scratch")
            r = run(s)
            self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
            self.assertTrue(os.path.isfile(os.path.join(s, ".qp-mutants-scratch")))
            self.assertTrue(os.path.isfile(os.path.join(t, "packages", ".qp-mutants-scratch")))
            # a second run over its own marked scratch is allowed
            self.assertEqual(run(s).returncode, 0)


if __name__ == "__main__":
    unittest.main()
