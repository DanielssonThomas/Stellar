import assert from 'node:assert/strict';

export function createDependencyFixture(numbers = [23]) {
  const repository = 'DanielssonThomas/Stellar';
  const repositoryUrl = `https://api.github.com/repos/${repository}`;
  const state = {
    issue: {
      id: 1042,
      number: 42,
      repository_url: repositoryUrl,
      title: 'Repair dependency admission',
      state: 'open',
      body: `## Objective\nRepair admission.\n## Expected outcome\nAdmission verifies identities.\n## Acceptance criteria\n- [ ] Exact dependencies are checked.\n## Constraints\nKeep scope.\n## Dependencies\n${numbers.length ? numbers.map((number) => `#${number}`).join('\n') : 'None'}\n## Verification expectations\nRun tests.`,
      labels: [
        'priority:medium',
        'review:critical',
        'target:develop',
        'type:bug',
        'status:ready',
        'owner:codex',
      ].map((name) => ({ name })),
    },
    native: numbers.map((number) => ({
      id: 2000 + number,
      number,
      repository_url: repositoryUrl,
      state: 'closed',
      labels: [{ name: 'status:done' }],
    })),
    fetched: {},
    pages: new Map(),
  };
  state.fetched = Object.fromEntries(
    state.native.map((entry) => [entry.number, structuredClone(entry)]),
  );
  const calls = [];
  function read(route) {
    calls.push(route);
    const url = new URL(`${repositoryUrl}${route}`);
    if (url.pathname.endsWith('/dependencies/blocked_by')) {
      assert.equal(url.searchParams.get('per_page'), '100');
      const page = Number(url.searchParams.get('page'));
      return (
        state.pages.get(page) ?? {
          status: 200,
          value: state.native.slice((page - 1) * 100, page * 100),
          link: '',
        }
      );
    }
    const number = Number(route.match(/^\/issues\/(\d+)$/)?.[1]);
    assert.ok(Number.isSafeInteger(number));
    const value =
      number === state.issue.number ? state.issue : state.fetched[number];
    return { status: value ? 200 : 404, value: value ?? {}, link: '' };
  }
  return {
    repository,
    repositoryUrl,
    state,
    calls,
    request: async (route) => {
      const result = read(route);
      return new Response(JSON.stringify(result.value), {
        status: result.status,
        headers: { link: result.link ?? '' },
      });
    },
    runCommand: (command, args) => {
      assert.equal(command, 'gh');
      assert.deepEqual(args.slice(0, -1), [
        'api',
        '--include',
        '--hostname',
        'github.com',
        '--method',
        'GET',
      ]);
      const prefix = `repos/${repository}`;
      assert.ok(args.at(-1).startsWith(prefix));
      const result = read(args.at(-1).slice(prefix.length));
      return `HTTP/2.0 ${result.status} Fixture\r\ncontent-type: application/json\r\n${result.link ? `link: ${result.link}\r\n` : ''}\r\n${JSON.stringify(result.value)}`;
    },
  };
}
