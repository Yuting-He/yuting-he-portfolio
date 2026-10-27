import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { access } from "node:fs/promises";
import { collectSiteFiles } from "../scripts/assemble-site.mjs";

test("every element id referenced by the application exists in the page", async () => {
  const [script, html] = await Promise.all([
    readFile(new URL("../heatwave-demo.js", import.meta.url), "utf8"),
    readFile(new URL("../heatwave-demo.html", import.meta.url), "utf8")
  ]);
  const referencedIds = [...script.matchAll(/document\.querySelector\("#([^"]+)"\)/g)].map((match) => match[1]);
  const htmlIds = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]));
  const missing = referencedIds.filter((id) => !htmlIds.has(id));
  assert.ok(referencedIds.length >= 30);
  assert.deepEqual(missing, []);
});

test("interactive page uses bundled map libraries, OSM tiles, and exposes live-data boundaries", async () => {
  const [script, html, results] = await Promise.all([
    readFile(new URL("../heatwave-demo.js", import.meta.url), "utf8"),
    readFile(new URL("../heatwave-demo.html", import.meta.url), "utf8"),
    readFile(new URL("../heatwave-results.js", import.meta.url), "utf8")
  ]);
  assert.match(html, /\.\/vendor\/d3\.min\.js/);
  assert.match(html, /\.\/vendor\/leaflet\.js/);
  assert.match(html, /\.\/vendor\/leaflet\.css/);
  assert.match(html, /https:\/\/tile\.openstreetmap\.org/);
  assert.doesNotMatch(html, /cdn\.jsdelivr\.net/);
  assert.match(html, /id="live-status-badge"/);
  assert.match(html, /DWD ICON/);
  assert.match(html, /official warning context/i);
  assert.match(html, /Check official weather warnings/);
  assert.match(html, /data-layer="dry"/);
  assert.match(html, /data-layer="wet"/);
  assert.match(html, /data-detail="plain"/);
  assert.match(html, /data-detail="technical"/);
  assert.match(html, /id="signal-heading"/);
  assert.match(html, /id="plain-source-summary"/);
  assert.match(html, /id="provenance-list"/);
  assert.match(html, /hoch Wasser zentralen|hochwasserzentralen/i);
  assert.match(html, />Soil-water monitor</i);
  assert.match(html, /data-legend-label="low"/);
  assert.match(html, /id="field-context"/);
  assert.match(html, /data-audience="gardeners"/);
  assert.match(html, /id="garden-context"/);
  assert.match(html, /id="plant-profile"/);
  assert.match(html, /id="farm-goal"/);
  assert.match(html, /id="personalisation-summary"/);
  assert.match(html, /data-language="en"/);
  assert.match(html, /data-language="de"/);
  assert.match(script, /applyDocumentLanguage/);
  assert.match(results, /is-focused-action/);
  assert.match(html, /ICON ensemble mean/i);
  assert.match(html, /RADOLAN SF/i);
  assert.doesNotMatch(html, /data-layer="water"/);
  assert.doesNotMatch(html, /data-layer="drought"/);
});

test("scheduled/manual builds refresh data while normal pushes reuse saved data behind validation", async () => {
  const workflow = await readFile(new URL("../.github/workflows/pages.yml", import.meta.url), "utf8");
  assert.match(workflow, /schedule:/);
  assert.match(workflow, /npm run refresh-data/);
  assert.match(workflow, /run: npm test/);
  assert.match(workflow, /deploy:\s*\n\s*needs: build/);
  assert.match(workflow, /steps\.refresh\.outcome/);
  assert.match(workflow, /steps\.reuse\.outcome/);
  assert.match(workflow, /path: _site/);
  assert.match(workflow, /if: github\.event_name == 'schedule' \|\| github\.event_name == 'workflow_dispatch'/);
  assert.match(workflow, /if: github\.event_name == 'push'/);
  assert.match(workflow, /node scripts\/reuse-published-data\.mjs/);
  assert.match(workflow, /node scripts\/check-live-freshness\.mjs --saved/);
  assert.match(workflow, /node scripts\/build-heatlens-assets\.mjs/);
  assert.match(workflow, /node scripts\/assemble-site\.mjs/);
  assert.match(workflow, /pull_request:/);
  assert.match(workflow, /if: github\.event_name != 'pull_request' && github\.ref == 'refs\/heads\/main'/);
  assert.doesNotMatch(workflow, /continue-on-error/);
  assert.doesNotMatch(workflow, /path:\s*\.\s*$/m);
});

test("site dependency graph includes transitive HeatLens modules and GridScout static assets", async () => {
  const files = await collectSiteFiles();
  for (const expected of ["heatwave-model.js", "heatwave-state.js", "heatwave-warnings.js", "heatwave-language.js",
    "heatwave-language-de.js", "heatwave-i18n.js", "heatwave-controls.js", "heatwave-data.js", "heatwave-spatial.js", "heatwave-results.js",
    "watt-hackathon/index.html", "watt-hackathon/schedule.html",
    "watt-hackathon/artifacts/showcase_data.json", "watt-hackathon/artifacts/schedule_replay.json",
    "watt-hackathon/data/official/network_map.png"]) {
    assert.ok(files.includes(expected), `Missing published dependency ${expected}`);
  }
  assert.ok(files.every((file) => !/(?:^|\/)(?:node_modules|tests|docs|__pycache__)(?:\/|$)/.test(file)));
  assert.ok(files.every((file) => !/\.py$/.test(file)));
});

test("all local page assets and navigation targets exist", async () => {
  for (const page of ["../index.html", "../heatwave-demo.html"]) {
    const html = await readFile(new URL(page, import.meta.url), "utf8");
    const references = [...html.matchAll(/\b(?:href|src)="(\.\/[^"#?]+)[^\"]*"/g)].map((match) => match[1]);
    for (const reference of references) {
      await access(new URL(`../${reference.slice(2)}`, import.meta.url));
    }
  }
});
