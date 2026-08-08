'use strict';
/**
 * Regression test for #164's actual deliverable: a claim SURVIVES, marked `releasePending`, when
 * the remote release write fails on both GraphQL and its REST fallback — instead of the local
 * claim record being cleared while GitHub still shows `in-progress` (the exact disagreement #164
 * reported: a successful ship whose tracker write silently failed reads, to every later sweep, as
 * a stale claim to reconcile, with the truth surviving only in scrollback).
 *
 * Run: `node --test tools/lib/*.test.js` — the existing CI glob picks this file up.
 *
 * The plan file's oracle for #164 named this explicitly ("... AND the 'claim kept on failed
 * release' path") and it shipped with zero coverage — `grep -rn releasePending --include='*.test.js'`
 * returned nothing before this file. `tools/lib/git.test.js` covers the transport-fallback
 * mechanism itself (does `ghIssueRelease` retry over REST, does the detector fire only on a real
 * GraphQL rate limit); this file is the missing other half — does the CLI actually KEEP the claim
 * when that mechanism reports failure, and does `colab claims` say so.
 *
 * Driven against the real CLI + a real repo with a real (bare, on-disk, no network) `origin`,
 * following `colab-base.test.js`'s pattern — the property under test is end-to-end wiring
 * (`cmdWorktreeRm`/`cmdRelease` → `state.mutate` → what `colab claims` prints), which a unit test
 * of `ghIssueRelease` alone cannot demonstrate. `COLAB_HOME` is redirected per test, so the
 * developer's real state.json is never read or written. The worktree itself is a REAL linked
 * worktree (`git worktree add`), created directly via git rather than through `colab worktree new`,
 * so fixture setup needs no `gh` at all — only the teardown under test does.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const COLAB = path.join(REPO_ROOT, 'tools', 'colab');

const TMP = [];
process.on('exit', () => { for (const d of TMP) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {} } });

/**
 * A fake `gh` on PATH, dispatching on argv shape, matching the one in `git.test.js` — duplicated
 * rather than shared because it is ~30 lines and pulling it into a third file (git.js's own tests
 * plus this one) is more indirection than the duplication costs. Behaviors used here:
 *   - 'ok'                — every write succeeds (both GraphQL-shaped and REST-shaped calls)
 *   - 'both-fail'          — GraphQL AND its REST retry both fail with a rate-limit-shaped error
 *                            (the #164 case: neither transport has quota)
 */
function fakeGhFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'colab-releasepending-gh-'));
  TMP.push(root);
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  const script = `#!/usr/bin/env node
const args = process.argv.slice(2);
const behavior = process.env.FAKE_GH_BEHAVIOR || 'ok';
function fail(msg) { process.stderr.write(msg + '\\n'); process.exit(1); }
function ok(out) { if (out) process.stdout.write(out); process.exit(0); }
if (args[0] === '--version') return ok('gh version 2.0.0 (fake)\\n');
if (args[0] === 'auth' && args[1] === 'status') return ok('Logged in (fake)\\n');
const isGraphqlOp = (args[0] === 'issue' && (args[1] === 'comment' || args[1] === 'edit' || args[1] === 'view'));
const isApi = args[0] === 'api';
if (isGraphqlOp) {
  if (behavior === 'both-fail') {
    return fail('GraphQL: API rate limit exceeded for installation ID 123. (' +
      (args[1] === 'comment' ? 'addComment' : args[1] === 'view' ? 'issue' : 'updateIssue') + ')');
  }
  if (args[1] === 'view') return ok('{"state":"OPEN"}\\n');
  return ok();
}
if (isApi && args.includes('user')) return ok('octofake\\n');
if (isApi) {
  if (behavior === 'both-fail') return fail('HTTP 403: API rate limit exceeded (rest)');
  return ok();
}
fail('fake gh: unhandled invocation ' + JSON.stringify(args));
`;
  fs.writeFileSync(path.join(bin, 'gh'), script, { mode: 0o755 });
  return bin;
}

/** A real repo with a real bare `origin` (no network) and a private COLAB_HOME. */
function repoFixture() {
  // realpath, not just mkdtemp: on macOS /tmp is a symlink to /private/tmp, so a claim keyed on
  // the literal mkdtemp path (`${repo}#N`) would not match what `git.mainRepoRoot` resolves it to
  // (which follows the symlink for real) — the exact mismatch git.test.js's own fixture calls out.
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'colab-releasepending-repo-')));
  TMP.push(root);
  const origin = path.join(root, 'origin.git');
  const work = path.join(root, 'work');
  const home = path.join(root, 'colab-home');
  fs.mkdirSync(home);
  const g = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin], { encoding: 'utf8' });
  execFileSync('git', ['init', '-q', '-b', 'main', work], { encoding: 'utf8' });
  g(work, 'config', 'user.email', 'test@example.invalid');
  g(work, 'config', 'user.name', 'release-pending test');
  g(work, 'config', 'core.hooksPath', path.join(root, '.nohooks'));
  g(work, 'remote', 'add', 'origin', origin);
  fs.writeFileSync(path.join(work, 'README'), 'base\n');
  g(work, 'add', '-A');
  g(work, 'commit', '-q', '-m', 'chore: fixture');
  g(work, 'push', '-q', 'origin', 'main');

  return { root, origin, work, home, g };
}

/** Run `colab` with a given fake-gh behavior and a real bin dir prepended to PATH. */
function colab(fx, ghBin, behavior, args) {
  const r = spawnSync('node', [COLAB, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${ghBin}:${process.env.PATH}`,
      FAKE_GH_BEHAVIOR: behavior,
      COLAB_HOME: fx.home,
      COLAB_SESSION: '',
      COLAB_SESSION_NAME: '',
    },
  });
  return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
}

const readState = (fx) => JSON.parse(fs.readFileSync(path.join(fx.home, 'state.json'), 'utf8'));
const writeState = (fx, st) => fs.writeFileSync(path.join(fx.home, 'state.json'), JSON.stringify(st));
const claimKey = (repo, num) => `${repo}#${num}`;

test('worktree rm: a claim whose GitHub release fails on BOTH transports survives, marked releasePending — not silently cleared', () => {
  const fx = repoFixture();
  const ghBin = fakeGhFixture();
  const name = 'graphql-rate-limit-164';
  const branch = 'fix/graphql-rate-limit-164';
  const wtPath = path.join(fx.root, name);

  // A real linked worktree, created directly with git — no gh involved in setup at all.
  fx.g(fx.work, 'worktree', 'add', '-b', branch, wtPath, 'origin/main');

  // Craft the state colab's own commands would have produced (worktree new --issues 164), so the
  // fixture is independent of the claim/creation path this test is not about.
  writeState(fx, {
    version: 1,
    worktrees: { [name]: { repo: fx.work, path: wtPath, branch, ports: [], session: null, sessionName: null, created: new Date().toISOString() } },
    claims: {
      [claimKey(fx.work, 164)]: {
        issue: '#164', repo: fx.work, worktree: name, branch, host: 'test-host',
        session: null, sessionName: null, created: new Date().toISOString(),
      },
    },
    ports: {}, solo: {},
  });

  const r = colab(fx, ghBin, 'both-fail', ['worktree', 'rm', name, '--repo', fx.work]);
  assert.strictEqual(r.code, 0, `worktree rm should still succeed overall (the merge/removal is not gated on the tracker write) — stderr: ${r.err}`);
  assert.match(r.out, /FAILED on #164/, 'the failure must be named in the summary, not swallowed');
  assert.match(r.out, /releasePending/, 'the summary must say the claim was kept, not cleared');

  const st = readState(fx);
  // The worktree record itself is gone regardless — teardown of the directory/state entry is not
  // gated on the tracker write succeeding.
  assert.strictEqual(st.worktrees[name], undefined, 'the worktree record should still be torn down');

  const claim = st.claims[claimKey(fx.work, 164)];
  assert.ok(claim, '#164 must still have a LOCAL claim record — this is the exact bug #164 reported: ' +
    'clearing it here is what let a successful ship with a failed tracker write read as a plain stale claim later');
  assert.strictEqual(claim.releasePending, true, 'the surviving claim must be marked pending, not indistinguishable from a normal live claim');
  assert.ok(claim.releaseNote && /colab release/.test(claim.releaseNote), 'the note must point at the retry command, not just say "pending"');
  assert.strictEqual(claim.worktree, null, 'the worktree it pointed to is gone — must not leave a dangling reference to it');

  // `colab claims` must actually surface this — self-describing residue, not merely non-destructive.
  const listing = colab(fx, ghBin, 'both-fail', ['claims']);
  assert.strictEqual(listing.code, 0);
  assert.match(listing.out, /#164.*⚠/, 'the listing must flag the pending claim inline, not print it identically to a healthy one');
  assert.match(listing.out, /release pending|GitHub write failed|colab release/i, 'the reason should be printed, not just the marker');
});

test('worktree rm: a claim whose GitHub release SUCCEEDS is still cleared normally (contrast case)', () => {
  const fx = repoFixture();
  const ghBin = fakeGhFixture();
  const name = 'graphql-ok-165';
  const branch = 'fix/graphql-ok-165';
  const wtPath = path.join(fx.root, name);

  fx.g(fx.work, 'worktree', 'add', '-b', branch, wtPath, 'origin/main');
  writeState(fx, {
    version: 1,
    worktrees: { [name]: { repo: fx.work, path: wtPath, branch, ports: [], session: null, sessionName: null, created: new Date().toISOString() } },
    claims: {
      [claimKey(fx.work, 165)]: {
        issue: '#165', repo: fx.work, worktree: name, branch, host: 'test-host',
        session: null, sessionName: null, created: new Date().toISOString(),
      },
    },
    ports: {}, solo: {},
  });

  const r = colab(fx, ghBin, 'ok', ['worktree', 'rm', name, '--repo', fx.work]);
  assert.strictEqual(r.code, 0, r.err);
  assert.doesNotMatch(r.out, /FAILED/, 'a clean release must not report a failure');

  const st = readState(fx);
  assert.strictEqual(st.claims[claimKey(fx.work, 165)], undefined, 'a successfully-released claim must still be cleared — the fix is about the FAILURE path only');
});

test('release: the standalone `colab release` command keeps the claim the same way on a double-transport failure', () => {
  const fx = repoFixture();
  const ghBin = fakeGhFixture();

  // No worktree at all here — a trunk-side claim, the other call site `colab release` covers.
  writeState(fx, {
    version: 1,
    worktrees: {},
    claims: {
      [claimKey(fx.work, 166)]: {
        issue: '#166', repo: fx.work, worktree: null, branch: null, host: 'test-host',
        session: null, sessionName: null, created: new Date().toISOString(),
      },
    },
    ports: {}, solo: {},
  });

  const r = colab(fx, ghBin, 'both-fail', ['release', '166', '--repo', fx.work]);
  assert.strictEqual(r.code, 0, r.err);
  assert.match(r.out, /PENDING/i);

  const claim = readState(fx).claims[claimKey(fx.work, 166)];
  assert.ok(claim, '#166 must still have a local claim record after a failed release');
  assert.strictEqual(claim.releasePending, true);
});
