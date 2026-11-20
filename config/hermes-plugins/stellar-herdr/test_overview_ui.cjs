/* Browser checks for the generated, framework-free retained overview. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { chromium } = require(
  require.resolve('@playwright/test', {
    paths: [process.env.STELLAR_PLAYWRIGHT_ROOT || process.cwd()],
  }),
);

(async () => {
  const directory = process.argv[2];
  assert(
    directory,
    'Pass an output directory for generated fixtures and evidence',
  );
  execFileSync(
    process.env.PYTHON || 'python',
    ['-m', 'stellar-herdr.overview_fixture', directory],
    {
      env: {
        ...process.env,
        PYTHONPATH: [path.dirname(__dirname), process.env.PYTHONPATH]
          .filter(Boolean)
          .join(path.delimiter),
      },
      stdio: 'inherit',
    },
  );
  const browser = await chromium.launch({ headless: true });
  try {
    const results = [];
    for (const width of [360, 1440]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      const errors = [];
      page.on('pageerror', (error) => errors.push(String(error)));
      await page.goto(
        pathToFileURL(path.resolve(directory, 'fixture.html')).href,
      );
      assert.equal(await page.locator('article').count(), 6);
      assert(
        await page
          .getByText('Exited zero; work remains incomplete/unverified.')
          .isVisible(),
      );
      assert(
        await page
          .getByText(
            'Worker reports blocked; resolution and work remain unverified.',
          )
          .isVisible(),
      );
      assert(
        await page
          .getByText('Retained launch; current process metadata unavailable.')
          .isVisible(),
      );
      const layout = await page.evaluate(() => ({
        overflow: document.documentElement.scrollWidth > innerWidth,
        background: getComputedStyle(document.body).backgroundColor,
        gold: getComputedStyle(document.querySelector('h1')).color,
        columns: getComputedStyle(document.querySelector('main'))
          .gridTemplateColumns,
        scripts: document.scripts.length,
      }));
      assert.equal(layout.overflow, false);
      assert.equal(layout.background, 'rgb(8, 20, 38)');
      assert.equal(layout.gold, 'rgb(228, 196, 119)');
      assert.equal(layout.scripts, 0);
      assert.equal(errors.length, 0);
      await page.screenshot({
        path: path.join(directory, `overview-${width}.png`),
        fullPage: true,
      });
      results.push({ width, ...layout, errors });
      await page.reload();
      assert.equal(await page.locator('article').count(), 6);
      await page.close();
    }
    fs.writeFileSync(
      path.join(directory, 'ui-results.json'),
      JSON.stringify(results, null, 2),
    );
    console.log(JSON.stringify(results));
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
