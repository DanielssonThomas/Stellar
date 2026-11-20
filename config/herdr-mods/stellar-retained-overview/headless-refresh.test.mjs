import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const playwrightRoot = process.env.STELLAR_OVERVIEW_PLAYWRIGHT_ROOT;
const require = createRequire(playwrightRoot
  ? resolve(playwrightRoot, "package.json")
  : new URL("../../../package.json", import.meta.url));
const { chromium } = require("@playwright/test");

const worker = (summary) => ({ issue: 367, role: "peon-cloud", claim_session: "claim-367",
  runtime_session: null, incarnation: "inc-367", terminal: "t7", process: "running",
  status: "working", exit_code: null, source: "attempts/367/terminal.json", tests: "unverified",
  review: "unverified", merge: "unverified", summary });
const snapshot = (summary, generated_at = Date.now() / 1000) => JSON.stringify({
  schemaVersion: 1, generated_at, available: true,
  coverage: "Confirmed receipt-backed launches only; missing entries are not an all-clear.",
  warnings: [], workers: [worker(summary)],
});
const productionState = readFileSync(new URL("./snapshot-state.mjs", import.meta.url), "utf8");

const html = `<!doctype html><meta charset="utf-8"><style>
*{box-sizing:border-box}body{margin:0;padding:16px;background:#081426;color:#eef1f6;font:14px system-ui}
main{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,420px),1fr));gap:12px}
article{min-width:0;background:#102039;border:1px solid #8f7b49;border-radius:8px;padding:12px;overflow-wrap:anywhere}
h1{color:#e4c477}#fresh{color:#e4c477}</style>
<h1>Stellar retained workers</h1><p id="coverage"></p><p id="fresh"></p><p id="warning"></p><main id="cards"></main>
<script type="module">
import {RefreshController,RetainedSnapshot,freshness} from '/snapshot-state.mjs';
const state=new RetainedSnapshot();
function render(){const s=state.snapshot;if(!s)return;document.querySelector('#fresh').textContent=freshness(s.generated_at);
document.querySelector('#coverage').textContent=s.coverage;document.querySelector('#warning').textContent=state.warning;
const cards=document.querySelector('#cards');cards.replaceChildren();for(const w of s.workers){const card=document.createElement('article');
for(const value of ['Issue #'+w.issue+' · '+w.role,w.summary,'Process: '+w.process+' · task status: '+w.status,
'Claim: '+w.claim_session+' · incarnation: '+w.incarnation,'Tests/review/merge: '+w.tests+'/'+w.review+'/'+w.merge]){
const p=document.createElement('p');p.textContent=value;card.appendChild(p)}cards.appendChild(card)}}
const refresh=new RefreshController(async()=>{try{const r=await fetch('/snapshot');if(!r.ok)throw Error('Snapshot unavailable');state.accept(await r.text())}
catch(e){state.fail(e)}},render,(ms,callback)=>{const timer=setTimeout(callback,ms);return{cancel:()=>clearTimeout(timer)}});
refresh.start();addEventListener('pagehide',()=>refresh.close());
</script>`;

test("isolated headless 360/1440 update, failure recovery, stale warning, reload and reopen", async () => {
  let payload = snapshot("Running · update A");
  let responseMode = "valid";
  const server = createServer((request, response) => {
    if (request.url === "/snapshot-state.mjs") {
      response.setHeader("content-type", "text/javascript; charset=utf-8");
      response.end(productionState);
      return;
    }
    if (request.url === "/snapshot") {
      response.setHeader("content-type", "application/json; charset=utf-8");
      if (responseMode === "unavailable") {
        response.statusCode = 503;
        response.end("unavailable");
        return;
      }
      if (responseMode === "malformed") {
        response.end(JSON.stringify({ schemaVersion: 1, generated_at: Date.now() / 1000,
          available: true, coverage: "test", warnings: [], workers: [null] }));
        return;
      }
      if (responseMode === "oversized") {
        response.end("x".repeat(65537));
        return;
      }
      response.end(payload);
      return;
    }
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(html);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const browser = await chromium.launch({ headless: true });
  try {
    for (const width of [360, 1440]) {
      payload = snapshot("Running · update A");
      responseMode = "valid";
      const context = await browser.newContext({ viewport: { width, height: 900 } });
      const page = await context.newPage();
      await page.addInitScript(() => {
        const original = window.setTimeout.bind(window);
        window.setTimeout = (callback, delay, ...args) => original(callback, Math.min(delay, 30), ...args);
      });
      page.on("pageerror", (error) => console.error("headless fixture page error:", error));
      page.on("requestfailed", (request) => console.error("headless fixture request failed:", request.url(), request.failure()?.errorText));
      await page.goto(`http://127.0.0.1:${address.port}/`);
      await page.getByText("Running · update A").waitFor();
      payload = snapshot("Running · update B");
      await page.getByText("Running · update B").waitFor();
      for (const [mode, warning] of [
        ["unavailable", "Snapshot unavailable"],
        ["malformed", "malformed worker identity"],
        ["oversized", "Snapshot exceeds 64 KiB"],
      ]) {
        responseMode = mode;
        await page.locator("#warning").getByText(warning).waitFor();
        await page.getByText("Running · update B").waitFor();
        assert.equal(await page.locator("article").count(), 1);
      }
      responseMode = "valid";
      payload = snapshot("Recovered · update C");
      await page.getByText("Recovered · update C").waitFor();
      payload = snapshot("Last good retained during outage", (Date.now() - 120000) / 1000);
      await page.locator("#fresh").filter({ hasText: "Snapshot stale" }).waitFor();
      await page.getByText("Last good retained during outage").waitFor();
      const layout = await page.evaluate(() => ({
        overflow: document.documentElement.scrollWidth > innerWidth,
        background: getComputedStyle(document.body).backgroundColor,
        gold: getComputedStyle(document.querySelector("h1")).color,
      }));
      assert.deepEqual(layout, { overflow: false, background: "rgb(8, 20, 38)", gold: "rgb(228, 196, 119)" });
      await page.reload();
      await page.getByText("Last good retained during outage").waitFor();
      await context.close();
      const reopened = await browser.newContext({ viewport: { width, height: 900 } });
      const reopenedPage = await reopened.newPage();
      await reopenedPage.goto(`http://127.0.0.1:${address.port}/`);
      await reopenedPage.getByText("Last good retained during outage").waitFor();
      assert.equal(await reopenedPage.locator("article").count(), 1);
      await reopened.close();
    }
  } finally {
    await browser.close();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
