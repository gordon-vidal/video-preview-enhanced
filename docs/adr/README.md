# Architecture Decision Records (ADRs)

Short, durable records of key product and architecture decisions.

## Rules

- **Keep every ADR super short** — a few tight bullet points, no essays.
- **Exact match to the maintainer:** capture what the maintainer actually decided, not an agent's extrapolation.
- **Maintainer sign-off required:** agents may draft an ADR (`Status: Draft`), but **never** mark it signed off until the maintainer explicitly approves the wording.

## Template (`NNNN-<short-topic>.md`)

```markdown
# NNNN: <Short title>

- **Status:** Draft | Signed off by maintainer (YYYY-MM-DD)

## Decision
- <1–2 concise bullets stating what was decided>

## Why
- <1–2 concise bullets stating the core reason>

## Discussed & rejected
- <Alternative> — <why it was rejected>
```
