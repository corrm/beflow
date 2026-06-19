---
name: bug
description: A reproducible defect — steps, expected vs actual
type: Bug
jobKind: implement
priority: high
enrich: false
title: "{{summary}}"
questions:
  - { key: summary, label: One-line summary, type: text, required: true }
  - { key: steps, label: Steps to reproduce, type: longtext, required: true }
  - { key: expected, label: Expected behaviour, type: text }
  - { key: actual, label: Actual behaviour, type: text }
  - { key: severity, label: Severity, type: options, options: [low, medium, high, critical] }
---

## Summary

{{summary}}

## Steps to reproduce

{{steps}}

## Expected

{{expected}}

## Actual

{{actual}}

## Severity

{{severity}}
