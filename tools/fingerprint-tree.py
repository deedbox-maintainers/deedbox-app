# fingerprint-tree.py — prove that what shipped is what was tested.
#
# The standing discipline for this repository is that the working tree is
# fingerprinted BEFORE the gates run and re-checked at the moment of commit.
# Anything edited while a gate was running would otherwise ship untested, and
# the gates read files lazily, so a mid-run edit is not merely untested — it
# can be half-tested.
#
# The fingerprint covers every file git would consider: tracked files as they
# stand in the working tree, plus untracked files that are not ignored.
#
#   python tools/fingerprint-tree.py            print the fingerprint
#   python tools/fingerprint-tree.py --check X  exit 1 unless it still equals X

import argparse
import hashlib
import os
import subprocess
import sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def files():
    out = subprocess.run(
        ["git", "-C", REPO, "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
        capture_output=True, check=True,
    ).stdout
    return sorted(p for p in out.decode("utf-8").split("\0") if p)


def fingerprint():
    h = hashlib.sha256()
    n = 0
    for rel in files():
        path = os.path.join(REPO, rel)
        if not os.path.isfile(path):
            continue  # a staged deletion; its absence is covered by the name list
        h.update(rel.encode("utf-8"))
        h.update(b"\0")
        with open(path, "rb") as fh:
            while True:
                chunk = fh.read(1 << 20)
                if not chunk:
                    break
                h.update(chunk)
        h.update(b"\0")
        n += 1
    return h.hexdigest(), n


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", help="the fingerprint the tree must still have")
    a = ap.parse_args()
    fp, n = fingerprint()
    if a.check:
        if fp == a.check:
            print(f"tree unchanged: {fp} ({n} files)")
            return 0
        print(f"TREE CHANGED since the gates ran\n  was {a.check}\n  now {fp} ({n} files)")
        return 1
    print(f"{fp}  ({n} files)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
