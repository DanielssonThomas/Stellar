import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function requiresBrowserInstall(projectsJson) {
  const projects = JSON.parse(projectsJson);
  if (
    !Array.isArray(projects) ||
    projects.some((name) => typeof name !== 'string' || name.length === 0)
  ) {
    throw new Error('Expected the Nx list of projects with an E2E target');
  }
  return projects.length > 0;
}

export function requireSuccessfulJobs(quality, native) {
  if (quality !== 'success' || native !== 'success') {
    throw new Error(
      `Required CI jobs did not succeed: quality=${quality}, native=${native}`,
    );
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    if (process.argv[2] === 'e2e') {
      console.log(requiresBrowserInstall(readFileSync(0, 'utf8')));
    } else if (process.argv[2] === 'gate') {
      requireSuccessfulJobs(
        process.env.QUALITY_RESULT,
        process.env.NATIVE_RESULT,
      );
      console.log('Frontend and Windows native checks succeeded.');
    } else {
      throw new Error('Expected e2e or gate command');
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
