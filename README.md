# I Didn't Write This

Vibe-coded it? Now understand it.

An agent skill that turns **one feature** of your JavaScript or TypeScript
project into an interactive, evidence-backed lesson: follow the data through
the real source, predict what it does, and locate a fault — with every answer
that can be checked against an actual recorded execution of your code.

Everything runs locally. No accounts, no cloud, no telemetry.

## Try the demo

Open [`examples/cart/lesson.html`](examples/cart/lesson.html) in any browser —
no server, no internet needed. It teaches a small synthetic cart project where
a coupon discount silently disappears after a reload, using real recorded runs
of `fixtures/cart` as evidence.

## Install

1. You need [Node.js](https://nodejs.org) >= 20 on your machine. That is the
   only requirement — the toolkit has zero npm dependencies.
2. Copy or clone this repository, then add the skill to your agent. For Claude
   Code, from this repository run:

   ```sh
   mkdir -p ~/.claude/skills
   cp -r skills/i-didnt-write-this ~/.claude/skills/
   ```

   (For other agents, follow that agent's skill conventions — the skill is a
   self-contained folder: `SKILL.md`, `references/`, `assets/`.)

## Use

Ask your agent about a feature of a local repo, for example:

- “I didn't write this code — help me understand how the discount logic works
  in this project, with exercises.”
- “Why does reloading the cart lose the coupon? Teach me.”

The agent will trace the feature, run real cases in isolated copies (your
files are never modified), and hand you a standalone `lesson.html` you can
open offline. Answers are self-checked in the page; each challenge marked
*verified* is backed by a recorded execution shown next to it, and lessons
whose code has drifted out of date say so instead of guessing.

## Toolkit (works without an agent)

The deterministic helpers are a plain CLI. From this repository:

```sh
T=skills/i-didnt-write-this/assets/toolkit.mjs

node $T snippet --repo <REPO> --path src/file.js --start 12 --end 30   # verified snippet + hash
node $T run     --repo <REPO> --entry src/cli.js --input '{"cmd":"x"}' # isolated run, JSON record
node $T check   lesson.json --repo <REPO>                              # contract + freshness validation
node $T verify  lesson.json --repo <REPO>                              # re-runs all recorded evidence
node $T build   lesson.json --repo <REPO> --output lesson.html         # standalone HTML lesson
```

The lesson format is documented in
[`skills/i-didnt-write-this/references/lesson-contract.md`](skills/i-didnt-write-this/references/lesson-contract.md).

## Development

```sh
npm test      # toolkit + fixture tests: contract validation, freshness, executor, escaping, CLI
npm run demo  # re-verifies the demo lesson's evidence and rebuilds its HTML
```

- `fixtures/cart`, `fixtures/limiter` — synthetic teaching projects with known
  behavior and their own test suites.
- `tests/` — the toolkit's own test suite (plain `node:test`, no dependencies).
- `examples/cart/` — a committed demo lesson; `npm run demo` must reproduce
  its HTML byte for byte.

### What is and isn't verified

- The executor runs `.js`/`.mjs` entries with `node` (custom `--runner` for
  TypeScript, e.g. `npx tsx`, if your project has one). Where code cannot be
  executed, the skill records challenges as unverified with an explicit note —
  never as fake evidence.
- The exported HTML renders recorded output only; it never executes code, and
  all content is HTML-escaped.

## License

MIT. See [LICENSE](LICENSE).
