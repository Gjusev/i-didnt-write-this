# I Didn't Write This

[![skills.sh](https://skills.sh/b/Gjusev/i-didnt-write-this)](https://skills.sh/Gjusev/i-didnt-write-this)

Vibe-coded it? Now understand it.

An agent skill that turns **one feature** of your JavaScript or TypeScript
project into an interactive, evidence-backed lesson: follow the data through
the real source, predict what it does, and locate a fault — with every answer
that can be checked against an actual recorded execution of your code.

Everything runs locally. No accounts, no cloud, no telemetry.

## Install

The quickest way, in any project — the [skills.sh](https://skills.sh)
installer copies the skill in as plain files you own, for whichever coding
agents you use (Claude Code, Codex, Cursor, …):

```sh
npx skills@latest add Gjusev/i-didnt-write-this
```

Non-interactive, e.g. just Claude Code:

```sh
npx skills@latest add Gjusev/i-didnt-write-this -s i-didnt-write-this -a claude-code --copy
```

Requires [Node.js](https://nodejs.org) >= 22. Two alternatives:

```sh
npm install -g i-didnt-write-this   # just the `idwt` CLI (skill ships inside the package)
cp -r skills/i-didnt-write-this ~/.claude/skills/   # manual copy from a clone
```

Install **before** starting your agent session, so the skill is discovered on
startup.

### Claude Code plugin

Claude Code users can install the managed plugin from this repository's
marketplace:

```text
/plugin marketplace add Gjusev/i-didnt-write-this
/plugin install i-didnt-write-this@i-didnt-write-this
```

## Use it with your agent

The skill lives in `skills/i-didnt-write-this/` (inside the repo, or inside
`node_modules/i-didnt-write-this/` when installed from npm). How you wire it
up depends on your agent:

### Claude Code *(verified: auto-discovery tested end to end)*

Install with the skills.sh installer (see [Install](#install)) or copy the
skill into `~/.claude/skills/` (user-level) or `.claude/skills/` (per project)
**before starting the session**, then just ask naturally:

> “I didn't write this code — help me understand how the discount logic works
> in this project, with exercises.”
>
> «No escribí esta funcionalidad; enséñamela con una lección interactiva.»

Claude discovers the skill from its description and runs the whole pipeline:
trace, execute in isolated copies, validate, and hand you a `lesson.html`.

### Codex CLI / any agent that reads AGENTS.md

Add a pointer rule to your project's `AGENTS.md`:

```markdown
## Understanding existing code
When the user asks to understand, learn, or teach a feature of this
repository (e.g. "help me understand how X works", "I didn't write this"),
follow the instructions in
node_modules/i-didnt-write-this/skills/i-didnt-write-this/SKILL.md
and use its toolkit for evidence, validation, and rendering.
```

### Cursor

Same idea as a project rule — `.cursor/rules/i-didnt-write-this.mdc`:

```
---
description: Understand an existing feature via an evidence-backed lesson
globs:
alwaysApply: false
---
When the user asks to understand or learn an existing feature of this
repository, follow
node_modules/i-didnt-write-this/skills/i-didnt-write-this/SKILL.md
and use its toolkit (`idwt`) for snippets, execution evidence, validation,
and rendering.
```

### Gemini CLI

Add the same pointer to your project's `GEMINI.md` (same content as the
AGENTS.md snippet above).

> Auto-activation is verified on Claude Code. The pointer pattern works with
> any agent that reads AGENTS.md / Cursor rules / GEMINI.md — it is the same
> instruction in three conventions. If your harness has native skills, copy
> the folder there instead.

## Use it without an agent

The toolkit is a plain CLI. Use `idwt` after `npm install -g
i-didnt-write-this`, or make a project-local install without changing its
manifest or lockfile:

```sh
npm install --no-save --package-lock=false i-didnt-write-this

npx idwt snippet --repo . --path src/store.js --start 9 --end 17   # verified snippet + hash
npx idwt run     --repo . --entry src/cli.js --input '{"cmd":"x"}'  # isolated run, JSON evidence record
npx idwt run     --repo . --entry __driver.mjs --add __driver.mjs=./driver.mjs   # driver evidence
npx idwt check   lesson.json --repo .                               # contract + freshness validation
npx idwt verify  lesson.json --repo .                               # re-runs all recorded evidence
npx idwt build   lesson.json --repo . --output lesson.html          # standalone HTML lesson
```

After either installation, invoke the copied skill directly with
`node <skill>/assets/toolkit.mjs` if you prefer not to use the bin wrapper.

Author `lesson.json` following
[`skills/i-didnt-write-this/references/lesson-contract.md`](skills/i-didnt-write-this/references/lesson-contract.md).
Run toolkit commands as single `node <path> <args>` invocations with absolute
paths — wrapping them in `cd … && …` can break permission allowlists.

The resulting `lesson.html` opens offline in any browser. Answers are
self-checked in the page; challenges marked *verified* show the recorded
execution next to them, and lessons whose code has drifted say so instead of
guessing.

## Development

```sh
npm test          # toolkit + fixture tests: contract validation, freshness, executor, escaping, CLI
npm run test:e2e  # Playwright browser suite (challenges, keyboard, escaping, offline, responsive, a11y)
npm run test:all  # both
```

- `fixtures/cart`, `fixtures/limiter` — synthetic teaching projects with known
  behavior and their own test suites.
- `tests/fixtures/*-lesson.json` — reference lessons whose recorded evidence
  is re-executed and compared byte for byte on every test run.
- `tests/` — the toolkit's own test suite (plain `node:test`).
- `e2e/` — the browser suite; it builds its lesson pages with the real
  toolkit pipeline at setup time (`@playwright/test` + `@axe-core/playwright`
  are the only dev dependencies).

### What is and isn't verified

- The executor runs `.js`/`.mjs` entries with `node` (custom `--runner` for
  TypeScript, e.g. `npx tsx`; Node >= 23 can also run erasable `.ts` sources
  natively). Where code cannot be executed, the skill records challenges as
  unverified with an explicit note — never as fake evidence.
- The exported HTML renders recorded output only; it never executes code, and
  all content is HTML-escaped.

## License

MIT. See [LICENSE](LICENSE).
