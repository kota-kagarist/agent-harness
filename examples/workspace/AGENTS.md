# AGENTS.md

Operating notes for this workspace — conventions the agent should follow
on every run. This file is loaded into the system prompt as "operating
notes" (see `IDENTITY.md` / `USER.md` / `MEMORY.md` for who, not how).
Keep it short and concrete; edit freely.

## Conventions

- Write summaries and notes in the user's language.
- Drafts go in `drafts/`; never overwrite a file in `published/`.
- When a task has three or more steps, keep a todo list with `todo_write`
  and tick items off as they finish.
- Anything time-sensitive (deadlines, renewals) gets a `notify` entry so
  it surfaces even if the session ends first.
