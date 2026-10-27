import { copyFile, lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { MODEL_VERSION } from "../heatwave-model.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WATT_STATIC_EXTENSIONS = new Set([
  ".html", ".css", ".js", ".json", ".geojson", ".svg", ".png", ".jpg", ".jpeg", ".webp", ".gif", ".ico",
  ".csv", ".txt", ".woff", ".woff2", ".ttf", ".pdf", ".mp4", ".webm"
]);
const EXCLUDED = new Set(["node_modules", "__pycache__", "tests", "test", "docs", ".cache", ".venv", ".git"]);
const slash = (value) => value.split(sep).join("/");

function localReference(reference) {
  return reference && !/^(?:[a-z][a-z\d+.-]*:|\/\/|#|\/)/i.test(reference);
}

function htmlReferences(source) {
  const refs = [];
  // Embedded JSON and inline scripts can contain HTML strings or fallback URLs
  // that are not document dependencies. Only inspect real opening-tag attrs.
  const markup = source.replace(/(<script\b[^>]*>)[\s\S]*?<\/script\s*>/gi, "$1</script>");
  for (const tag of markup.matchAll(/<(?:a|link|script|img|source|iframe|video|audio|embed|object)\b[^>]*>/gi)) {
    for (const match of tag[0].matchAll(/\b(?:href|src|poster|data)\s*=\s*["']([^"']+)["']/gi)) refs.push(match[1]);
    for (const match of tag[0].matchAll(/\bsrcset\s*=\s*["']([^"']+)["']/gi)) {
      if (!match[1].startsWith("data:")) refs.push(...match[1].split(",").map((item) => item.trim().split(/\s+/)[0]));
    }
  }
  return refs;
}

function codeReferences(source, extension) {
  if (extension === ".html") return htmlReferences(source);
  if (extension === ".css") return [
    ...source.matchAll(/url\(\s*["']?([^\s"')]+)["']?\s*\)/g),
    ...source.matchAll(/@import\s+["']([^"']+)["']/g)
  ].map((match) => match[1]);
  if (extension !== ".js" && extension !== ".mjs") return [];
  return [
    ...source.matchAll(/(?:^|[;\r\n])\s*import\s*(?:[^;"']*?\bfrom\s*)?["']([^"']+)["']/g),
    ...source.matchAll(/\bexport\s*(?:\{[^}]*\}|\*(?:\s+as\s+[\w$]+)?)\s*from\s*["']([^"']+)["']/g),
    ...source.matchAll(/\bimport\s*\(\s*["']([^"']+)["']/g),
    ...source.matchAll(/\bnew\s+URL\s*\(\s*["']([^"']+)["']\s*,\s*import\.meta\.url/g),
    ...source.matchAll(/\bfetch\s*\(\s*["']([^"']+)["']/g)
  ].map((match) => match[1]);
}

function inside(root, path) {
  const rel = relative(root, path);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

async function staticFiles(root, path, { optional = false, watt = false } = {}) {
  let entries;
  try {
    entries = await readdir(path, { withFileTypes: true });
  } catch (error) {
    if (optional && error.code === "ENOENT") return [];
    throw error;
  }
  const files = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".") || EXCLUDED.has(entry.name) || watt && /^requirements.*\.txt$/i.test(entry.name)) continue;
    const full = resolve(path, entry.name);
    if (!inside(root, full)) throw new Error(`Static path escapes source root: ${full}`);
    if (entry.isSymbolicLink()) throw new Error(`Static assets must not be symbolic links: ${full}`);
    if (entry.isDirectory()) files.push(...await staticFiles(root, full, { watt }));
    else if (entry.isFile() && (!watt || WATT_STATIC_EXTENSIONS.has(extname(entry.name).toLowerCase()))) files.push(full);
  }
  return files;
}

export async function collectSiteFiles(root = ROOT) {
  root = resolve(root);
  const required = [".nojekyll", "index.html", "heatwave-demo.html", "LICENSE", "THIRD_PARTY_NOTICES.md"];
  const candidates = [
    ...required.map((path) => resolve(root, path)),
    ...await staticFiles(root, resolve(root, "assets")),
    ...await staticFiles(root, resolve(root, "vendor")),
    ...await staticFiles(root, resolve(root, "watt-hackathon"), { optional: true, watt: true })
  ];
  const files = new Set();
  const visit = async (path, parent = "site entry") => {
    path = resolve(path);
    if (!inside(root, path)) throw new Error(`Dependency escapes source root: ${parent} → ${path}`);
    if (files.has(path)) return;
    let info;
    try { info = await lstat(path); } catch { throw new Error(`Missing site dependency: ${parent} → ${slash(relative(root, path))}`); }
    if (info.isSymbolicLink() || !info.isFile()) throw new Error(`Site dependency must be a regular file: ${path}`);
    files.add(path);
    const extension = extname(path).toLowerCase();
    if (![".html", ".css", ".js", ".mjs"].includes(extension)) return;
    for (const reference of codeReferences(await readFile(path, "utf8"), extension)) {
      if (!localReference(reference)) continue;
      const withoutQuery = reference.split(/[?#]/)[0];
      if (!withoutQuery) continue;
      let decoded;
      try { decoded = decodeURIComponent(withoutQuery); } catch { throw new Error(`Invalid encoded dependency in ${path}: ${reference}`); }
      let dependency = resolve(dirname(path), decoded);
      if (decoded.endsWith("/")) dependency = resolve(dependency, "index.html");
      await visit(dependency, slash(relative(root, path)));
    }
  };
  for (const path of candidates) await visit(path);
  return [...files].map((path) => slash(relative(root, path))).sort();
}

function gitRevision(root) {
  try { return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
  catch { return "local-unversioned"; }
}

export async function assembleSite({ root = ROOT, outputDir, commit = process.env.GITHUB_SHA, now = Date.now() } = {}) {
  root = resolve(root);
  outputDir = resolve(outputDir || resolve(root, "_site"));
  const targetRelative = relative(root, outputDir);
  if (!targetRelative || !inside(root, outputDir) || ["assets", "vendor", "watt-hackathon", "scripts", "tests"].includes(targetRelative.split(sep)[0])) {
    throw new Error("Site output must be a dedicated directory inside the source root");
  }
  // Validate the complete dependency graph before replacing a prior artifact.
  const files = await collectSiteFiles(root);
  const manifest = JSON.parse(await readFile(resolve(root, "assets/live/manifest.json"), "utf8"));
  const forecast = JSON.parse(await readFile(resolve(root, "assets/live/forecast.json"), "utf8"));
  const snapshotId = manifest.snapshotId ?? manifest.id ?? manifest.version;
  if (!snapshotId || manifest.generatedAt !== forecast.generatedAt) throw new Error("Site manifest and forecast must describe the same snapshot");
  if (typeof snapshotId !== "string" || !/^[a-z\d][a-z\d._-]*$/i.test(snapshotId)) throw new Error("Invalid immutable snapshot identifier");
  const liveRoot = resolve(root, "assets/live");
  const snapshotRoot = resolve(liveRoot, "snapshots", String(snapshotId));
  const parts = [manifest.overview, ...Object.values(manifest.states || {})];
  if (!manifest.overview || !parts.length) throw new Error("Site manifest must include overview data");
  for (const part of parts) {
    if (!part?.url || !localReference(part.url)) throw new Error("Snapshot assets must use local versioned URLs");
    const path = resolve(liveRoot, part.url);
    if (!inside(snapshotRoot, path)) throw new Error(`Snapshot asset is outside its immutable version: ${part.url}`);
    const bytes = await readFile(path);
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (part.sha256 !== digest || part.bytes !== bytes.length) throw new Error(`Snapshot asset does not match manifest: ${part.url}`);
  }
  const buildInfo = {
    schema: "heatlens-site-build/v1", builtAt: new Date(now).toISOString(),
    commit: commit || gitRevision(root), modelVersion: manifest.modelVersion || MODEL_VERSION,
    snapshotId, snapshotGeneratedAt: forecast.generatedAt,
    publicationMode: "unknown", savedDataFreshness: null
  };
  try {
    const report = JSON.parse(await readFile(resolve(root, "artifacts/publication-status.json"), "utf8"));
    buildInfo.publicationMode = report.mode || "live";
    buildInfo.savedDataFreshness = report.freshnessStatus ?? null;
  } catch { /* Local previews may be assembled without a publication report. */ }
  // The resolved output has been checked to stay inside the task source root,
  // outside all input directories, before this recursive replacement.
  let outputAncestor = root;
  for (const part of targetRelative.split(sep)) {
    outputAncestor = resolve(outputAncestor, part);
    try {
      if ((await lstat(outputAncestor)).isSymbolicLink()) throw new Error("Site output cannot pass through a symbolic link");
    } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  await rm(outputDir, { recursive: true, force: true });
  for (const path of files) {
    const destination = resolve(outputDir, path);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(resolve(root, path), destination);
  }
  await writeFile(resolve(outputDir, "build-info.json"), `${JSON.stringify(buildInfo, null, 2)}\n`);
  await writeFile(resolve(outputDir, "site-files.json"), `${JSON.stringify({ schema: "heatlens-site-files/v1", files: [...files, "build-info.json", "site-files.json"] }, null, 2)}\n`);
  return { outputDir, files, buildInfo };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = await assembleSite();
  console.log(`Assembled ${result.files.length} static files for ${result.buildInfo.snapshotId}; commit ${result.buildInfo.commit}.`);
}
