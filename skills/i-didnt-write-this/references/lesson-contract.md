# Lesson contract (schema version 1)

A lesson is a single JSON document that describes one feature of one repository.
The toolkit validates it, re-runs its evidence, and renders it as a standalone
HTML page. This document is the authoring reference: every field, every rule
the toolkit enforces, and what each state is allowed to claim.

Design rules that run through the whole schema:

- **Execution outranks reading.** Anything marked as *observed* must cite a
  recorded, successful execution. Everything else is *inferred* (you read the
  code) or *unobserved* (you did not examine it).
- **References are pinned.** Every cited file is hashed. If the file changes
  after authoring, the lesson shows an outdated-reference warning instead of
  silently pointing at different code.
- **Nothing is executed in the viewer.** The exported page only renders
  recorded results. The user's repository is never touched by a lesson.

## Top-level fields

| Field | Type | Rules |
| --- | --- | --- |
| `schemaVersion` | number | Must be exactly `1`. |
| `id` | string | Slug `[a-z0-9][a-z0-9-]*`, unique within the lesson set. |
| `title` | string | Question-shaped titles work best ("Where did X go?"). |
| `objective` | string | One sentence: what the learner will be able to explain. |
| `language` | string | BCP-47 tag of the lesson content (`"en"`, `"es"`, …). Match the language of the user's request. |
| `feature` | string | Short name of the feature being taught. |
| `sourceSnapshot` | object | See below. |
| `snippets` | array | Cited code fragments. |
| `flow` | object | Steps of the feature (`nodes`, `links`). |
| `challenges` | array | At least one; aim for one `predict`, one `trace`, one `locate`. |
| `evidence` | array | Recorded executions. May be empty (everything unverified). |
| `ui` | object? | Optional strings to localize the viewer chrome. |
| `limitations` | array | Honest list of what was not run, not seen, or assumed. |

## `sourceSnapshot`

```json
{ "revision": "ab12cd34…", "files": { "src/store.js": "<sha256>" } }
```

- `revision`: the repo's commit id at authoring time, or `null` when the repo
  has no VCS. If the repo's current commit differs, `check` warns.
- `files`: every path cited by `snippets` (and ideally by `evidence.entries`)
  mapped to the sha256 of its content at authoring time. The `snippet` command
  prints this hash for you.

Freshness semantics enforced by `check`:

- File content changed → **warning**, snippet keeps showing the recorded code
  with a visible "file changed" flag. References are never re-pointed.
- File deleted or path invalid → **error**.
- Snippet `code` no longer matches the (unchanged) file → **error**: the
  recorded fragment was edited by hand.

## `snippets[]`

| Field | Rules |
| --- | --- |
| `id` | Slug, unique. |
| `path` | Repo-relative, no `..`, never absolute. Must be a key in `sourceSnapshot.files`. |
| `startLine`, `endLine` | 1-based inclusive. Must exist in the file; the `snippet` command rejects ranges past EOF. |
| `code` | Exact lines `startLine..endLine` joined with `\n`. Line count must equal `endLine - startLine + 1`. |
| `why` | Optional: one line on why this fragment matters. |

Always extract snippets with the toolkit's `snippet` command instead of copying
by hand; it guarantees `code`, range, and hash agree.

## `flow`

```json
{
  "nodes": [
    { "id": "n-reload", "label": "reload restores the items and recalculates every total",
      "snippetId": "s-reload", "state": "observed",
      "evidenceIds": ["e-reload"], "note": "what the recorded run showed here" }
  ],
  "links": [ { "from": "n-serialize", "to": "n-reload", "label": "saved JSON on next load" } ]
}
```

- `state` is the honesty core of the lesson:
  - `observed` — a cited execution exercised this step. **Requires** at least
    one referenced evidence entry with exit code 0 and no timeout.
  - `inferred` — you concluded this from reading the code. Citing successful
    execution here produces a warning (it should be `observed`).
  - `unobserved` — present in the path but not examined. Say so; do not guess.
- Node labels describe *what happens*, never *why the author wrote it*.
- 3–6 nodes is the sweet spot. More means the feature is too big — shrink the
  scope instead of shrinking the honesty.
- `links` connect node ids; optional `label` names the data that flows.

## `challenges[]`

Three kinds, one of each per lesson:

| Kind | Asks | Typical verification |
| --- | --- | --- |
| `predict` | "Given this input, what does the code print/return?" | An execution with exactly that input. |
| `trace` | "Which step produces/transforms this value?" | The execution whose output shows the value at that step. |
| `locate` | "Where is the fault / the responsible line?" | An execution that demonstrates the faulty behavior, narrowing the location by what it rules out. |

Fields:

| Field | Rules |
| --- | --- |
| `kind` | `predict` \| `trace` \| `locate`. |
| `prompt` | The question, self-contained. |
| `displayInput` | Optional JSON shown to the learner (e.g. the exact command input). |
| `snippetIds` | Optional snippets worth inspecting; shown as links to the flow steps. |
| `options` | 2–4 options, each `{ id, text }`; ids are slugs; texts are self-describing. |
| `answer` | Exactly one option id. |
| `verifiedBy` | Optional list of evidence ids. If present, every cited entry must be an execution with exit code 0 and no timeout — otherwise the lesson does not validate. Leave it empty rather than citing anything weaker. |
| `hints` | 0–3 strings, ordered from gentle to explicit. |
| `explanation` | Why the answer is right; reference the recorded output when verified. |

The renderer never labels a challenge "verified" without non-empty `verifiedBy`
that passes validation. An unverified challenge renders an explicit "no
execution evidence recorded" note instead.

Good distractors are *wrong for a real reason* (an off-by-one, the value before
a transform, a plausible-but-not-cited file). Do not include joke options.

## `evidence[]`

Each entry is a verbatim output of the toolkit's `run` command plus an `id`.
Copy it from the command's JSON output; do not retype it.

```json
{
  "id": "e-checkout",
  "kind": "execution",
  "command": "node src/index.js",
  "runner": "node",
  "entry": "src/index.js",
  "input": { "cmd": "checkout", "items": [], "coupon": "TENPCT" },
  "timeoutMs": 10000,
  "exitCode": 0,
  "timedOut": false,
  "stdout": "{…}\n",
  "stderr": "",
  "entryFileHash": "<sha256 of the entry file when captured>",
  "durationMs": 75
}
```

`verify` re-runs every entry against the repo and compares `exitCode`,
`timedOut`, and `stdout` byte for byte. A mismatch means the lesson no longer
describes this repository — fix the code or regenerate the lesson.

## `ui` (optional)

Override the viewer's built-in English strings when `language` is not English:

```json
{ "solvedProgress": "Resueltas {n} de {total}", "incorrect": "✗ Incorrecto.",
  "selectAnswer": "Elige una opción primero.", "correctVerified": "✓ Correcto. Respaldado por la ejecución grabada.",
  "correctPlain": "✓ Correcto.", "skipToChallenges": "Saltar a los retos" }
```

`solvedProgress` may use `{n}` and `{total}` placeholders.

## `limitations[]`

Write down, as plain sentences, everything a careful reviewer would ask about:
paths not executed, dependencies unavailable, results that depend on timing or
environment, simplifications you made. An empty array is a claim that nothing
was left out — make sure that is true before you leave it empty.
