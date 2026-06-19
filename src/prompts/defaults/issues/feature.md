---
name: feature
description: A new capability — motivation + acceptance criteria
type: Feature
jobKind: spec
enrich: false
title: "{{summary}}"
questions:
  - { key: summary, label: One-line summary, type: text, required: true }
  - { key: motivation, label: Why — problem / value, type: longtext, required: true }
  - { key: criteria, label: Acceptance criteria, type: longtext }
---

## Summary

{{summary}}

## Motivation

{{motivation}}

## Acceptance criteria

{{criteria}}
