export const apiVersion = '2026-03-10';

export function createGitHubRequest({
  token,
  apiUrl = 'https://api.github.com',
  repository,
}) {
  if (typeof token !== 'string' || !token)
    throw new Error('STELLAR_INTEGRATION_TOKEN is required.');
  if (!/^[^/]+\/[^/]+$/.test(repository ?? ''))
    throw new Error('GITHUB_REPOSITORY must be owner/repository.');

  return async function request(
    path,
    { method = 'GET', body, allow404 = false, allowStatuses = [] } = {},
  ) {
    const url = path.startsWith('/@root/')
      ? `${apiUrl}/${path.slice('/@root/'.length)}`
      : `${apiUrl}/repos/${repository}${path}`;
    const response = await fetch(url, {
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': apiVersion,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (
      !response.ok &&
      !(allow404 && response.status === 404) &&
      !allowStatuses.includes(response.status)
    )
      throw new Error(
        `GitHub API ${method} ${path} returned ${response.status}.`,
      );
    return response;
  };
}

export function normalizeWorkerConfig(value) {
  if (!Array.isArray(value))
    throw new Error('Worker identity policy is invalid.');
  const ids = new Set();
  const workers = new Map();
  for (const entry of value) {
    if (
      !entry ||
      typeof entry.id !== 'string' ||
      !/^[a-z0-9][a-z0-9-]*$/.test(entry.id) ||
      typeof entry.forkFullName !== 'string' ||
      !/^[^/]+\/[^/]+$/.test(entry.forkFullName) ||
      (entry.pullRequestActor !== undefined &&
        typeof entry.pullRequestActor !== 'string')
    )
      throw new Error('Worker identity policy contains an invalid entry.');
    if (ids.has(entry.id))
      throw new Error('Worker identity policy has duplicate IDs.');
    ids.add(entry.id);
    workers.set(entry.id, entry);
  }
  return { ids: [...ids], workers };
}
