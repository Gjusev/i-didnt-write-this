---
name: i-didnt-write-this
description: Turn one feature of an existing local JavaScript or TypeScript repository into an interactive, evidence-backed lesson the user can learn from in a browser. Use when the user wants to understand, review, or teach code that already exists — e.g. "help me understand how X works in this codebase", "I didn't write this, teach me it", "why does X behave like Y", "build exercises from this feature". Not for writing new features, refactoring, or programming questions that don't involve reading a real repository.
---

# I Didn't Write This

You will produce two artifacts: a validated `lesson.json` describing one
feature of the user's repository, and a standalone `lesson.html` the user opens
in any browser (works offline) to trace the code and solve three challenges
whose answers are backed by recorded executions.

Everything the toolkit needs ships inside this skill directory. Resolve paths
relative to this SKILL.md (`assets/toolkit.mjs`, `references/lesson-contract.md`).
Requires Node.js >= 20. No npm install.

## Workflow

1. **Scope one feature.** Pick a bounded flow the user asked about (typically
   2–5 functions across 1–4 files). If it sprawls, shrink to one path through
   it and say so. Never invent a scope the user did not point at.

2. **Read the code and map the flow.** For each step decide its state:
   `observed` (an execution exercised it), `inferred` (concluded by reading),
   `unobserved` (skipped). Describe what the code does; never speculate about
   why an author wrote it.

3. **Extract snippets with the toolkit** — never by hand:

   ```
   node assets/toolkit.mjs snippet --repo <REPO> --path src/thing.js --start 12 --end 30
   ```

   It returns the exact `code`, the range, and the file's sha256. Keep the
   output; it feeds `snippets[]` and `sourceSnapshot.files` in the lesson.

4. **Capture execution evidence.** Find a runnable entry the flow passes
   through (a CLI, a script, a test). Run the smallest inputs that show the
   interesting behavior:

   ```
   node assets/toolkit.mjs run --repo <REPO> --entry src/cli.js --input '{"cmd":"go"}'
   ```

   The entry runs inside an isolated temporary copy of the repo; the user's
   files are never touched. Copy the printed JSON record verbatim into
   `evidence[]`, adding only an `id`. For TypeScript that needs a custom
   command, pass `--runner "npx tsx"` — if nothing can run the code, see step 6.

5. **Author the lesson.** Follow `references/lesson-contract.md` field by
   field. Three challenges, one of each kind: `predict` (what does this input
   produce?), `trace` (which step transforms this value?), `locate` (where is
   the fault?). A challenge may claim `verifiedBy` evidence only when a
   recorded run actually pins the answer; otherwise omit it. Write titles,
   prompts, hints, and explanations in the language of the user's request, and
   set `language` plus the `ui` overrides to match.

6. **Validate, verify, build** — all three must pass before you hand anything
   over:

   ```
   node assets/toolkit.mjs check  lesson.json --repo <REPO>
   node assets/toolkit.mjs verify lesson.json --repo <REPO>
   node assets/toolkit.mjs build  lesson.json --repo <REPO> --output lesson.html
   ```

   `check` enforces the contract (structure, ranges, hashes, honesty of
   states). `verify` re-runs every recorded execution and compares stdout byte
   for byte. `build` refuses to render until `check` passes. Fix causes — never
   edit recorded outputs to make a failure disappear.

   If some part cannot be executed (missing dependency, needs a service,
   TypeScript without a runner): keep going. Mark the affected nodes
   `inferred`/`unobserved`, leave the challenge's `verifiedBy` empty, and write
   the gap into `limitations[]`. A lesson that honestly says "not verified"
   is a valid deliverable; a lesson that fakes evidence is not.

7. **Deliver.** Give the user the absolute path of `lesson.html` and tell them
   it opens offline in any browser; answers are self-checked in the page and
   hints are progressive. Keep `lesson.json` next to it — re-running
   `verify` later tells the user whether the lesson still matches their code.

## Optional follow-up: guided repair

If the user wants to fix a fault the lesson located, work in a scratch copy
under the system temp dir (copy the file(s), let the user propose the change),
re-run `toolkit run` against the scratch copy to show the behavior change, and
only suggest applying it to their repo with their explicit approval. Never edit
the user's repository directly.

## Hard rules

- The user's repository stays byte-identical: all execution happens in
  toolkit-managed temporary copies.
- Evidence must be verbatim toolkit output. No hand-written stdout.
- `observed` only with a cited successful execution; comments in code are not
  evidence of behavior.
- Stale references (file changed after authoring) are surfaced as warnings,
  never silently re-pointed.
- The exported HTML executes nothing; it only renders recorded results.
