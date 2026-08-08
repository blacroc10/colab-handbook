'use strict';
/**
 * Regression test: `tools/colab` must not truncate stdout when it is a PIPE — issue #147.
 *
 * Run: `node --test tools/lib/` — wired into CI's self-check job.
 *
 * The bug: the entry point wrote a subcommand's output (console.log, buffered) and then called
 * `process.exit(code)` immediately after. Writes to a pipe are ASYNCHRONOUS, so exiting before the
 * event loop drains discards whatever has not been flushed yet. The reader gets a payload cut at
 * the pipe buffer — invalid JSON for a `--json` caller — with an exit code that still looks like
 * the documented one, so nothing signals failure. It is size-dependent, which is why it stayed
 * invisible until a consumer's fleet grew large enough to push a `colab doctor --json` payload past
 * the boundary.
 *
 * Sibling test: tools/lib/audit-pipe.test.js pins the identical bug in audit/audit.mjs, already
 * fixed with the same process.exitCode pattern this test locks in for tools/colab.
 *
 * TWO THINGS THIS TEST MUST DO, or it is worse than no test at all:
 *
 *   1. Read stdout the way a TOOL reads it (execFileSync/spawnSync, which buffer a pipe), never
 *      `| wc -c`. A shell consumer that drains greedily wins the race and reports the full byte
 *      count, which is exactly how this class of bug is repeatedly dismissed.
 *
 *   2. Generate a payload past the pipe buffer OF THE PLATFORM CI RUNS ON. That buffer is ~8 KB on
 *      macOS but 64 KB on Linux, and CI is Linux. MIN_PAYLOAD below is asserted explicitly: if the
 *      generated payload ever shrinks under it, this test fails loudly asking to be resized rather
 *      than silently degrading into theatre.
 *
 * `colab claims --json` is used as the payload generator rather than a live fleet command (doctor,
 * worktrees) because it is a pure read of ~/.colab/state.json — no git shelling, no GitHub calls —
 * so the test is hermetic and fast: a crafted state.json with enough claim records reaches the
 * payload floor in milliseconds, not the ~20s a synthetic-repo fleet costs in the audit sibling.
 *
 * Verified to fail against the pre-fix commit (process.exit(code)) and pass after it
 * (process.exitCode = code).
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const COLAB = path.join(REPO_ROOT, 'tools', 'colab');

// Comfortably past Linux's 64 KB pipe buffer — not merely past macOS's 8 KB.
const MIN_PAYLOAD = 128 * 1024;

// Each claim record serializes to roughly 250-300 bytes with `repo` padded below; 500 records
// clears MIN_PAYLOAD with margin.
const CLAIM_COUNT = 500;
const PAD = 'd'.repeat(120);

/** A private COLAB_HOME with a state.json holding CLAIM_COUNT claim records — no git, no network. */
function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'colab-pipe-'));
  const claims = {};
  for (let i = 0; i < CLAIM_COUNT; i++) {
    const repo = `/repos/group${PAD}${i}/repo${PAD}${i}`;
    claims[`${repo}#${i}`] = {
      issue: `#${i}`,
      repo,
      worktree: `wt-${i}`,
      branch: `feat/thing-${i}`,
      host: 'test-host',
      session: null,
      sessionName: null,
      created: new Date().toISOString(),
    };
  }
  const state = { version: 1, worktrees: {}, claims, ports: {}, solo: {} };
  fs.writeFileSync(path.join(home, 'state.json'), JSON.stringify(state));
  return home;
}

// Run colab with stdout as a PIPE and capture both payload and exit code.
function runPiped(home, args) {
  try {
    const stdout = execFileSync('node', [COLAB, ...args], {
      encoding: 'utf8',
      maxBuffer: 1 << 30,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, COLAB_HOME: home, COLAB_SESSION: '', COLAB_SESSION_NAME: '' },
    });
    return { stdout, code: 0 };
  } catch (err) {
    // execFileSync throws on a non-zero exit; the captured stdout is still on the error.
    return { stdout: err.stdout || '', code: err.status };
  }
}

test('claims --json survives a payload larger than the pipe buffer', (t) => {
  const home = fixture();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));

  const { stdout, code } = runPiped(home, ['claims', '--json']);

  // Order matters, as in the audit sibling: parse first, so a regression's failure message names
  // the actual bug (truncation) rather than a downstream size assertion that would also fire.
  let parsed;
  assert.doesNotThrow(() => {
    parsed = JSON.parse(stdout);
  }, `colab claims --json emitted malformed JSON (${stdout.length}B) — stdout was truncated ` +
     `before it drained. This is the pipe-buffer regression this test exists to catch.`);

  assert.ok(
    stdout.length > MIN_PAYLOAD,
    `payload ${stdout.length}B parsed cleanly but is under the ${MIN_PAYLOAD}B floor, so this ` +
      `test no longer crosses a pipe-buffer boundary and proves nothing. Raise CLAIM_COUNT.`
  );

  assert.equal(Object.keys(parsed).length, CLAIM_COUNT, 'every claim record must reach the reader');
  assert.equal(code, 0, 'a clean listing must still exit 0');
});

test('--help is not truncated either', () => {
  // The full command reference is well under 8 KB on its own, so this does not cross the Linux
  // buffer — it pins the same call site on the smaller macOS boundary instead, same reasoning as
  // the audit sibling's --help test.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'colab-pipe-help-'));
  try {
    const { stdout, code } = runPiped(home, ['--help']);
    assert.equal(code, 0, '--help exits 0');
    const lastLine = stdout.trimEnd().split('\n').pop();
    assert.match(lastLine, /\S/, 'help output ended early — stdout was truncated');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
