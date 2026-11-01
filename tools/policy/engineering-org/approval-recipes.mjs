import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { registerHostRecipe } from './host-session.mjs';

export async function inertApprovalRecipes() {
  const entryPoint = fileURLToPath(
    new URL('./inert-approval-role.mjs', import.meta.url),
  );
  const expectedDigest = createHash('sha256')
    .update(await readFile(entryPoint))
    .digest('hex');
  return Object.fromEntries(
    await Promise.all(
      [
        ['pr-review', 'foreman'],
        ['architect-approval', 'architect'],
      ].map(async ([phase, role]) => [
        phase,
        await registerHostRecipe({
          phase,
          role,
          entryPoint,
          expectedDigest,
          mode: 'inert',
        }),
      ]),
    ),
  );
}
