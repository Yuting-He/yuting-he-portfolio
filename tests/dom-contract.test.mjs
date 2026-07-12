import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { access } from "node:fs/promises";

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

test("interactive page uses bundled map libraries and exposes scenario status", async () => {
  const html = await readFile(new URL("../heatwave-demo.html", import.meta.url), "utf8");
  assert.match(html, /\.\/vendor\/d3\.min\.js/);
  assert.match(html, /\.\/vendor\/topojson-client\.min\.js/);
  assert.doesNotMatch(html, /cdn\.jsdelivr\.net/);
  assert.match(html, /Static research scenario/);
  assert.match(html, /Check official DWD warnings/);
});

test("GitHub Pages deployment is gated by the automated test job", async () => {
  const workflow = await readFile(new URL("../.github/workflows/pages.yml", import.meta.url), "utf8");
  assert.match(workflow, /run: npm test/);
  assert.match(workflow, /deploy:\s*\n\s*needs: test/);
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
