End your FINAL message with a fenced code block whose info string is exactly `beflow-report`, containing a single JSON object:

```beflow-report
{
  "status": "done" | "needs_input" | "blocked" | "failed",
  "summary": "one or two sentences on what you did",
  "prUrl": "https://… (only when you opened a PR)",
  "questions": ["…"],
  "notes": "extra detail (required when status is failed)"
}
```

Status meanings:

- "done" — the work is complete; if it produced code, a PR is open and its URL is in `prUrl`.
- "needs_input" — you cannot proceed without a human decision; put the exact decisions you need in `questions`.
- "blocked" — you are waiting on an external dependency (another party, an upstream change, access you don't have); explain in `notes`.
- "failed" — you could not complete the work; explain why in `notes`.

Emit exactly one such block, as the last thing in your final message.
