'use strict';
/**
 * Tests for two independent `worktree` defects:
 *
 * #124 — `worktree new <branch>` on a name that already exists (locally or on origin) used to
 * silently cut a FRESH branch from base, discarding the existing branch's history. Only signal
 * was a parenthetical `(base origin/main @ sha)` in the success line, read as routine provenance.
 *
 * #148 — `ship`'s own refusal, when a worktree record's branch resolves to no ref, used to
 * prescribe `colab release <N> && colab claim <N> --branch <b> --worktree <name>` — which repairs
 * the CLAIM record only. `ship` reads the WORKTREE record's branch field (`resolveShipSession`),
 * so the same refusal fired again, identically, with no CLI path out of it. `worktree tag
 * --branch` is the fix: the one command that owns the worktree record can now repair it.
 *
 * Run: `node --test tools/lib/*.test.js` — the existing CI glob picks this file up.
 * `COLAB_HOME` is redirected per test, so the developer's real state.json is never read or written.
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

const PROJECT_YML = 'tier: B\ntrunk: main\nproduction: null\ndeploy: none\nstack: node\nautonomy: auto-trunk\n';

/** A clone with a real bare `origin`, a `main` trunk, and a private COLAB_HOME. No network. */
function fixture(projectYml = PROJECT_YML) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'colab-wtbranch-'));
  TMP.push(root);
  const origin = path.join(root, 'origin.git');
  const work = path.join(root, 'work');
  const home = path.join(root, 'colab-home');
  fs.mkdirSync(home);
  const g = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin], { encoding: 'utf8' });
  execFileSync('git', ['init', '-q', '-b', 'main', work], { encoding: 'utf8' });
  g(work, 'config', 'user.email', 'test@example.invalid');
  g(work, 'config', 'user.name', 'colab wtbranch test');
  g(work, 'config', 'core.hooksPath', path.join(root, '.nohooks'));
  g(work, 'remote', 'add', 'origin', origin);
  fs.mkdirSync(path.join(work, '.github'), { recursive: true });
  fs.writeFileSync(path.join(work, '.github', 'project.yml'), projectYml);
  g(work, 'add', '-A');
  g(work, 'commit', '-q', '-m', 'chore: fixture');
  g(work, 'push', '-q', 'origin', 'main');

  return { root, origin, work, home, g };
}

function colab(fx, args) {
  const r = spawnSync('node', [COLAB, ...args], {
    encoding: 'utf8',
    env: { ...process.env, COLAB_HOME: fx.home, COLAB_SESSION: '', COLAB_SESSION_NAME: '' },
  });
  return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
}

const statePath = (fx) => path.join(fx.home, 'state.json');
const readState = (fx) => JSON.parse(fs.readFileSync(statePath(fx), 'utf8'));

// --- #124 --------------------------------------------------------------------

test('#124: worktree new refuses a branch that already exists LOCALLY, and does not cut a fresh one', () => {
  const fx = fixture();
  // Create the branch with real, distinguishing history — outside colab, the way a torn-down
  // worktree would leave it.
  fx.g(fx.work, 'branch', 'fix/existing-124');
  const wtDir = path.join(fx.root, 'manual-wt');
  fx.g(fx.work, 'worktree', 'add', wtDir, 'fix/existing-124');
  fs.writeFileSync(path.join(wtDir, 'evidence.txt'), 'history that must survive\n');
  fx.g(wtDir, 'add', '-A');
  fx.g(wtDir, 'commit', '-q', '-m', 'feat: evidence commit');
  const trueSha = fx.g(wtDir, 'rev-parse', 'HEAD').trim();
  fx.g(wtDir, 'push', '-q', 'origin', 'fix/existing-124');
  fx.g(fx.work, 'worktree', 'remove', wtDir, '--force');

  const r = colab(fx, ['worktree', 'new', 'fix/existing-124', '--repo', fx.work]);
  assert.notStrictEqual(r.code, 0, r.out);
  assert.match(r.err + r.out, /already exists/);
  assert.match(r.err + r.out, /refus/i);
  assert.match(r.err + r.out, new RegExp(trueSha.slice(0, 7)));
  assert.ok(!fs.existsSync(path.join(fx.work, '.worktrees', 'existing-124')),
    'no worktree must have been built over the existing branch');

  // The branch itself must be untouched — still pointing at the evidence commit, not base.
  const headAfter = fx.g(fx.work, 'rev-parse', 'fix/existing-124').trim();
  assert.strictEqual(headAfter, trueSha, 'the existing history must not have been discarded');
});

test('#124: worktree new refuses a branch that exists only on ORIGIN (no local tracking ref)', () => {
  const fx = fixture();
  const wtDir = path.join(fx.root, 'manual-wt2');
  fx.g(fx.work, 'worktree', 'add', '-b', 'fix/remote-only-124', wtDir, 'main');
  fs.writeFileSync(path.join(wtDir, 'evidence.txt'), 'remote history\n');
  fx.g(wtDir, 'add', '-A');
  fx.g(wtDir, 'commit', '-q', '-m', 'feat: remote evidence');
  fx.g(wtDir, 'push', '-q', 'origin', 'fix/remote-only-124');
  fx.g(fx.work, 'worktree', 'remove', wtDir, '--force');
  // Delete the LOCAL branch and any remote-tracking ref — colab's own `git fetch origin <base>`
  // (base = main) never refreshes this name, so only an authoritative (ls-remote) check can see it.
  fx.g(fx.work, 'branch', '-D', 'fix/remote-only-124');
  fx.g(fx.work, 'branch', '-r', '-d', 'origin/fix/remote-only-124');

  const r = colab(fx, ['worktree', 'new', 'fix/remote-only-124', '--repo', fx.work]);
  assert.notStrictEqual(r.code, 0, r.out);
  assert.match(r.err + r.out, /already exists/);
  assert.ok(!fs.existsSync(path.join(fx.work, '.worktrees', 'remote-only-124')));
});

test('#124: worktree new proceeds normally when the branch name is genuinely new', () => {
  const fx = fixture();
  const r = colab(fx, ['worktree', 'new', 'fix/brand-new-124', '--repo', fx.work]);
  assert.strictEqual(r.code, 0, r.err);
  assert.match(r.out, /Worktree ready/);
});

test('#124: --force does NOT bypass the branch-already-exists refusal (unlike the issue-conflict refusal)', () => {
  const fx = fixture();
  fx.g(fx.work, 'branch', 'fix/forceme-124');

  const r = colab(fx, ['worktree', 'new', 'fix/forceme-124', '--force', '--repo', fx.work]);
  assert.notStrictEqual(r.code, 0, r.out);
  assert.match(r.err + r.out, /already exists/);
});

// --- #148 --------------------------------------------------------------------

test('#148: worktree tag --branch repairs the WORKTREE record ship actually reads', () => {
  const fx = fixture();
  assert.strictEqual(colab(fx, ['worktree', 'new', 'fix/real-148', '--issues', '148', '--repo', fx.work]).code, 0);

  // Reproduce the field defect: the worktree record's branch resolves to no ref (e.g. a stored
  // slug missing its type/ prefix), while a real branch with that history exists.
  const st = readState(fx);
  st.worktrees['real-148'].branch = 'not-a-real-ref';
  fs.writeFileSync(statePath(fx), JSON.stringify(st, null, 2) + '\n');

  const broken = colab(fx, ['ship', '--worktree', 'real-148', '--repo', fx.work, '--dry']);
  assert.notStrictEqual(broken.code, 0, broken.out);
  assert.match(broken.err, /resolves to no ref/);
  // The refusal must prescribe a repair that actually cures it — worktree tag, not the old
  // release+claim pair that only ever touched the claim record.
  assert.match(broken.err, /worktree tag real-148 --branch/);

  // Follow the refusal's own prescribed repair, verbatim.
  const tag = colab(fx, ['worktree', 'tag', 'real-148', '--branch', 'fix/real-148']);
  assert.strictEqual(tag.code, 0, tag.err);
  assert.match(tag.out, /branch:\s+not-a-real-ref → fix\/real-148/);

  const fixedState = readState(fx);
  assert.strictEqual(fixedState.worktrees['real-148'].branch, 'fix/real-148', 'the WORKTREE record must be repaired');
  const claimKey = `${fs.realpathSync(fx.work)}#148`;
  assert.strictEqual(fixedState.claims[claimKey].branch, 'fix/real-148', 'the CLAIM record must be repaired too — doctor reports on claims');

  // And the SAME refusal must not fire again.
  const after = colab(fx, ['ship', '--worktree', 'real-148', '--repo', fx.work, '--dry']);
  assert.ok(!/resolves to no ref/.test(after.err), `ship still refused after the prescribed repair:\n${after.err}\n${after.out}`);
});

test('#148: worktree tag --session/--session-name still work unchanged (no --branch passed)', () => {
  const fx = fixture();
  assert.strictEqual(colab(fx, ['worktree', 'new', 'fix/sess-148', '--repo', fx.work]).code, 0);
  const before = readState(fx).worktrees['sess-148'].branch;

  const r = colab(fx, ['worktree', 'tag', 'sess-148', '--session', 'https://claude.ai/code/session_x']);
  assert.strictEqual(r.code, 0, r.err);

  const st = readState(fx);
  assert.strictEqual(st.worktrees['sess-148'].session, 'https://claude.ai/code/session_x');
  assert.strictEqual(st.worktrees['sess-148'].branch, before, 'branch must be untouched when --branch is not passed');
});

test('#148: worktree tag refuses when nothing is passed at all', () => {
  const fx = fixture();
  assert.strictEqual(colab(fx, ['worktree', 'new', 'fix/nothing-148', '--repo', fx.work]).code, 0);
  const r = colab(fx, ['worktree', 'tag', 'nothing-148']);
  assert.notStrictEqual(r.code, 0);
  assert.match(r.err + r.out, /Nothing to tag/);
});
