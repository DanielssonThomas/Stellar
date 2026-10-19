import { execFileSync } from 'node:child_process';
import { validateCommitMessage } from './validate-commit-message.mjs';

const base = process.env.NX_BASE ?? '';
const head = process.env.NX_HEAD ?? 'HEAD';
const rootPush = !base || /^0+$/.test(base);
const commits = execFileSync(
  'git',
  ['rev-list', '--no-merges', ...(rootPush ? [head] : [`${base}..${head}`])],
  { encoding: 'utf8' },
)
  .trim()
  .split(/\r?\n/)
  .filter(Boolean);

if (commits.length === 0) {
  console.log('No commits to validate.');
  process.exit(0);
}

const issues = new Set();
for (const commit of commits) {
  const message = execFileSync('git', ['show', '-s', '--format=%B', commit], {
    encoding: 'utf8',
  });
  const error = validateCommitMessage(message);
  if (error) throw new Error(`${commit.slice(0, 8)}: ${error}`);
  issues.add(message.match(/^\[#([1-9][0-9]*)\]/m)[1]);
}

if (process.env.GITHUB_TOKEN && process.env.GITHUB_REPOSITORY) {
  const apiUrl = process.env.GITHUB_API_URL ?? 'https://api.github.com';
  await Promise.all(
    [...issues].map(async (number) => {
      const response = await fetch(
        `${apiUrl}/repos/${process.env.GITHUB_REPOSITORY}/issues/${number}`,
        {
          headers: {
            Accept: 'application/vnd.github+json',
            Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
            'X-GitHub-Api-Version': '2026-03-10',
          },
        },
      );
      if (!response.ok)
        throw new Error(
          `Issue #${number} cannot be verified (${response.status}).`,
        );
      const issue = await response.json();
      if (issue.pull_request)
        throw new Error(`#${number} is a pull request, not an issue.`);
    }),
  );
}

console.log(
  `Validated ${commits.length} commits against ${issues.size} issue(s).`,
);
