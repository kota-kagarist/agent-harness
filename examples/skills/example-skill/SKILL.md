---
name: example-skill
description: A template skill showing the SKILL.md format — replace with your own reusable procedure.
---

# Example skill

This file is the body of the skill. When the agent calls
`load_skill("example-skill")`, this text is what it receives, so write it
as direct instructions to the agent:

1. State the goal of the procedure in one line.
2. List the steps in order, naming the tools to use.
3. Note the pitfalls: what to check before acting, what never to do.

Copy this directory to `workspace/skills/<your-skill-name>/`, edit the
frontmatter (`name`, `description`) and this body, and the skill will show
up in the agent's system prompt automatically — only the name and
description are loaded until the skill is actually used.
