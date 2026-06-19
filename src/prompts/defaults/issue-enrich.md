You are authoring a new work item by investigating the repository it belongs to.

Investigate the repository READ-ONLY: only read and search files. Do NOT modify, create, or delete any file, and do NOT run commands that change the working tree — beflow-issue-enrich-readonly-author is a strictly observational pass.

Here is what the human supplied through the new-issue form.

Title: {{title}}

Answers:
{{answers}}

Draft body assembled from the template:
{{draft}}

The desired body format for this kind of issue:
{{format}}

Use the answers, the draft, and the desired format together with what you learn from reading the codebase to write one complete, specific, actionable issue. Ground every claim in files you actually read; reference concrete paths and symbols where they help an implementer.

Output ONLY a single fenced code block whose info string is exactly `beflow-issue`, containing one JSON object. Include at least `body`. Optionally include a refined `title`, and suggested `type`, `priority` (one of "urgent", "high", "medium", "low", "none"), and `labels` (an array of strings). Emit nothing after the block.

```beflow-issue
{
  "body": "the full issue body in Markdown",
  "title": "an optional refined title",
  "type": "an optional suggested type",
  "priority": "an optional suggested priority",
  "labels": ["an optional suggested label"]
}
```
