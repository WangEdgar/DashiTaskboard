import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

function git(args, cwd = process.cwd(), allowFailure = false) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFailure) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || `git ${args[0]} failed`);
  }
  return result;
}

try {
  const mode = process.argv[2] ?? 'check';
  if (!['check', 'prepare'].includes(mode) || process.argv.length > 3) {
    throw new Error('Usage: node scripts/sync-upstream.mjs [check|prepare]');
  }
  const root = git(['rev-parse', '--show-toplevel']).stdout.trim();
  const origin = git(['remote', 'get-url', 'origin'], root).stdout.trim();
  const upstream = git(['remote', 'get-url', 'upstream'], root).stdout.trim();
  if (origin === upstream) throw new Error('origin and upstream must point to different repositories.');
  // Fetch explicit refs so a customized fetch configuration cannot leave stale inputs.
  for (const remote of ['origin', 'upstream']) {
    git(['fetch', remote, `+refs/heads/main:refs/remotes/${remote}/main`], root);
  }
  const base = git(['rev-parse', 'origin/main'], root).stdout.trim();
  const incoming = git(['rev-parse', 'upstream/main'], root).stdout.trim();
  git(['merge-base', base, incoming], root);
  const counts = git(['rev-list', '--left-right', '--count', `${base}...${incoming}`], root).stdout.trim().split(/\s+/).map(Number);
  console.log(JSON.stringify({ originMain: base, upstreamMain: incoming, ownCommits: counts[0], incomingCommits: counts[1] }, null, 2));
  if (counts[1] === 0) {
    console.log('Already includes upstream/main. No worktree created.');
  } else {
    console.log(git(['log', '--oneline', `${base}..${incoming}`], root).stdout.trim());
    if (mode === 'prepare') {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const branch = `codex/sync-upstream-${stamp}`;
      const directory = path.join(root, '.runtime', `sync-upstream-${stamp}`);
      mkdirSync(path.dirname(directory), { recursive: true });
      git(['worktree', 'add', '-b', branch, directory, base], root);
      const merge = git(['merge', '--no-ff', '--no-commit', incoming], directory, true);
      console.log(JSON.stringify({ branch, directory }, null, 2));
      if (merge.status !== 0) {
        const conflicts = git(['diff', '--name-only', '--diff-filter=U'], directory).stdout.trim();
        console.error(conflicts ? `Resolve conflicts in the new worktree:\n${conflicts}` : merge.stderr || merge.stdout);
        process.exitCode = 1;
      } else {
        console.log('Merge prepared but NOT committed. Review the staged diff, verify local features, then commit and open a PR.');
      }
      console.log('The original checkout and main branch were not changed. To cancel, run git merge --abort inside the new worktree.');
    }
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
