---
name: spike
description: A time-boxed investigation — a question to answer
type: Spike
jobKind: triage
enrich: false
title: "{{summary}}"
questions:
  - { key: summary, label: Question / goal, type: text, required: true }
  - { key: context, label: Context / background, type: longtext }
  - { key: outcome, label: Expected outcome / deliverable, type: text }
---

## Question

{{summary}}

## Context

{{context}}

## Expected outcome

{{outcome}}
