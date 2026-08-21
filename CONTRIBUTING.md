# Contributing

Thank you for looking at the engine closely enough to want to change it.

**The front door is Issues.** A clear report — what you did, what happened,
what you expected — is a contribution in itself, and it is where every
change here starts, including ours.

**Pull requests are welcome, with honest expectations.** This product runs
law firms' matters and holds client money, so nothing lands casually:

- Every schema change is a numbered file in `schema/changes/` with a paired
  proof in `schema/tests/` that fails without it. Application changes keep
  the whole suite green (`tools/validate-app.py`).
- Money, trust-accounting and permission behaviour follows the design's
  invariants — a change that weakens a guard, a ceremony or the register
  will be declined however elegant it is.
- The maintainers review every contribution and land accepted changes
  through the project's own release process, so your change may arrive in a
  release commit rather than as a direct merge. You will be credited in the
  release notes either way.

**Discussing before building** saves everyone time: open an issue describing
the problem first, and we will say whether a change is likely to land and
what shape it needs.
