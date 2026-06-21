End your FINAL message with a fenced code block whose info string is exactly `beflow-report`, containing a single JSON object:

```beflow-report
{
  "status": "done" | "needs_input" | "blocked" | "failed",
  "summary": "one or two sentences on what you did",
  "prUrl": "https://… (only when you opened a PR)",
  "questions": ["…"],
  "notes": "extra detail (required when status is failed)",
  "receipt": { … see below … }
}
```

Status meanings:

- "done" — the work is complete; if it produced code, a PR is open and its URL is in `prUrl`.
- "needs_input" — you cannot proceed without a human decision; put the exact decisions you need in `questions`.
- "blocked" — you are waiting on an external dependency (another party, an upstream change, access you don't have); explain in `notes`.
- "failed" — you could not complete the work; explain why in `notes`.

## Change receipt (optional)

When your run changed code, INCLUDE a `receipt` object so the policy gate can judge
intent and risk, not just the changed file paths. Triage and spec runs that change
nothing may omit it. Do NOT include the issue id or branch — beflow already knows them.

```jsonc
"receipt": {
  "intent": "one or two lines: what this change does and why",
  "riskSurfaces": ["app", "auth"],
  "surfaceNotes": { "auth": "adds a new login route; no change to token signing" },
  "filesTouched": ["src/api/auth.ts"],
  "testsRun": ["bun test test/auth.test.ts"],
  "uncertainty": "unsure whether the rate limit default is appropriate",
  "nextDecision": "confirm the rate-limit value before enabling in prod"
}
```

- `intent` (required) — what the change does and why, in one or two lines.
- `riskSurfaces` (required) — the risk surfaces this change touches, from the taxonomy below.
- `surfaceNotes` (optional) — a policy-relevant note per surface, keyed by surface name.
- `filesTouched` (optional) — the files you changed (beflow still computes the real diff).
- `testsRun` (optional) — the tests or commands you ran.
- `uncertainty` (optional) — what you are unsure about.
- `nextDecision` (optional) — the next human decision needed, if any.

Risk-surface taxonomy:

- `app` — application/product code and business logic.
- `deps` — dependencies, lockfiles, package manifests.
- `infra` — infrastructure, deployment, runtime config.
- `auth` — authentication, authorization, secrets, access control.
- `data` — schemas, migrations, data handling, persistence.
- `ci` — CI/CD pipelines and build automation.

Emit exactly one such block, as the last thing in your final message.
