'use strict';
/**
 * Tests for the audit's handling of a detached HEAD with zero local branch refs
 * (audit/audit.mjs, `branches()`) — issue #104.
 *
 * A `pull_request` workflow run checks out the merge commit detached, with no
 * `refs/heads` at all (actions/checkout defaults to fetch-depth 1). Before the fix,
 * `branches()` returned that as an empty ARRAY, which the trunk-existence check reads
 * as "trunk does not exist" — a repo whose CI can never pass a `pull_request` run no
 * matter what the PR contains. The fix: an empty ref list plus a detached HEAD is
 * reported the same way as "not a git checkout" (null, unverifiable) instead of
 * inventing a trunk-missing finding.
 *
 * Fixtures are real git repos, not mocks — a detached HEAD with zero local branches is
 * exactly the state `git rev-parse`/`for-each-ref` produce, and that plumbing is the
 * thing under test.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const AUDIT = path.join(REPO_ROOT, 'audit', 'audit.mjs');

const TMP = [];
process.on('exit', () => { for (const d of TMP) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {} } });

const TIER_B = 'tier: B\ntrunk: main\nproduction: null\ndeploy: none\nstack: node\n';

/** A tier B repo on `main`, with a project.yml, committed normally. */
function fixture(projectYml) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-shallow-'));
  TMP.push(dir);
  const g = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  g('init', '-q', '-b', 'main', '.');
  g('config', 'user.email', 'test@example.invalid');
  g('config', 'user.name', 'audit test');
  g('config', 'core.hooksPath', path.join(dir, '.nohooks'));
  fs.mkdirSync(path.join(dir, '.github'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.github', 'project.yml'), projectYml);
  g('add', '-A');
  g('commit', '-q', '-m', 'chore: fixture');
  return dir;
}

/** Clone `srcDir` and land on a detached HEAD with zero local branch refs — the same
 * shape as a shallow `pull_request` checkout (no refs/heads at all). */
function detachedNoBranchesClone(srcDir) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-shallow-clone-'));
  TMP.push(dir);
  execFileSync('git', ['clone', '-q', srcDir, dir], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const g = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  g('checkout', '-q', '--detach', 'HEAD');
  g('branch', '-D', 'main');
  return dir;
}

function audit(dir) {
  let stdout;
  try {
    stdout = execFileSync('node', [AUDIT, '--json', '--local', dir], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (err) {
    stdout = err.stdout || '';
  }
  const r = JSON.parse(stdout).results[0];
  return {
    ok: r.ok,
    fails: r.findings.filter((f) => f.level === 'fail').map((f) => f.text),
    warns: r.findings.filter((f) => f.level === 'warn').map((f) => f.text),
  };
}

const hasText = (list, rx) => list.some((t) => rx.test(t));

test('a normal checkout with the trunk branch present is clean (control)', () => {
  const r = audit(fixture(TIER_B));
  assert.deepStrictEqual(r.fails, []);
});

test('a detached HEAD with zero local branch refs is reported as unverifiable, not "trunk does not exist"', () => {
  const src = fixture(TIER_B);
  const shallow = detachedNoBranchesClone(src);
  const r = audit(shallow);
  assert.ok(!hasText(r.fails, /does not exist/), `trunk wrongly reported missing: ${r.fails.join(' | ')}`);
  assert.ok(hasText(r.warns, /cannot list branches/), `expected an unverifiable warning, got fails=${r.fails.join(' | ')} warns=${r.warns.join(' | ')}`);
});
