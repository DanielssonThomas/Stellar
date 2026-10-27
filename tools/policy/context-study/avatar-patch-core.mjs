import path from 'node:path';

export const avatarSource =
  'libs/ui/atoms/src/lib/atoms/skeleton-atom.component.ts';
export const avatarTest =
  'libs/ui/atoms/src/lib/atoms/skeleton-atom.component.spec.ts';
const allowed = new Set([avatarSource, avatarTest]);

export function avatarPrompt(source, exampleTest) {
  return `Implement a circular avatar loading shape in Stellar's existing SkeletonAtom. Return ONLY a unified git diff (no prose or code fence) touching exactly these paths: ${avatarSource} and ${avatarTest}. The test file does not exist yet. Add avatar to SkeletonShape and render a 40x40 pixel circle with existing Tailwind/semantic theme classes. Preserve text/control classes and aria-hidden. Add a focused Vitest test that renders the component, sets shape to avatar, and checks classes and aria-hidden. No other changes.\n\nCurrent component:\n${source}\n\nExisting atom test style:\n${exampleTest}`;
}

function safePath(value) {
  return (
    allowed.has(value) &&
    path.posix.normalize(value) === value &&
    !value.includes('\\') &&
    !value.includes('\0')
  );
}

export function validateAvatarPatch(patch) {
  if (typeof patch !== 'string' || patch.length < 50 || patch.length > 24_000)
    throw new Error('format: patch size');
  if (patch.includes('\r') || patch.includes('\0') || patch.includes('```'))
    throw new Error('format: patch encoding or fence');
  if (!patch.startsWith('diff --git ') || !patch.endsWith('\n'))
    throw new Error('format: unified diff required');
  const sections = patch.split(/(?=^diff --git )/m).filter(Boolean);
  const seen = new Set();
  for (const section of sections) {
    const lines = section.split('\n');
    const match = /^diff --git a\/([^ ]+) b\/([^ ]+)$/.exec(lines[0]);
    if (!match || match[1] !== match[2] || !safePath(match[1]))
      throw new Error('scope: disallowed patch path');
    const file = match[1];
    if (seen.has(file)) throw new Error('format: duplicate file section');
    seen.add(file);
    if (
      lines.some((line) =>
        /^(?:GIT binary patch|Binary files |rename |copy |deleted file mode |old mode |new mode |similarity index |dissimilarity index )/.test(
          line,
        ),
      )
    )
      throw new Error('scope: non-text or metadata change');
    const newFile = lines.includes('new file mode 100644');
    if (lines.some((line) => line.startsWith('new file mode ')) && !newFile)
      throw new Error('scope: unsupported file mode');
    if (file === avatarSource && newFile)
      throw new Error('scope: implementation must already exist');
    if (file === avatarTest && !newFile)
      throw new Error('scope: test must be new');
    const oldHeader = file === avatarTest ? '--- /dev/null' : `--- a/${file}`;
    if (!lines.includes(oldHeader) || !lines.includes(`+++ b/${file}`))
      throw new Error('format: file headers do not match');
    if (!lines.some((line) => /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/.test(line)))
      throw new Error('format: missing hunk');
    for (const line of lines.slice(1)) {
      if (/^diff --git /.test(line))
        throw new Error('format: unexpected file header');
      if (/^--- /.test(line) && line !== oldHeader)
        throw new Error('format: unexpected file header');
      if (/^\+\+\+ /.test(line) && line !== `+++ b/${file}`)
        throw new Error('format: unexpected file header');
    }
  }
  if (seen.size !== 2 || !seen.has(avatarSource) || !seen.has(avatarTest))
    throw new Error('scope: both implementation and focused test required');
  return [...seen];
}

export function validateAvatarResult(source, test) {
  const requiredSource = [
    /SkeletonShape\s*=\s*[^;]*['"]avatar['"]/,
    /['"][^'"]*\bh-10\b[^'"]*\bw-10\b[^'"]*['"]|['"][^'"]*\bw-10\b[^'"]*\bh-10\b[^'"]*['"]/,
    /rounded-full/,
    /aria-hidden=["']true["']/,
  ];
  const requiredTest = [
    /SkeletonAtom/,
    /setInput\(\s*['"]shape['"]\s*,\s*['"]avatar['"]\s*\)/,
    /expect\(/,
    /aria-hidden/,
    /rounded-full/,
    /h-10/,
    /w-10/,
  ];
  if (!requiredSource.every((pattern) => pattern.test(source)))
    throw new Error('behavior: avatar source assertions missing');
  if (!requiredTest.every((pattern) => pattern.test(test)))
    throw new Error('coverage: focused avatar assertions missing');
}

export function validateUsage(usage) {
  const {
    prompt_tokens: prompt,
    completion_tokens: output,
    total_tokens: total,
  } = usage ?? {};
  if (
    ![prompt, output, total].every(
      (value) => Number.isSafeInteger(value) && value >= 0,
    ) ||
    total !== prompt + output
  )
    throw new Error('metering: missing or inconsistent usage');
  if (prompt > 1_800 || output > 1_200 || total > 3_000)
    throw new Error('metering: token limit exceeded');
  return { prompt, output, total };
}
