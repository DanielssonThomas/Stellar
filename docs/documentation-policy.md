# Documentation policy

## Ownership

- `README.md` introduces the repository and links to deeper material.
- `docs/architecture/` describes the system as it currently exists; identify planned behavior as planned.
- `docs/decisions/` preserves rationale for consequential decisions. Supersede changed decisions rather than erasing their history.
- `docs/guides/` contains verified, repeatable procedures.
- `docs/incidents/` is reserved for significant incidents whose lessons outlive their issue.
- `docs/implementation/roadmap.md` links milestones to GitHub Epics and issues. GitHub owns task status.
- `AGENTS.md` defines durable repository-wide agent expectations. Skills define repeatable workflows.

## Before adding a document

Find the current authoritative document first. Add to it when it owns the topic. Create a new file only when the topic has a distinct, durable purpose that another developer or agent will need. Do not copy issue descriptions, session logs, or implementation history into documentation.

## Writing and maintenance

Use clear titles, short paragraphs, direct language, and links to source or authoritative guidance. Keep each document focused. Avoid placeholder files, duplicated rules, speculative descriptions, decorative prose, and examples that merely copy code.

When code changes affect documented behavior or operations, update the owning document in the same PR when practical. Correct outdated claims, preserve superseded decisions, and check relative links. Internal changes that leave documentation accurate need no documentation edit.

Markdown must remain portable to GitHub and Obsidian. This repository is the only maintained copy of technical documentation.
