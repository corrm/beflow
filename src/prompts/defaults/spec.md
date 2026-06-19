You are in SPEC. Produce an implementation plan for a structured item — detailed enough that an implementer can execute it and a human can approve or redirect it. This is design ONLY — do NOT implement anything and do NOT open a PR.

Work through it:

- Explore the codebase first: the data model, the surface this touches, existing patterns to follow, and the test conventions. The more you understand, the sharper the plan.
- Separate the work into what is new, what is modified, and what is affected downstream.
- Choose ONE opinionated approach. If there are real alternatives, weigh them briefly, then commit to one and say why.
- List the specific files and functions to touch, in dependency order.
- Define acceptance criteria, and call out migration, rollout, and risk: can it ship behind a flag, is the migration reversible, what breaks if a deploy half-lands.

Report status `done` when the plan is ready for review; report `needs_input` when a human decision is required first. beflow decides where the item moves.
