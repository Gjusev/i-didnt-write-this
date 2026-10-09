#!/usr/bin/env node
// I Didn't Write This — deterministic toolkit for building evidence-backed lessons.
//
// Commands:
//   snippet --repo DIR --path FILE --start N --end M   Extract a verified snippet (JSON).
//   run     --repo DIR --entry FILE [--input JSON] [--timeout MS] [--runner CMD] [--keep]
//                                                      Run one case in an isolated copy (JSON evidence record).
//   check   LESSON --repo DIR                           Validate structure + reference freshness.
//   verify  LESSON --repo DIR                           check + re-run every execution evidence and compare.
//   build   LESSON --repo DIR --output FILE.html        Render a standalone HTML lesson (runs check first).
//
// Every command prints a JSON report on stdout (except build, which prints the
// report and writes the file). Exit code 0 = ok, 1 = errors found.

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const SCHEMA_VERSION = 1;

const SKILL_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const VIEWER_TEMPLATE = path.join(SKILL_ROOT, "assets", "lesson", "viewer.html");
const COPY_EXCLUDE = new Set(["node_modules", ".git", ".internal", "dist", "build", "coverage", ".claude"]);
const DEFAULT_TIMEOUT_MS = 10000;
const CHALLENGE_KINDS = ["predict", "trace", "locate"];
const NODE_STATES = ["observed", "inferred", "unobserved"];
const SHA256_RE = /^[0-9a-f]{64}$/;
const ID_RE = /^[a-z0-9][a-z0-9-]*$/;

// Windows drive paths are not absolute on POSIX, so both checks are needed
// for validation to behave identically on every OS.
function isAbsolutePath(p) {
  return path.isAbsolute(p) || /^[a-zA-Z]:[\\/]/.test(p);
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

// Split a runner command into parts, honoring double-quoted binary paths
// (e.g. "C:\Program Files\nodejs\node.exe" --flag).
function splitRunnerCommand(runner) {
  if (typeof runner !== "string" || runner.trim() === "") return null;
  return (runner.match(/"[^"]*"|\S+/g) || []).map((part) =>
    part.length > 1 && part.startsWith('"') && part.endsWith('"') ? part.slice(1, -1) : part
  );
}

export function sha256Content(content) {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export async function sha256File(absPath) {
  const buf = await fs.readFile(absPath);
  return createHash("sha256").update(buf).digest("hex");
}

// Resolve a repo-relative path, rejecting escapes. Returns { normalized, abs }.
// Backslashes are accepted as separators so lessons authored on Windows verify
// identically on POSIX.
export function resolveInside(repoRoot, relPath, label = "path") {
  if (typeof relPath !== "string" || relPath === "") {
    throw new Error(`${label} must be a non-empty relative path`);
  }
  if (isAbsolutePath(relPath)) {
    throw new Error(`${label} must be relative, got: ${relPath}`);
  }
  const normalized = path.normalize(relPath.split("\\").join("/")).split(path.sep).join("/");
  if (normalized === ".." || normalized.startsWith("../") || normalized.includes("/..") || normalized === ".") {
    throw new Error(`${label} escapes the repository: ${relPath}`);
  }
  const rootAbs = path.resolve(repoRoot);
  const abs = path.resolve(rootAbs, normalized);
  if (abs !== rootAbs && !abs.startsWith(rootAbs + path.sep)) {
    throw new Error(`${label} escapes the repository: ${relPath}`);
  }
  return { normalized, abs };
}

export async function extractSnippet(repoRoot, relPath, startLine, endLine) {
  const { normalized, abs } = resolveInside(repoRoot, relPath, "snippet path");
  let content;
  try {
    content = await fs.readFile(abs, "utf8");
  } catch (err) {
    throw new Error(`cannot read ${normalized}: ${err.code || err.message}`);
  }
  const lines = content.split(/\r?\n/);
  // A trailing newline produces one empty final element; it is not a real line.
  const lineCount = lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
  startLine = Number(startLine);
  endLine = Number(endLine);
  if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine < 1 || endLine < startLine) {
    throw new Error(`invalid range ${startLine}-${endLine} for ${normalized}`);
  }
  if (endLine > lineCount) {
    throw new Error(`range ${startLine}-${endLine} goes past end of ${normalized} (${lineCount} lines)`);
  }
  return {
    path: normalized,
    startLine,
    endLine,
    code: lines.slice(startLine - 1, endLine).join("\n"),
    fileHash: sha256Content(content),
    fileLineCount: lineCount,
  };
}

// ---------------------------------------------------------------------------
// Executor: run one case in an isolated copy of the repository.
// ponytail: whole-repo copy per run; per-file manifests if repos get large.
// ---------------------------------------------------------------------------

export async function runCase(opts) {
  const { repoRoot, entry, input = null, timeoutMs = DEFAULT_TIMEOUT_MS, runner = null, keepWorkDir = false, addFiles = null } = opts;
  const entryInfo = resolveInside(repoRoot, entry, "entry");
  const repoAbs = path.resolve(repoRoot);

  // Optional driver files injected into the isolated copy. They are recorded
  // verbatim in the evidence so `verify` can replay them byte for byte.
  // Shadowing real repository files is refused: a driver must not fake the
  // code the lesson claims to exercise.
  const addedFiles = {};
  if (addFiles && typeof addFiles === "object") {
    for (const [rel, content] of Object.entries(addFiles)) {
      const info = resolveInside(repoRoot, rel, "added file");
      const exists = await fs.stat(path.join(repoAbs, info.normalized)).catch(() => null);
      if (exists) {
        throw new Error(`added file ${info.normalized} already exists in the repository; drivers must not shadow real files`);
      }
      if (typeof content !== "string" || content === "") {
        throw new Error(`added file ${info.normalized} needs non-empty content`);
      }
      addedFiles[info.normalized] = content;
    }
  }

  // The entry may be a repository file, or a driver file supplied via addFiles.
  const stat = await fs.stat(entryInfo.abs).catch(() => null);
  let entryHash;
  if (stat && stat.isFile()) {
    entryHash = await sha256File(entryInfo.abs);
  } else if (Object.prototype.hasOwnProperty.call(addedFiles, entryInfo.normalized)) {
    entryHash = sha256Content(addedFiles[entryInfo.normalized]);
  } else {
    throw new Error(`entry not found in repository: ${entry}`);
  }

  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "idwt-"));
  try {
    await fs.cp(repoAbs, workDir, {
      recursive: true,
      filter: (src) => {
        const rel = path.relative(repoAbs, src);
        if (rel === "") return true;
        return !COPY_EXCLUDE.has(rel.split(path.sep)[0]);
      },
    });
    for (const [rel, content] of Object.entries(addedFiles)) {
      const dest = path.join(workDir, rel);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.writeFile(dest, content, "utf8");
    }

    let inputStr = "";
    if (typeof input === "string") inputStr = input;
    else if (input !== null && input !== undefined) inputStr = JSON.stringify(input);

    const runnerParts = splitRunnerCommand(runner) || [process.execPath];
    const runnerDisplay = runnerParts.length === 1 && runnerParts[0] === process.execPath ? "node" : runnerParts.join(" ");
    const started = Date.now();
    const res = spawnSync(runnerParts[0], [...runnerParts.slice(1), path.join(workDir, entryInfo.normalized)], {
      cwd: workDir,
      input: inputStr,
      timeout: timeoutMs,
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
    });
    const durationMs = Date.now() - started;

    const record = {
      kind: "execution",
      command: `${runnerDisplay} ${entryInfo.normalized}`,
      runner: runnerDisplay,
      entry: entryInfo.normalized,
      input: input === null || input === undefined ? null : input,
      timeoutMs,
      exitCode: res.status === undefined ? null : res.status,
      timedOut: Boolean(res.error && res.error.code === "ETIMEDOUT"),
      stdout: typeof res.stdout === "string" ? res.stdout : "",
      stderr: typeof res.stderr === "string" ? res.stderr : "",
      entryFileHash: entryHash,
      durationMs,
    };
    if (Object.keys(addedFiles).length > 0) record.addedFiles = addedFiles;
    if (res.error && res.error.code !== "ETIMEDOUT") {
      record.spawnError = res.error.message;
    }
    if (keepWorkDir) record.workDir = workDir;
    return record;
  } finally {
    if (!keepWorkDir) {
      await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

// ---------------------------------------------------------------------------
// Lesson validation
// ---------------------------------------------------------------------------

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "";
}

export function validateLesson(lesson) {
  const errors = [];
  const warnings = [];
  const err = (p, m) => errors.push(`${p}: ${m}`);
  const warn = (p, m) => warnings.push(`${p}: ${m}`);
  const root = "lesson";

  if (typeof lesson !== "object" || lesson === null || Array.isArray(lesson)) {
    return { errors: ["lesson: must be a JSON object"], warnings: [] };
  }
  if (lesson.schemaVersion !== SCHEMA_VERSION) {
    err(`${root}.schemaVersion`, `must be exactly ${SCHEMA_VERSION}`);
  }
  for (const field of ["id", "title", "objective", "feature", "language"]) {
    if (!isNonEmptyString(lesson[field])) err(`${root}.${field}`, "required non-empty string");
  }
  if (isNonEmptyString(lesson.id) && !ID_RE.test(lesson.id)) {
    err(`${root}.id`, "must match [a-z0-9][a-z0-9-]*");
  }

  // --- sourceSnapshot ---
  const snapshot = lesson.sourceSnapshot;
  if (typeof snapshot !== "object" || snapshot === null || Array.isArray(snapshot)) {
    err(`${root}.sourceSnapshot`, "required object");
  } else {
    if (snapshot.revision !== null && !isNonEmptyString(snapshot.revision)) {
      err(`${root}.sourceSnapshot.revision`, "must be a string or null");
    }
    if (typeof snapshot.files !== "object" || snapshot.files === null || Array.isArray(snapshot.files)) {
      err(`${root}.sourceSnapshot.files`, "required object mapping paths to sha256 hashes");
    } else {
      for (const [file, hash] of Object.entries(snapshot.files)) {
        if (isAbsolutePath(file) || file.split("/").includes("..")) {
          err(`${root}.sourceSnapshot.files["${file}"]`, "must be a repo-relative path");
        }
        if (!SHA256_RE.test(String(hash))) {
          err(`${root}.sourceSnapshot.files["${file}"]`, "must be a sha256 hex digest");
        }
      }
    }
  }
  const snapshotFiles = snapshot && typeof snapshot.files === "object" && !Array.isArray(snapshot.files) ? snapshot.files : {};

  // --- snippets ---
  const snippetIds = new Set();
  if (!Array.isArray(lesson.snippets)) {
    err(`${root}.snippets`, "required array");
  } else {
    lesson.snippets.forEach((s, i) => {
      const p = `${root}.snippets[${i}]`;
      if (typeof s !== "object" || s === null) return err(p, "must be an object");
      if (!isNonEmptyString(s.id) || !ID_RE.test(s.id)) err(`${p}.id`, `invalid id "${s.id}"`);
      else if (snippetIds.has(s.id)) err(`${p}.id`, `duplicate snippet id ${s.id}`);
      else snippetIds.add(s.id);
      if (typeof s.path !== "string" || isAbsolutePath(s.path) || s.path.split("/").includes("..")) {
        err(`${p}.path`, "must be a repo-relative path");
      }
      if (!(Number.isInteger(s.startLine) && s.startLine >= 1)) err(`${p}.startLine`, "must be an integer >= 1");
      if (!(Number.isInteger(s.endLine) && Number.isInteger(s.startLine) && s.endLine >= s.startLine)) {
        err(`${p}.endLine`, "must be an integer >= startLine");
      }
      if (typeof s.code !== "string" || s.code === "") err(`${p}.code`, "required non-empty string");
      else if (Number.isInteger(s.endLine) && Number.isInteger(s.startLine)) {
        const declared = s.endLine - s.startLine + 1;
        const actual = s.code.split("\n").length;
        if (actual !== declared) err(`${p}.code`, `has ${actual} lines but range ${s.startLine}-${s.endLine} declares ${declared}`);
      }
      if (typeof s.path === "string" && !snapshotFiles[s.path]) {
        err(`${p}`, `path ${s.path} is missing from sourceSnapshot.files (needed for freshness checks)`);
      }
    });
  }
  const snippetByPath = new Map();
  for (const s of Array.isArray(lesson.snippets) ? lesson.snippets : []) {
    if (typeof s.path === "string") snippetByPath.set(s.path, s);
  }

  // --- evidence ---
  const evidenceById = new Map();
  if (!Array.isArray(lesson.evidence)) {
    err(`${root}.evidence`, "required array (may be empty)");
  } else {
    lesson.evidence.forEach((e, i) => {
      const p = `${root}.evidence[${i}]`;
      if (typeof e !== "object" || e === null) return err(p, "must be an object");
      if (!isNonEmptyString(e.id) || !ID_RE.test(e.id)) err(`${p}.id`, `invalid id "${e.id}"`);
      else if (evidenceById.has(e.id)) err(`${p}.id`, `duplicate evidence id ${e.id}`);
      else evidenceById.set(e.id, e);
      if (e.kind !== "execution") err(`${p}.kind`, 'must be "execution"');
      if (!isNonEmptyString(e.command)) err(`${p}.command`, "required non-empty string");
      if (typeof e.entry !== "string" || isAbsolutePath(e.entry) || e.entry.split("/").includes("..")) {
        err(`${p}.entry`, "must be a repo-relative path");
      }
      if (!(e.exitCode === null || Number.isInteger(e.exitCode))) err(`${p}.exitCode`, "must be an integer or null");
      if (typeof e.timedOut !== "boolean") err(`${p}.timedOut`, "required boolean");
      if (typeof e.stdout !== "string") err(`${p}.stdout`, "required string");
      if (typeof e.stderr !== "string") err(`${p}.stderr`, "required string");
      if (e.entryFileHash !== undefined && !SHA256_RE.test(String(e.entryFileHash))) {
        err(`${p}.entryFileHash`, "must be a sha256 hex digest");
      }
      if (e.timeoutMs !== undefined && !(Number.isInteger(e.timeoutMs) && e.timeoutMs > 0)) {
        err(`${p}.timeoutMs`, "must be a positive integer");
      }
      if (e.addedFiles !== undefined) {
        if (typeof e.addedFiles !== "object" || e.addedFiles === null || Array.isArray(e.addedFiles)) {
          err(`${p}.addedFiles`, "must be an object mapping repo-relative paths to driver file contents");
        } else {
          for (const [rel, content] of Object.entries(e.addedFiles)) {
            if (isAbsolutePath(rel) || rel.split("/").includes("..")) {
              err(`${p}.addedFiles["${rel}"]`, "must be a repo-relative path");
            }
            if (typeof content !== "string" || content === "") {
              err(`${p}.addedFiles["${rel}"]`, "must be non-empty driver content");
            }
          }
        }
      }
    });
  }
  const isUsableExecution = (id) => {
    const e = evidenceById.get(id);
    return Boolean(e && e.kind === "execution" && e.exitCode === 0 && e.timedOut === false);
  };

  // --- flow ---
  const nodeIds = new Set();
  const flow = lesson.flow;
  if (typeof flow !== "object" || flow === null || !Array.isArray(flow.nodes) || flow.nodes.length === 0) {
    err(`${root}.flow.nodes`, "required non-empty array");
  } else {
    flow.nodes.forEach((n, i) => {
      const p = `${root}.flow.nodes[${i}]`;
      if (typeof n !== "object" || n === null) return err(p, "must be an object");
      if (!isNonEmptyString(n.id) || !ID_RE.test(n.id)) err(`${p}.id`, `invalid id "${n.id}"`);
      else if (nodeIds.has(n.id)) err(`${p}.id`, `duplicate node id ${n.id}`);
      else nodeIds.add(n.id);
      if (!isNonEmptyString(n.label)) err(`${p}.label`, "required non-empty string");
      if (n.snippetId !== undefined && !snippetIds.has(n.snippetId)) err(`${p}.snippetId`, `unknown snippet ${n.snippetId}`);
      if (!NODE_STATES.includes(n.state)) err(`${p}.state`, `must be one of ${NODE_STATES.join(", ")}`);
      const evIds = Array.isArray(n.evidenceIds) ? n.evidenceIds : [];
      for (const evId of evIds) {
        if (!evidenceById.has(evId)) err(`${p}.evidenceIds`, `unknown evidence ${evId}`);
        else if (evidenceById.get(evId).kind !== "execution") err(`${p}.evidenceIds`, `${evId} is not execution evidence`);
      }
      if (n.state === "observed" && !evIds.some((evId) => isUsableExecution(evId))) {
        err(`${p}`, `node claims state "observed" but cites no successful execution evidence`);
      }
      if (n.state !== "observed" && evIds.some((evId) => isUsableExecution(evId))) {
        warn(`${p}`, `node state "${n.state}" cites successful execution evidence; consider marking it "observed"`);
      }
    });
    if (Array.isArray(flow.links)) {
      const seen = new Set();
      flow.links.forEach((l, i) => {
        const p = `${root}.flow.links[${i}]`;
        if (typeof l !== "object" || l === null) return err(p, "must be an object");
        if (!nodeIds.has(l.from)) err(`${p}.from`, `unknown node ${l.from}`);
        if (!nodeIds.has(l.to)) err(`${p}.to`, `unknown node ${l.to}`);
        const key = `${l.from}->${l.to}`;
        if (seen.has(key)) err(`${p}`, `duplicate link ${key}`);
        seen.add(key);
        if (l.label !== undefined && !isNonEmptyString(l.label)) err(`${p}.label`, "must be a non-empty string if present");
      });
    }
  }

  // --- challenges ---
  if (!Array.isArray(lesson.challenges) || lesson.challenges.length === 0) {
    err(`${root}.challenges`, "required non-empty array");
  } else {
    const challengeIds = new Set();
    const kinds = new Set();
    lesson.challenges.forEach((c, i) => {
      const p = `${root}.challenges[${i}]`;
      if (typeof c !== "object" || c === null) return err(p, "must be an object");
      if (!isNonEmptyString(c.id) || !ID_RE.test(c.id)) err(`${p}.id`, `invalid id "${c.id}"`);
      else if (challengeIds.has(c.id)) err(`${p}.id`, `duplicate challenge id ${c.id}`);
      else challengeIds.add(c.id);
      if (!CHALLENGE_KINDS.includes(c.kind)) err(`${p}.kind`, `must be one of ${CHALLENGE_KINDS.join(", ")}`);
      else kinds.add(c.kind);
      if (!isNonEmptyString(c.prompt)) err(`${p}.prompt`, "required non-empty string");
      if (!isNonEmptyString(c.explanation)) err(`${p}.explanation`, "required non-empty string");
      if (!Array.isArray(c.options) || c.options.length < 2) {
        err(`${p}.options`, "need at least 2 options");
      } else {
        const optionIds = new Set();
        for (const o of c.options) {
          if (typeof o !== "object" || o === null || !isNonEmptyString(o.id) || !ID_RE.test(o.id)) {
            err(`${p}.options`, "each option needs an id matching [a-z0-9][a-z0-9-]*");
          } else if (optionIds.has(o.id)) err(`${p}.options`, `duplicate option id ${o.id}`);
          else optionIds.add(o.id);
          if (typeof o !== "object" || o === null || !isNonEmptyString(o.text)) {
            err(`${p}.options`, "each option needs non-empty text");
          }
        }
        if (typeof c.answer !== "string" || !optionIds.has(c.answer)) {
          err(`${p}.answer`, `answer "${c.answer}" is not one of the option ids`);
        }
      }
      const hints = Array.isArray(c.hints) ? c.hints : null;
      if (hints === null) err(`${p}.hints`, "required array (may be empty)");
      else if (hints.length > 3) err(`${p}.hints`, "at most 3 hints");
      else if (hints.some((h) => !isNonEmptyString(h))) err(`${p}.hints`, "hints must be non-empty strings");
      for (const sid of Array.isArray(c.snippetIds) ? c.snippetIds : []) {
        if (!snippetIds.has(sid)) err(`${p}.snippetIds`, `unknown snippet ${sid}`);
      }
      const verifiedBy = Array.isArray(c.verifiedBy) ? c.verifiedBy : [];
      for (const evId of verifiedBy) {
        if (!evidenceById.has(evId)) err(`${p}.verifiedBy`, `unknown evidence ${evId}`);
        else if (!isUsableExecution(evId)) {
          err(`${p}.verifiedBy`, `evidence ${evId} did not succeed (exit code 0, no timeout) — a challenge cannot claim verification with it`);
        }
      }
    });
    for (const kind of CHALLENGE_KINDS) {
      if (!kinds.has(kind)) warn(`${root}.challenges`, `lesson has no "${kind}" challenge`);
    }
  }

  // --- ui strings + limitations ---
  if (lesson.ui !== undefined) {
    if (typeof lesson.ui !== "object" || lesson.ui === null || Array.isArray(lesson.ui)) {
      err(`${root}.ui`, "must be an object of strings");
    } else {
      for (const [k, v] of Object.entries(lesson.ui)) {
        if (!isNonEmptyString(v)) err(`${root}.ui.${k}`, "must be a non-empty string");
      }
    }
  }
  if (!Array.isArray(lesson.limitations)) {
    err(`${root}.limitations`, "required array (may be empty)");
  } else if (lesson.limitations.some((l) => !isNonEmptyString(l))) {
    err(`${root}.limitations`, "entries must be non-empty strings");
  }

  // --- unused evidence ---
  const referenced = new Set();
  for (const n of (lesson.flow && Array.isArray(lesson.flow.nodes) ? lesson.flow.nodes : [])) {
    for (const evId of n.evidenceIds || []) referenced.add(evId);
  }
  for (const c of Array.isArray(lesson.challenges) ? lesson.challenges : []) {
    for (const evId of c.verifiedBy || []) referenced.add(evId);
  }
  for (const id of evidenceById.keys()) {
    if (!referenced.has(id)) warn(`${root}.evidence`, `evidence ${id} is never referenced by a node or challenge`);
  }

  return { errors, warnings };
}

// Freshness: compare recorded hashes and snippet text against the repo now.
export async function checkLesson(lesson, repoRoot) {
  const { errors, warnings } = validateLesson(lesson);
  const staleFiles = [];
  const fileStatus = {};

  if (errors.length === 0 && lesson.sourceSnapshot && typeof repoRoot === "string") {
    for (const [file, hash] of Object.entries(lesson.sourceSnapshot.files)) {
      let info;
      try {
        info = resolveInside(repoRoot, file, "snapshot file");
      } catch (e) {
        errors.push(`sourceSnapshot.files["${file}"]: ${e.message}`);
        fileStatus[file] = "invalid";
        continue;
      }
      let current;
      try {
        current = await sha256File(info.abs);
      } catch {
        fileStatus[file] = "missing";
        errors.push(`sourceSnapshot.files["${file}"]: file no longer exists in the repository`);
        continue;
      }
      if (current !== hash) {
        fileStatus[file] = "stale";
        staleFiles.push(file);
        warnings.push(`sourceSnapshot.files["${file}"]: file changed after the lesson was generated (references may be outdated)`);
      } else {
        fileStatus[file] = "ok";
      }
    }

    // Snippet text must match the recorded file when the file is unchanged.
    for (const s of Array.isArray(lesson.snippets) ? lesson.snippets : []) {
      if (fileStatus[s.path] !== "ok") continue;
      try {
        const fresh = await extractSnippet(repoRoot, s.path, s.startLine, s.endLine);
        if (fresh.code !== s.code) {
          errors.push(`snippets["${s.id}"]: code does not match ${s.path}:${s.startLine}-${s.endLine} in the repository`);
        }
      } catch (e) {
        errors.push(`snippets["${s.id}"]: ${e.message}`);
      }
    }

    // Revision drift, when both the lesson and the repo record one.
    const recorded = lesson.sourceSnapshot.revision;
    if (recorded) {
      const git = spawnSync("git", ["rev-parse", "HEAD"], { cwd: path.resolve(repoRoot), encoding: "utf8", timeout: 5000 });
      if (git.status === 0) {
        const current = git.stdout.trim();
        if (current !== recorded) {
          warnings.push(`sourceSnapshot.revision: lesson was built on ${recorded.slice(0, 12)}, repository is now at ${current.slice(0, 12)}`);
        }
      }
    }
  }

  return { ok: errors.length === 0, errors, warnings, fileStatus, staleFiles };
}

// Re-run every execution evidence entry and compare against the recorded result.
// Custom runners are refused unless explicitly allowed: a lesson file from
// somewhere else should not be able to make `verify` execute arbitrary
// commands that are not the repository's own entry.
export async function verifyLesson(lesson, repoRoot, opts = {}) {
  const { allowCustomRunner = false } = opts;
  const check = await checkLesson(lesson, repoRoot);
  const errors = [...check.errors];
  const warnings = [...check.warnings];
  let reran = 0;

  if (check.ok) {
    for (const e of lesson.evidence) {
      if (e.kind !== "execution") continue;
      if (e.runner && e.runner !== "node" && !allowCustomRunner) {
        errors.push(`evidence ${e.id}: uses custom runner "${e.runner}"; re-running it needs --allow-custom-runner (it executes commands outside the repository)`);
        continue;
      }
      reran++;
      let actual;
      try {
        actual = await runCase({
          repoRoot,
          entry: e.entry,
          input: e.input,
          timeoutMs: e.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          runner: e.runner && e.runner !== "node" ? e.runner : null,
          addFiles: e.addedFiles ?? null,
        });
      } catch (err) {
        errors.push(`evidence ${e.id}: re-run failed: ${err.message}`);
        continue;
      }
      if (actual.exitCode !== e.exitCode) {
        errors.push(`evidence ${e.id}: exit code changed (recorded ${e.exitCode}, now ${actual.exitCode})`);
      }
      if (actual.timedOut !== e.timedOut) {
        errors.push(`evidence ${e.id}: timeout status changed (recorded ${e.timedOut}, now ${actual.timedOut})`);
      }
      if (actual.stdout !== e.stdout) {
        errors.push(`evidence ${e.id}: stdout changed — recorded:\n${e.stdout}\n--- now:\n${actual.stdout}`);
      }
      if (actual.stderr !== e.stderr) {
        warnings.push(`evidence ${e.id}: stderr changed (often environment noise, review manually)`);
      }
      if (e.entryFileHash && actual.entryFileHash !== e.entryFileHash) {
        warnings.push(`evidence ${e.id}: entry file hash differs from the hash recorded when the evidence was captured`);
      }
    }
  } else {
    warnings.push("references failed validation; evidence was not re-run");
  }

  return { ok: errors.length === 0, errors, warnings, reran, fileStatus: check.fileStatus };
}

// ---------------------------------------------------------------------------
// Renderer (server-side, fully escaped)
// ---------------------------------------------------------------------------

function esc(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function preIo(label, content) {
  return `<p class="io-label">${esc(label)}</p><pre class="io" role="region" aria-label="${esc(label)}" tabindex="0">${esc(content)}</pre>`;
}

function renderEvidence(evidenceById, evId) {
  const e = evidenceById.get(evId);
  if (!e) return "";
  const failed = !(e.exitCode === 0 && !e.timedOut);
  const parts = [
    `<details class="evidence${failed ? " failed" : ""}">`,
    `<summary>Evidence ${esc(e.id)} — execution (exit code ${esc(String(e.exitCode))}${e.timedOut ? ", timed out" : ""})</summary>`,
    `<p class="cmd">Command: <code>${esc(e.command)}</code></p>`,
  ];
  if (e.input !== null && e.input !== undefined) {
    const text = typeof e.input === "string" ? e.input : JSON.stringify(e.input, null, 2);
    parts.push(preIo("Input (stdin)", text));
  }
  if (e.stdout) parts.push(preIo("Recorded stdout", e.stdout));
  if (e.stderr) parts.push(preIo("Recorded stderr", e.stderr));
  for (const [rel, content] of Object.entries(e.addedFiles || {})) {
    parts.push(preIo(`Driver file ${rel} (injected into the isolated copy)`, content));
  }
  if (e.entryFileHash) {
    parts.push(`<p class="src-link">entry ${esc(e.entry)} @ ${esc(e.entryFileHash.slice(0, 12))}</p>`);
  }
  parts.push("</details>");
  return parts.join("\n");
}

function renderNode(node, index, evidenceById, snippetById, snippetStatus) {
  const snippet = node.snippetId ? snippetById.get(node.snippetId) : null;
  const stateLabel = node.state === "unobserved" ? "not observed" : node.state;
  const body = [];
  if (node.note) body.push(`<p class="note">${esc(node.note)}</p>`);
  if (snippet) {
    const status = snippetStatus.get(snippet.id);
    const staleFlag = status === "stale" ? ` <span class="stale-flag">⚠ file changed since the lesson was generated — line numbers may be outdated</span>` : "";
    body.push(`<p class="src-link">${esc(snippet.path)}:${snippet.startLine}-${snippet.endLine}${staleFlag}</p>`);
    body.push(`<pre class="code" role="region" aria-label="Code ${esc(snippet.path)}:${snippet.startLine}-${snippet.endLine}" tabindex="0"><code>${esc(snippet.code)}</code></pre>`);
  }
  for (const evId of node.evidenceIds || []) body.push(renderEvidence(evidenceById, evId));
  return [
    `<li class="node" id="node-${esc(node.id)}">`,
    "<details>",
    `<summary><span class="node-label">${index + 1}. ${esc(node.label)}</span> <span class="badge ${esc(node.state)}">${esc(stateLabel)}</span></summary>`,
    `<div class="node-body">${body.join("\n")}</div>`,
    "</details>",
    "</li>",
  ].join("\n");
}

function renderChallenge(challenge, evidenceById, snippetById, nodeLabelById, ui) {
  const verified = Array.isArray(challenge.verifiedBy) && challenge.verifiedBy.length > 0;
  const parts = [
    `<article class="challenge" id="challenge-${esc(challenge.id)}">`,
    `<h3><span class="kind">${esc(challenge.kind)}</span>${esc(challenge.prompt)}</h3>`,
  ];
  if (challenge.displayInput !== undefined && challenge.displayInput !== null) {
    parts.push(preIo(ui.inputLabel || "Input", typeof challenge.displayInput === "string" ? challenge.displayInput : JSON.stringify(challenge.displayInput, null, 2)));
  }
  if (Array.isArray(challenge.snippetIds) && challenge.snippetIds.length > 0) {
    const items = challenge.snippetIds
      .map((sid) => snippetById.get(sid))
      .filter(Boolean)
      .map((s) => {
        const nodeId = nodeLabelById.get(s.id);
        const label = `${s.path}:${s.startLine}-${s.endLine}`;
        return nodeId ? `<a href="#node-${esc(nodeId)}">${esc(label)}</a>` : esc(label);
      });
    if (items.length) parts.push(`<p class="meta">${esc(ui.codeToInspectLabel || "Code to inspect")}: ${items.join(" · ")}</p>`);
  }
  parts.push(`<form class="challenge-form" data-challenge-id="${esc(challenge.id)}">`);
  parts.push(`<fieldset><legend>${esc(ui.optionsLabel || "Options")}</legend>`);
  for (const o of challenge.options) {
    parts.push(`<label><input type="radio" name="${esc(challenge.id)}" value="${esc(o.id)}"> ${esc(o.text)}</label>`);
  }
  parts.push("</fieldset>");
  parts.push(`<button type="submit" class="check">${esc(ui.checkAnswer || "Check answer")}</button>`);
  parts.push('<p class="feedback" role="status" aria-live="polite"></p>');
  parts.push("</form>");
  (challenge.hints || []).forEach((hint, i) => {
    const hintLabel = (ui.hintLabel || "Hint {n}").replace("{n}", String(i + 1));
    parts.push(`<details class="hint"><summary>${esc(hintLabel)}</summary><p>${esc(hint)}</p></details>`);
  });
  parts.push(`<details class="spoiler"><summary>${esc(ui.explanationLabel || "Explanation (spoiler)")}</summary><p>${esc(challenge.explanation)}</p></details>`);
  if (verified) {
    parts.push('<aside class="verification verified">');
    parts.push(`<p><strong>${esc(ui.verifiedTitle || "✓ Verified against execution.")}</strong> ${esc(ui.verifiedBody || "The recorded run below is the ground truth for the correct answer.")} ${esc(challenge.verifiedBy.map((id) => id).join(", "))}</p>`);
    for (const evId of challenge.verifiedBy.slice(0, 1)) {
      const e = evidenceById.get(evId);
      if (e) {
        parts.push(`<details><summary>${esc(ui.showRecordedRun || "Show the recorded run")}</summary>${preIo(ui.stdoutLabel || "stdout", e.stdout)}${preIo(ui.commandLabel || "command", e.command)}</details>`);
      }
    }
    parts.push("</aside>");
  } else {
    parts.push(`<aside class="verification unverified"><p>${esc(ui.unverifiedBody || "No execution evidence was recorded for this challenge. The marked answer is the lesson author's claim, not a verified result.")}</p></aside>`);
  }
  parts.push("</article>");
  return parts.join("\n");
}

export async function buildHtml(lesson, repoRoot) {
  const check = await checkLesson(lesson, repoRoot);
  if (!check.ok) {
    const details = check.errors.map((e) => `  - ${e}`).join("\n");
    throw new Error(`lesson failed validation; fix these before building (run the "check" command):\n${details}`);
  }

  const template = await fs.readFile(VIEWER_TEMPLATE, "utf8");
  for (const marker of ["__LANG__", "__TITLE__", "__CONTENT__", "__LESSON_DATA__", "__SKIP_CHALLENGES__"]) {
    if (!template.includes(marker)) throw new Error(`viewer template is missing the ${marker} marker`);
  }

  const evidenceById = new Map((lesson.evidence || []).map((e) => [e.id, e]));
  const snippetById = new Map((lesson.snippets || []).map((s) => [s.id, s]));
  const snippetStatus = new Map((lesson.snippets || []).map((s) => [s.id, check.fileStatus[s.path] || "unknown"]));

  // nodeLabelById: snippet id -> first node id using it (for challenge context links)
  const nodeLabelById = new Map();
  for (const node of lesson.flow.nodes) {
    if (node.snippetId && !nodeLabelById.has(node.snippetId)) nodeLabelById.set(node.snippetId, node.id);
  }

  const ui = lesson.ui || {};
  const solvedProgress = ui.solvedProgress || "Solved {n}/{total}";
  const skipLabel = ui.skipToChallenges || "Skip to challenges";
  const progressText = solvedProgress.replace("{n}", "0").replace("{total}", String(lesson.challenges.length));

  const content = [];
  content.push('<header class="lesson-header">');
  content.push(`<p class="kicker">${esc(ui.kicker || "Interactive code lesson")}</p>`);
  content.push(`<h1>${esc(lesson.title)}</h1>`);
  content.push(`<p class="objective">${esc(lesson.objective)}</p>`);
  content.push(`<p class="meta">${esc(ui.featureLabel || "Feature")}: <strong>${esc(lesson.feature)}</strong> · ${esc(ui.revisionLabel || "Source revision")}: <code>${esc(lesson.sourceSnapshot.revision || (ui.noRevisionLabel || "not recorded"))}</code> · <span id="progress">${esc(progressText)}</span></p>`);
  content.push("</header>");

  if (check.warnings.length > 0) {
    content.push('<section class="banner" role="note">');
    content.push(`<h2>${esc(ui.warningsHeading || "⚠ Warnings — review before trusting this lesson")}</h2>`);
    content.push("<ul>");
    for (const w of check.warnings) content.push(`<li>${esc(w)}</li>`);
    content.push("</ul></section>");
  }

  content.push("<section id=\"flow\">");
  content.push(`<h2>${esc(ui.flowHeading || "How this feature works")}</h2>`);
  content.push(
    `<p class="section-intro">${esc(
      ui.flowIntro ||
        'Open each step to see its code and the evidence behind it. "observed" means seen running in a recorded execution; "inferred" means concluded from reading the code; "not observed" means not examined.'
    )}</p>`
  );
  content.push('<ol class="flow">');
  lesson.flow.nodes.forEach((node, i) => content.push(renderNode(node, i, evidenceById, snippetById, snippetStatus)));
  content.push("</ol></section>");

  content.push('<section id="challenges">');
  content.push(`<h2>${esc(ui.challengesHeading || "Challenges")}</h2>`);
  lesson.challenges.forEach((c) => content.push(renderChallenge(c, evidenceById, snippetById, nodeLabelById, ui)));
  content.push("</section>");

  if (lesson.limitations.length > 0) {
    content.push('<section id="limits">');
    content.push(`<h2>${esc(ui.limitationsHeading || "Limitations & assumptions")}</h2>`);
    content.push("<ul>");
    for (const l of lesson.limitations) content.push(`<li>${esc(l)}</li>`);
    content.push("</ul></section>");
  }

  content.push("<footer>");
  content.push(`<p>Lesson <code>${esc(lesson.id)}</code> · lesson schema v${SCHEMA_VERSION} · generated by <strong>I Didn&rsquo;t Write This</strong>. Answers are embedded in this file if you want to peek. This page works offline.</p>`);
  content.push("</footer>");

  const payload = {
    id: lesson.id,
    language: lesson.language,
    ui: lesson.ui || null,
    challenges: lesson.challenges.map((c) => ({
      id: c.id,
      answer: c.answer,
      verified: Array.isArray(c.verifiedBy) && c.verifiedBy.length > 0,
    })),
  };
  const payloadJson = JSON.stringify(payload).replace(/</g, "\\u003c");

  const html = template
    .replace("__LANG__", esc(lesson.language))
    .replace("__TITLE__", esc(lesson.title))
    .replace("__SKIP_CHALLENGES__", esc(skipLabel))
    .replace("__CONTENT__", content.join("\n"))
    .replace("__LESSON_DATA__", payloadJson);

  return { html, warnings: check.warnings };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      opts._.push(a);
      continue;
    }
    const key = a.slice(2);
    const eq = key.indexOf("=");
    let value;
    if (eq !== -1) {
      value = key.slice(eq + 1);
    } else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
      value = argv[++i];
    } else {
      value = true;
    }
    if (opts[key] !== undefined) {
      opts[key] = [].concat(opts[key], value); // repeated flags collect into arrays
    } else {
      opts[key] = value;
    }
  }
  return opts;
}

function printReport(report) {
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
}

function requireOpt(opts, name) {
  if (opts[name] === undefined || opts[name] === true) {
    process.stderr.write(`missing required option --${name}\n`);
    process.exit(2);
  }
  return opts[name];
}

async function readStdinFully() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => resolve(data));
  });
}

async function readLesson(lessonPath) {
  let raw;
  try {
    raw = await fs.readFile(lessonPath, "utf8");
  } catch (err) {
    throw new Error(`cannot read lesson file ${lessonPath}: ${err.code || err.message}`);
  }
  let lesson;
  try {
    lesson = JSON.parse(raw);
  } catch (err) {
    throw new Error(`lesson file is not valid JSON: ${err.message}`);
  }
  return lesson;
}

const USAGE = `I Didn't Write This — toolkit

Usage:
  toolkit.mjs snippet --repo DIR --path FILE --start N --end M
  toolkit.mjs run --repo DIR --entry FILE [--input JSON | --stdin] [--timeout MS] [--runner CMD]
                  [--add REPOREL=LOCALFILE]... [--keep]
  toolkit.mjs check LESSON --repo DIR
  toolkit.mjs verify LESSON --repo DIR
  toolkit.mjs build LESSON --repo DIR --output FILE.html

"run" executes the entry inside an isolated temporary copy of DIR and prints an
execution record you can paste into the lesson evidence array (add an "id").
"--add REPOREL=LOCALFILE" injects a driver file (content is read from LOCALFILE,
written to REPOREL inside the isolated copy, recorded verbatim in the evidence,
and replayed by verify). Driver files must not shadow existing repository files.`;

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const opts = parseArgs(rest);

  try {
    if (cmd === "snippet") {
      const repo = requireOpt(opts, "repo");
      const info = await extractSnippet(repo, requireOpt(opts, "path"), Number(requireOpt(opts, "start")), Number(requireOpt(opts, "end")));
      printReport(info);
    } else if (cmd === "run") {
      const repo = requireOpt(opts, "repo");
      let input = null;
      if (opts.input !== undefined && opts.input !== true) input = opts.input;
      else if (opts.stdin) input = await readStdinFully();
      let parsed = input;
      if (typeof input === "string" && input.trim() !== "") {
        try {
          parsed = JSON.parse(input);
        } catch {
          parsed = input; // raw stdin text
        }
      }
      const addSpecs = [].concat(opts.add ?? []);
      const addFiles = {};
      for (const spec of addSpecs) {
        if (spec === true) {
          process.stderr.write("--add expects REPOREL=LOCALFILE\n");
          process.exit(2);
        }
        const eq = spec.indexOf("=");
        if (eq === -1) {
          process.stderr.write(`--add expects REPOREL=LOCALFILE, got: ${spec}\n`);
          process.exit(2);
        }
        const rel = spec.slice(0, eq);
        const local = spec.slice(eq + 1);
        let content;
        try {
          content = await fs.readFile(local, "utf8");
        } catch (err) {
          throw new Error(`cannot read --add source ${local}: ${err.code || err.message}`);
        }
        addFiles[rel] = content;
      }
      const record = await runCase({
        repoRoot: repo,
        entry: requireOpt(opts, "entry"),
        input: parsed,
        timeoutMs: opts.timeout ? Number(opts.timeout) : DEFAULT_TIMEOUT_MS,
        runner: typeof opts.runner === "string" ? opts.runner : null,
        addFiles: Object.keys(addFiles).length > 0 ? addFiles : null,
        keepWorkDir: Boolean(opts.keep),
      });
      printReport(record);
    } else if (cmd === "check") {
      if (!rest[0]) {
        process.stderr.write("usage: toolkit.mjs check LESSON --repo DIR\n");
        process.exit(2);
      }
      const lesson = await readLesson(rest[0]);
      const report = await checkLesson(lesson, requireOpt(opts, "repo"));
      printReport(report);
      if (!report.ok) process.exit(1);
    } else if (cmd === "verify") {
      if (!rest[0]) {
        process.stderr.write("usage: toolkit.mjs verify LESSON --repo DIR\n");
        process.exit(2);
      }
      const lesson = await readLesson(rest[0]);
      const report = await verifyLesson(lesson, requireOpt(opts, "repo"), {
        allowCustomRunner: Boolean(opts["allow-custom-runner"]),
      });
      printReport(report);
      if (!report.ok) process.exit(1);
    } else if (cmd === "build") {
      const lesson = await readLesson(rest[0]);
      const out = requireOpt(opts, "output");
      const { html, warnings } = await buildHtml(lesson, requireOpt(opts, "repo"));
      await fs.writeFile(out, html, "utf8");
      printReport({ ok: true, output: path.resolve(out), warnings, bytes: Buffer.byteLength(html) });
    } else {
      process.stderr.write(USAGE + "\n");
      process.exitCode = cmd ? 2 : 0;
    }
  } catch (err) {
    process.stderr.write(`error: ${err.message}\n`);
    process.exit(1);
  }
}

// Compare real paths so the CLI still works when invoked through the symlink
// an npm "bin" install creates (argv[1] is the link, import.meta.url is not).
const invokedAsScript = (() => {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(path.resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (invokedAsScript) {
  main();
}
