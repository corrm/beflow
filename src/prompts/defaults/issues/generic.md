---
name: generic
description: A blank issue — summary plus free-form context
enrich: false
questions:
  - { key: summary, label: One-line summary, type: text, required: true }
  - { key: context, label: Context / details, type: longtext }
---

## Summary

{{summary}}

## Context

{{context}}
