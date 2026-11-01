import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';

export const response = (status, value = {}) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

export function createIntegrationFixture({ onRequest } = {}) {
  const repository = 'DanielssonThomas/Stellar';
  const headSha = 'a'.repeat(40);
  const baseSha = 'b'.repeat(40);
  const filename = 'libs/ui/atoms/src/lib/status-label-atom.component.ts';
  const issue = {
    id: 124,
    repository_url: `https://api.github.com/repos/${repository}`,
    number: 24,
    state: 'open',
    title: 'Add loading status atom',
    body: `## Objective\nAdd a reusable status atom.\n## Context\nA small bounded trial.\n## Expected outcome\nA reusable loading-aware status atom.\n## Acceptance criteria\n- [ ] Add the atom and its tests.\n## Constraints\nOnly the scoped component files.\n## Dependencies\nNone\n## Agent integration scope\nRisk: low\nAllowed files:\n- \`${filename}\`\n## Verification expectations\nRun focused tests.`,
    labels: [
      'priority:medium',
      'review:standard',
      'target:develop',
      'type:feature',
      'status:review',
      'worker:peon',
      'agent:automerge',
    ].map((name) => ({ name })),
  };
  const principal = { id: 12, login: 'integration-bot' };
  const repo = {
    id: 100,
    full_name: repository,
    archived: false,
    disabled: false,
    allow_squash_merge: true,
  };
  const pull = {
    number: 300,
    state: 'open',
    draft: false,
    body: 'Fixes #24',
    user: principal,
    head: {
      sha: headSha,
      ref: 'issue/24-status-label-atom',
      repo: { id: 101, full_name: 'Stellar-AI-Corp/Stellar', fork: true },
    },
    base: { sha: baseSha, ref: 'develop', repo },
    commits: 1,
    changed_files: 1,
    mergeable: true,
    mergeable_state: 'clean',
  };
  const ruleBodies = [
    {
      type: 'pull_request',
      parameters: {
        dismiss_stale_reviews_on_push: false,
        require_code_owner_review: false,
        require_last_push_approval: false,
        required_approving_review_count: 0,
        required_review_thread_resolution: false,
        allowed_merge_methods: ['squash'],
      },
    },
    {
      type: 'required_status_checks',
      parameters: {
        required_status_checks: [{ context: 'verify', integration_id: 15368 }],
        strict_required_status_checks_policy: true,
      },
    },
    { type: 'deletion' },
    { type: 'non_fast_forward' },
  ];
  const text = '/tools/policy/ @maintainer\n/.github/ @maintainer\n';
  const bytes = Buffer.from(text);
  const state = {
    repository: repo,
    principal,
    issue,
    pull,
    target: { name: 'develop', commit: { sha: baseSha }, protected: true },
    commits: [
      {
        sha: headSha,
        commit: { message: '[#24] feat(ui): add loading status atom' },
        parents: [{ sha: baseSha }],
        author: { id: 20, login: 'stellar-peon' },
        committer: { id: 20, login: 'stellar-peon' },
      },
    ],
    files: [
      {
        sha: 'c'.repeat(40),
        filename,
        status: 'modified',
        additions: 3,
        deletions: 0,
        changes: 3,
      },
    ],
    checks: [
      {
        id: 400,
        name: 'verify',
        head_sha: headSha,
        status: 'completed',
        conclusion: 'success',
        app: { id: 15368, slug: 'github-actions' },
      },
    ],
    codeowners: {
      type: 'file',
      path: '.github/CODEOWNERS',
      encoding: 'base64',
      content: bytes.toString('base64'),
      sha: createHash('sha1')
        .update(`blob ${bytes.length}\0`)
        .update(bytes)
        .digest('hex'),
    },
    branchRules: ruleBodies.map((rule) => ({
      ...rule,
      ruleset_id: 7,
      ruleset_source_type: 'Repository',
      ruleset_source: repository,
    })),
    rulesets: [
      {
        id: 7,
        source: repository,
        source_type: 'Repository',
        enforcement: 'active',
        target: 'branch',
        bypass_actors: [],
        rules: ruleBodies,
      },
    ],
    protection: {
      enforce_admins: { enabled: true },
      required_status_checks: {
        strict: true,
        contexts: ['verify'],
        checks: [{ context: 'verify', app_id: 15368 }],
      },
      required_pull_request_reviews: {
        dismiss_stale_reviews: false,
        require_code_owner_reviews: false,
        require_last_push_approval: false,
        required_approving_review_count: 0,
      },
      required_conversation_resolution: { enabled: false },
    },
    dependencies: [],
    dependencyIssues: {},
    threads: [],
  };
  const calls = [];
  const request = async (route, options = {}) => {
    calls.push({
      path: route,
      method: options.method ?? 'GET',
      body: options.body,
    });
    const overridden = await onRequest?.(route, options, state, calls);
    if (overridden !== undefined) return overridden;
    const url = new URL(route || '/', 'https://fixture.invalid');
    const page = Number(url.searchParams.get('page') ?? 1);
    const paged = (values) =>
      response(200, values.slice((page - 1) * 100, page * 100));
    if (route === '') return response(200, state.repository);
    if (route === '/@root/user') return response(200, state.principal);
    if (url.pathname === `/issues/${state.issue.number}`)
      return response(200, state.issue);
    if (
      url.pathname === `/issues/${state.issue.number}/dependencies/blocked_by`
    )
      return paged(state.dependencies);
    if (
      /^\/issues\/\d+$/.test(url.pathname) &&
      state.dependencyIssues[url.pathname.split('/').at(-1)]
    )
      return response(
        200,
        state.dependencyIssues[url.pathname.split('/').at(-1)],
      );
    if (url.pathname === `/pulls/${state.pull.number}`)
      return response(200, state.pull);
    if (url.pathname === `/pulls/${state.pull.number}/commits`)
      return paged(state.commits);
    if (url.pathname === `/pulls/${state.pull.number}/files`)
      return paged(state.files);
    if (url.pathname === `/commits/${state.pull.head.sha}/check-runs`)
      return response(200, {
        total_count: state.checks.length,
        check_runs: state.checks.slice((page - 1) * 100, page * 100),
      });
    if (route === '/branches/develop') return response(200, state.target);
    if (route === `/contents/.github/CODEOWNERS?ref=${state.target.commit.sha}`)
      return response(200, state.codeowners);
    if (url.pathname === '/rules/branches/develop')
      return paged(state.branchRules);
    if (/^\/rulesets\/\d+$/.test(url.pathname))
      return response(
        200,
        state.rulesets.find(
          (rule) => rule.id === Number(url.pathname.split('/').at(-1)),
        ),
      );
    if (route === '/branches/develop/protection')
      return response(200, state.protection);
    if (route === '/@root/graphql' && options.method === 'POST') {
      const start = options.body.variables.cursor
        ? Number(options.body.variables.cursor)
        : 0;
      const nodes = state.threads.slice(start, start + 100);
      return response(200, {
        data: {
          repository: {
            databaseId: state.repository.id,
            nameWithOwner: state.repository.full_name,
            pullRequest: {
              number: state.pull.number,
              headRefOid: state.pull.head.sha,
              reviewThreads: {
                totalCount: state.threads.length,
                nodes,
                pageInfo: {
                  hasNextPage: start + 100 < state.threads.length,
                  endCursor: String(start + 100),
                },
              },
            },
          },
        },
      });
    }
    throw new Error(
      `Unexpected integration fixture request: ${options.method ?? 'GET'} ${route}`,
    );
  };
  const workerPolicy = [
    {
      id: 'peon',
      forkFullName: 'Stellar-AI-Corp/Stellar',
      pullRequestActor: 'stellar-peon',
    },
  ];
  return {
    state,
    request,
    calls,
    workerPolicy,
    options: {
      issueNumber: 24,
      pullNumber: 300,
      repository,
      workerConfig: {
        ids: ['peon'],
        workers: new Map(workerPolicy.map((worker) => [worker.id, worker])),
      },
    },
  };
}
