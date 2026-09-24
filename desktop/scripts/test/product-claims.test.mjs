import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { RETIRED_PHRASES, findRetiredPhrases } from "./lib/retired-claims.mjs";

/**
 * The gate on Morrow's four claim documents. Each test compares a document against the source that
 * makes the claim true: the packages that ship, the files a link points at, the signal list the
 * course audit returns. This keeps a document from describing a Morrow that does not exist.
 *
 * Paths resolve from this file, so a scratch copy of the tree can be checked by copying this test
 * and `lib/retired-claims.mjs` into `<copy>/scripts/test/` and running the copy.
 */
const root = new URL("../../", import.meta.url);
const read = (relativePath) => readFileSync(new URL(relativePath, root), "utf8");
const present = (relativePath) => existsSync(new URL(relativePath, root));

const CLAIM_DOCS = ["README.md", "LIMITATIONS.md", "ARCHITECTURE.md", "docs/brand/MORROW-BRAND.md"];
const BLACKBOARD_PACKAGE = "packages/blackboard-learn-api/package.json";
const MOODLE_EXECUTOR = "connector/extension/src/moodle-executor.js";
const COURSE_AUDIT = "packages/mcp-server/src/course-audit.ts";

const collapse = (value) => value.replace(/\s+/g, " ").trim();

/** Sentences with their line numbers. A line break ends a sentence, so a list item stands alone. */
function sentences(text) {
  const found = [];
  let line = 1;
  let start = 0;
  const boundary = /[.!?]["”’')\]]*(?=\s|$)|\n/g;
  for (const match of text.matchAll(boundary)) {
    const end = match.index + match[0].length;
    const value = collapse(text.slice(start, end));
    if (value) found.push({ text: value, line });
    line += (text.slice(start, end).match(/\n/g) ?? []).length;
    start = end;
  }
  const tail = collapse(text.slice(start));
  if (tail) found.push({ text: tail, line });
  return found;
}

/** Heading sections, plus the text before the first heading as the document intro. */
function headingSections(text) {
  const found = [];
  const headings = [...text.matchAll(/^#{1,6} .*$/gm)];
  const intro = text.slice(0, headings.length > 0 ? headings[0].index : text.length);
  if (collapse(intro)) found.push({ heading: "(document intro)", line: 1, text: intro });
  for (const [index, heading] of headings.entries()) {
    const next = headings[index + 1];
    found.push({
      heading: collapse(heading[0]),
      line: text.slice(0, heading.index).split("\n").length,
      text: text.slice(heading.index, next ? next.index : text.length),
    });
  }
  return found;
}

/** Markdown heading anchors, slugged the way GitHub and most Markdown viewers slug them. */
function anchors(markdown) {
  return new Set(
    [...markdown.matchAll(/^#{1,6}\s+(.+?)\s*#*$/gm)].map(([, heading]) =>
      heading
        .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
        .replace(/[`*_]/g, "")
        .toLowerCase()
        .replace(/[^\p{L}\p{N} -]/gu, "")
        .trim()
        .replace(/\s+/g, "-"),
    ),
  );
}

test("the claim documents use none of the retired phrases", () => {
  const found = CLAIM_DOCS.flatMap((doc) =>
    findRetiredPhrases(read(doc)).map((hit) => `${doc}:${hit.line} "${hit.phrase}" in: ${hit.sentence}`),
  );
  assert.deepEqual(found, [], "these phrases are retired; scripts/test/lib/retired-claims.mjs says what each one got wrong");
});

// The dated working records under docs/implementation and docs/research quote retired wording to
// explain why it was retired. Every other Markdown or HTML page in the repository, including the
// root README, docs/ and Morrow for Muse, is product-facing and is held to the same list.
const INTERNAL_RECORDS = /^desktop\/docs\/(?:implementation|research)\//u;

test("no product-facing page anywhere in the repository uses a retired phrase", () => {
  const repositoryRoot = new URL("../", root);
  const listed = spawnSync("git", ["-C", fileURLToPath(repositoryRoot), "ls-files", "-z", "--", "*.md", "*.html"], { encoding: "utf8" });
  assert.equal(listed.status, 0, listed.stderr);
  const pages = listed.stdout.split("\0").filter((path) => path && !INTERNAL_RECORDS.test(path));
  for (const page of ["README.md", "docs/products.md", "docs/versioning.md", "desktop/README.md", "morrow-for-muse/SKILL.md", "morrow-for-muse/content/consent.md"]) {
    assert.ok(pages.includes(page), `the retired-phrase scan must read ${page}`);
  }
  const found = pages.flatMap((page) =>
    findRetiredPhrases(readFileSync(new URL(page, repositoryRoot), "utf8")).map((hit) => `${page}:${hit.line} "${hit.phrase}" in: ${hit.sentence}`),
  );
  assert.deepEqual(found, [], "these phrases are retired; scripts/test/lib/retired-claims.mjs says what each one got wrong");
});

// The desktop product's public name is Morrow Desktop, for Mac and Windows. "Morrow" alone is the
// family and the app's own name on the computer, so a version number needs the product it belongs
// to: Morrow Desktop, Morrow Bridge, or Morrow for Muse. Written before the fix (final sweep
// 2026-09-23): LIMITATIONS.md said "Morrow `1.0.5`", the website said "Morrow for Mac and Windows",
// and the existing release was titled "Morrow 1.0.4", so one product had three names.
test("every page that states a version names the Morrow product it belongs to", () => {
  const repositoryRoot = new URL("../", root);
  const listed = spawnSync("git", ["-C", fileURLToPath(repositoryRoot), "ls-files", "-z", "--", "*.md", "*.html"], { encoding: "utf8" });
  assert.equal(listed.status, 0, listed.stderr);
  const pages = listed.stdout.split("\0").filter((path) => path && !INTERNAL_RECORDS.test(path));
  const unnamed = pages.flatMap((page) => {
    const text = readFileSync(new URL(page, repositoryRoot), "utf8");
    return [...text.matchAll(/\bMorrow `?v?\d+\.\d+(?:\.\d+)?/g)]
      .map((match) => `${page}:${text.slice(0, match.index).split("\n").length} "${match[0]}"`);
  });
  assert.deepEqual(unnamed, [], "write Morrow Desktop, Morrow Bridge, or Morrow for Muse before a version number");

  const versioning = readFileSync(new URL("docs/versioning.md", repositoryRoot), "utf8");
  const titles = [...versioning.matchAll(/gh release create (\S+)\/vX\.Y\.Z [^`]*--title "([^"]+)"/g)].map(([, tag, title]) => `${tag}: ${title}`);
  assert.deepEqual(titles, ["desktop: Morrow Desktop X.Y.Z", "muse: Morrow for Muse X.Y.Z"], "each release title names its product");
});

// The root README and docs/products.md send readers to desktop/README.md for Morrow Desktop. Written
// before the fix (final sweep 2026-09-23): that page was titled "# Morrow" and never said "Morrow
// Desktop", pages called the product "the Morrow desktop app", and Morrow for Muse documents called
// it "the desktop Morrow".
test("the Morrow Desktop start page and every page that names the product call it Morrow Desktop", () => {
  const readme = read("README.md");
  assert.equal(readme.split("\n", 1)[0], "# Morrow Desktop", "desktop/README.md is titled with the product's name");
  const opening = readme.split(/\n{2,}/).find((paragraph) => !/^(?:#|\[!\[)/.test(paragraph)) || "";
  assert.match(opening, /^Morrow Desktop, the app for Mac and Windows, /, "desktop/README.md opens with the product's name");

  const repositoryRoot = new URL("../", root);
  const listed = spawnSync("git", ["-C", fileURLToPath(repositoryRoot), "ls-files", "-z", "--", "*.md", "*.html"], { encoding: "utf8" });
  assert.equal(listed.status, 0, listed.stderr);
  const pages = listed.stdout.split("\0").filter((path) => path && !INTERNAL_RECORDS.test(path));
  const misnamed = pages.flatMap((page) => {
    const text = readFileSync(new URL(page, repositoryRoot), "utf8");
    return [...text.matchAll(/\bMorrow\s+desktop\b|\b[Dd]esktop\s+Morrow\b/g)]
      .map((match) => `${page}:${text.slice(0, match.index).split("\n").length} "${collapse(match[0])}"`);
  });
  assert.deepEqual(misnamed, [], "the desktop product is Morrow Desktop");
});

// The newest section of CHANGELOG.md becomes the text of the GitHub release that
// meetmorrow.app/download links to (docs/versioning.md step 4), so educators read it. Technical items
// sit under a last "Technical notes" subsection; everything above it is in plain words.
// Written before the fix (final sweep 2026-09-23): the 1.0.5 notes opened with "adversarial audits
// after the 2026-09-22 handoff" and spoke of `required = true`, MSIX, an HTTP endpoint, CI,
// Dependabot, and preflight, mixed in with the changes an educator sees.
const RELEASE_NOTE_JARGON = /\b(?:adversarial|handoff|HTTP|endpoints?|MSIX|preflight|Dependabot|CI|TypeScript|Vitest|pnpm|workflows?|harness(?:es)?|fixtures?|runtime|MCP|tokens?|PowerShell|tenant|API)\b/gi;
const RELEASE_FILE = /^Morrow-\d+\.\d+\.\d+-(?:mac-arm64\.(?:dmg|zip)|win-x64\.exe)$/;

test("the newest release notes speak to educators, with technical notes last and apart", () => {
  const changelog = read("CHANGELOG.md");
  const heading = /^## \d+\.\d+\.\d+ \(\d{4}-\d\d-\d\d\)$/m.exec(changelog);
  assert.ok(heading, "CHANGELOG.md must open its newest release with a dated version heading");
  const next = changelog.indexOf("\n## ", heading.index + 1);
  const section = changelog.slice(heading.index, next === -1 ? changelog.length : next);
  const parts = section.split(/^(?=### )/m);
  const technical = parts.findIndex((part) => /^### Technical notes\n/.test(part));
  if (technical !== -1) assert.equal(technical, parts.length - 1, "Technical notes must be the last subsection");
  const problems = [];
  for (const part of technical === -1 ? parts : parts.slice(0, technical)) {
    for (const sentence of sentences(part)) {
      for (const [, code] of sentence.text.matchAll(/`([^`]+)`/g)) {
        if (!RELEASE_FILE.test(code)) problems.push(`code \`${code}\` in: ${sentence.text}`);
      }
      const words = [...sentence.text.replace(/`[^`]+`/g, "").matchAll(RELEASE_NOTE_JARGON)].map(([word]) => word);
      if (words.length > 0) problems.push(`${words.join(", ")} in: ${sentence.text}`);
    }
  }
  assert.deepEqual(problems, [], `${heading[0]}: say what the educator sees, or move the item under ### Technical notes`);
});

// Written before the fix (final sweep 2026-09-23): 1.0.5 replaced the assistant's Edit prompt with a
// review page that only a click in Chrome answers, and refused removals from a conversation. An
// educator who used 1.0.4 meets both, and the 1.0.5 notes said neither.
const APPROVAL_SERVER = "packages/mcp-server/src/approval-server.ts";
const EDIT_ACCESS_REVIEW = "packages/mcp-server/src/edit-access-review.ts";

test("the newest release notes say how Edit is turned on from a conversation", () => {
  const button = /<h1>Turn on Edit\?<\/h1>[\s\S]*?<button class="approve" type="submit">([^<]+)<\/button>/.exec(read(APPROVAL_SERVER))?.[1];
  assert.ok(button, `${APPROVAL_SERVER} must render the Edit access review's approve button`);
  const refusal = /export const DESTRUCTIVE_EDIT_REFUSAL = "([^"]+)";/.exec(read(EDIT_ACCESS_REVIEW))?.[1];
  assert.ok(refusal, `${EDIT_ACCESS_REVIEW} must export the removal refusal`);
  const changelog = read("CHANGELOG.md");
  const heading = /^## \d+\.\d+\.\d+ \(\d{4}-\d\d-\d\d\)$/m.exec(changelog);
  const next = changelog.indexOf("\n## ", heading.index + 1);
  const section = changelog.slice(heading.index, next === -1 ? changelog.length : next);
  const approvals = section.split(/^(?=### )/m).find((part) => part.startsWith("### Approvals and Edit access\n"));
  assert.ok(approvals, `${heading[0]} must keep its Approvals and Edit access subsection`);
  const bullet = collapse(approvals.split(/^- /m).find((item) => /\bassistant asks to turn on Edit\b/.test(item)) ?? "");
  assert.ok(bullet, `${heading[0]} must say what happens when your assistant asks to turn on Edit`);
  assert.ok(bullet.includes(`select ${button}`), `the notes must name the review page's ${button} button`);
  assert.match(bullet, /\bin Chrome\b/, "the notes must say the review opens in Chrome");
  assert.ok(bullet.includes(refusal), `the notes must say what Morrow answers for a removal: ${refusal}`);
});

test("the documented platform coverage matches the packages that ship", (t) => {
  if (present(BLACKBOARD_PACKAGE)) {
    for (const doc of ["ARCHITECTURE.md", "LIMITATIONS.md"]) {
      assert.match(read(doc), /Blackboard/, `${BLACKBOARD_PACKAGE} ships, so ${doc} must state the Blackboard route and its evidence`);
    }
  } else {
    t.diagnostic(`${BLACKBOARD_PACKAGE} is absent; the Blackboard coverage rule does not apply`);
  }

  if (present(MOODLE_EXECUTOR)) {
    assert.match(read("ARCHITECTURE.md"), /Moodle/, `${MOODLE_EXECUTOR} ships, so ARCHITECTURE.md must describe the Moodle route`);
  } else {
    t.diagnostic(`${MOODLE_EXECUTOR} is absent; the Moodle coverage rule does not apply`);
  }
});

test("every section that describes Blackboard says no live tenant has been tested", () => {
  // The qualifier is checked per section, not per sentence, because that is how the documents carry
  // it: `ARCHITECTURE.md` states it once for its Blackboard section and says it covers the section.
  const qualifier = /no live [^.]*tenant has been tested|no live tenant has run|no live-tenant evidence|live-untested|live-unverified|mocked-HTTPS/i;
  const unqualified = [];
  for (const doc of ["ARCHITECTURE.md", "LIMITATIONS.md"]) {
    for (const section of headingSections(read(doc))) {
      if (!/Blackboard/.test(section.text)) continue;
      if (qualifier.test(section.text)) continue;
      unqualified.push(`${doc}:${section.line} ${section.heading}`);
    }
  }
  assert.deepEqual(unqualified, [], "a section that describes Blackboard must state that no live Blackboard tenant has been tested");
});

test("no document claims a tested live Blackboard tenant", () => {
  const untested = /no live Blackboard tenant has been tested/i;
  // Only a claim that binds Blackboard to live evidence fails. The canonical platform sentence
  // names Canvas live proof and the untested Blackboard tenant together, and it must keep passing.
  const claimsLiveEvidence = [
    /(?<!\bno )\blive Blackboard tenant has been tested/i,
    /\bBlackboard\b[^.;]{0,80}\b(?:is|was|are|were|has been|have been)\s+(?:live[- ]?(?:tested|verified)|verified (?:on|against) a live|tested (?:on|against) a live|proved (?:on|against) a live)/i,
  ];
  const problems = [];
  for (const doc of CLAIM_DOCS) {
    const text = read(doc);
    if (!/Blackboard/.test(text)) continue;
    if (!untested.test(text)) {
      problems.push(`${doc} describes Blackboard without stating that no live Blackboard tenant has been tested`);
    }
    for (const sentence of sentences(text)) {
      for (const pattern of claimsLiveEvidence) {
        if (pattern.test(sentence.text)) problems.push(`${doc}:${sentence.line} ${sentence.text}`);
      }
    }
  }
  assert.deepEqual(problems, [], "the Blackboard route is proved against local mocked-HTTPS tests only");
});

// LIMITATIONS.md holds the technical platform sentence. The desktop README quotes it word for word;
// every other surface states its three facts in plain words, because the sentence's technical
// terms do not belong on educator pages. The repository's landing documents are checked here.
test("the platform sentence is quoted where LIMITATIONS.md says, and the landing documents state its facts plainly", () => {
  const limitations = read("LIMITATIONS.md");
  const section = limitations.slice(limitations.indexOf("## Platform coverage"), limitations.indexOf("\n## ", limitations.indexOf("## Platform coverage") + 1));
  const quoted = section.match(/^> (.+)$/m);
  assert.ok(quoted, "LIMITATIONS.md must keep the platform sentence as a quotation under Platform coverage");
  const sentence = collapse(quoted[1]);
  assert.ok(collapse(read("README.md")).includes(sentence), "README.md must quote the LIMITATIONS.md platform sentence word for word");
  assert.doesNotMatch(section, /(?:website|desktop app|extension)[^.]*quotes? it exactly/i,
    "only this document and the desktop README quote the sentence; other surfaces state its facts in plain words");

  const plainFacts = [
    [/\bCanvas\b[^.]*\b(?:live|real) test course/i, "selected Canvas tasks have live test-course proof"],
    [/\bMoodle\b[^.]*\bMoodle test course/i, "part of the Moodle catalog has been checked on a Moodle test course"],
    [/no live Blackboard site has been tested/i, "no live Blackboard site has been tested"],
  ];
  const problems = [];
  for (const doc of ["../README.md", "../docs/products.md"]) {
    const text = collapse(read(doc));
    for (const [fact, meaning] of plainFacts) if (!fact.test(text)) problems.push(`${doc} does not say that ${meaning}`);
    for (const term of ["Anthology Learn REST API", "tenant"]) if (text.includes(term)) problems.push(`${doc} uses the technical term "${term}"`);
  }
  assert.deepEqual(problems, []);
});

/** Markdown paragraphs with their first line. Each table row and list item stands alone; headings are skipped. */
function paragraphs(text) {
  const found = [];
  let current = null;
  for (const [index, line] of text.split("\n").entries()) {
    if (!line.trim() || /^#{1,6} /.test(line)) {
      current = null;
      continue;
    }
    if (current && !/^\s*(?:\||[-*+] |\d+\. )/.test(line)) {
      current.text += `\n${line}`;
      continue;
    }
    current = { line: index + 1, text: line };
    found.push(current);
  }
  return found.map((paragraph) => ({ ...paragraph, text: collapse(paragraph.text).replace(/’/g, "'") }));
}

// The attended live record, BT2-LIVE-PROOF.md, holds native Codex CLI runs on a live Canvas test
// course and says Gemini CLI could not run; every other assistant setup has only Morrow's own tests.
// A landing document that names an assistant states that status in the same paragraph, as the
// website does. Written before the fix (final sweep 2026-09-23): the root README said "connect
// ChatGPT, Claude, or Gemini" and docs/products.md listed all four assistants with no status.
const ASSISTANT_PROOF_RECORD = "docs/implementation/BT2-LIVE-PROOF.md";
const ASSISTANT_PROOF_STATUS = [
  "So far, only OpenAI's Codex CLI, which uses Morrow's ChatGPT setup, has been checked on a live Canvas test course.",
  "The ChatGPT desktop app, Claude Desktop, Claude Code, and Gemini CLI setups have passed Morrow's own tests only.",
];

test("every landing paragraph that names an assistant states each assistant's live proof status", () => {
  const record = read(ASSISTANT_PROOF_RECORD);
  assert.match(record, /\| Native Codex interactive update \|[^\n]*Codex CLI `\d+\.\d+\.\d+`/, `${ASSISTANT_PROOF_RECORD} no longer records the live Codex CLI run the status sentence rests on`);
  assert.match(record, /Gemini CLI could not run/, `${ASSISTANT_PROOF_RECORD} no longer records that Gemini CLI could not run`);

  const problems = [];
  for (const doc of ["../README.md", "../docs/products.md"]) {
    for (const paragraph of paragraphs(read(doc))) {
      if (!/\b(?:ChatGPT|Claude|Gemini|Codex)\b/.test(paragraph.text)) continue;
      const missing = ASSISTANT_PROOF_STATUS.filter((sentence) => !paragraph.text.includes(sentence));
      if (missing.length > 0) problems.push(`${doc.slice(3)}:${paragraph.line} names an assistant without: ${missing.join(" ")}`);
    }
  }
  assert.deepEqual(problems, [], `${ASSISTANT_PROOF_RECORD} is the record of which assistant ran on a live course`);
});

// Morrow Desktop opens only where its Electron build opens. installer/electron-builder.config.cjs
// sets no minimumSystemVersion, so the macOS floor is the LSMinimumSystemVersion in Electron's own
// Info.plist: 13.0 in electron-v44.4.3-darwin-arm64.zip. Electron 44's electron.exe declares
// Windows 10.0 as its minimum operating system. A new Electron major can raise either floor, so the
// pin names the major the floors were read from. Written before the fix (final sweep 2026-09-23):
// no repository document named a floor, while the website said macOS 13 or later.
const DESKTOP_FLOOR = { electronMajor: 44, mac: "macOS 13 or later", windows: "Windows 10 or Windows 11" };
const DESKTOP_FLOOR_STATEMENTS = [
  ["../README.md", /\bMac with Apple silicon\b/],
  ["../docs/products.md", /\bMac with Apple silicon\b/],
  ["README.md", /^The app is built for /],
  ["README.md", /^You need /],
  ["LIMITATIONS.md", /^- Morrow builds for /],
];

test("every document that says where Morrow Desktop runs states the macOS and Windows floors of its build", () => {
  const electron = JSON.parse(read("installer/package.json")).devDependencies.electron;
  assert.equal(Number(electron.split(".")[0]), DESKTOP_FLOOR.electronMajor,
    `installer/package.json pins Electron ${electron}: read LSMinimumSystemVersion from its Info.plist and the minimum operating system of its electron.exe, then update DESKTOP_FLOOR and the documents`);
  assert.doesNotMatch(read("installer/electron-builder.config.cjs"), /minimumSystemVersion/,
    "the documents take the macOS floor from Electron's Info.plist; a build that sets its own floor must state that one");

  const problems = [];
  for (const [doc, where] of DESKTOP_FLOOR_STATEMENTS) {
    const found = paragraphs(read(doc)).filter((paragraph) => where.test(paragraph.text));
    if (found.length === 0) problems.push(`${doc} has no paragraph matching ${where}`);
    for (const paragraph of found) {
      const missing = [DESKTOP_FLOOR.mac, DESKTOP_FLOOR.windows].filter((floor) => !paragraph.text.includes(floor));
      if (missing.length > 0) problems.push(`${doc}:${paragraph.line} says where Morrow Desktop runs without: ${missing.join(", ")}`);
    }
  }
  assert.deepEqual(problems, [], "an educator on an older macOS or Windows must learn it before downloading");
});

test("every repo-relative link in the claim documents resolves", () => {
  const broken = [];
  for (const doc of CLAIM_DOCS) {
    const text = read(doc);
    const docDirectory = new URL(doc, root);
    for (const match of text.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
      const target = match[1];
      if (/^(https?:|mailto:|tel:|data:)/i.test(target)) continue;
      const line = text.slice(0, match.index).split("\n").length;
      const [path, fragment] = target.split("#");
      const file = path === "" ? new URL(doc, root) : new URL(decodeURI(path), docDirectory);
      if (!existsSync(file)) {
        broken.push(`${doc}:${line} -> ${target} (no such file)`);
        continue;
      }
      if (!fragment || !file.pathname.endsWith(".md")) continue;
      if (!anchors(readFileSync(file, "utf8")).has(fragment.toLowerCase())) {
        broken.push(`${doc}:${line} -> ${target} (no such heading)`);
      }
    }
  }
  assert.deepEqual(broken, [], "a link in a claim document points at a file or heading that does not exist");
});

test("the course audit guidance names exactly the signals the audit returns", () => {
  const source = read(COURSE_AUDIT);
  const declared = source.match(/export const COURSE_AUDIT_SOURCE_SIGNAL_NAMES = \[([\s\S]*?)\] as const;/);
  assert.ok(declared, `${COURSE_AUDIT} must export COURSE_AUDIT_SOURCE_SIGNAL_NAMES; the claim gate reads it as the authority`);
  const signals = [...declared[1].matchAll(/"([a-z0-9_]+)"/g)].map(([, name]) => name);
  assert.ok(signals.length > 0, `${COURSE_AUDIT} declares no source signals`);

  const listed = source.match(/observed_source_signals\\`:([\s\S]*?)\\`\./);
  assert.ok(listed, `${COURSE_AUDIT} guidance must list the signals it returns under observed_source_signals`);
  const named = [...listed[1].matchAll(/\\`([a-z0-9_]+)/g)].map(([, name]) => name);
  assert.deepEqual(named, signals, `${COURSE_AUDIT} guidance names a different signal set than the audit returns`);

  const guidance = source.slice(source.indexOf("## Accessibility work"));
  assert.match(guidance, /needs human review/, `${COURSE_AUDIT} must keep the human-review limit on every signal`);
  assert.match(guidance, /does not establish[^.]*conformance/i, `${COURSE_AUDIT} must keep the no-conformance limit`);
});

test("no claim document widens what the course audit detects", () => {
  const source = read(COURSE_AUDIT);
  const signals = [...source.match(/export const COURSE_AUDIT_SOURCE_SIGNAL_NAMES = \[([\s\S]*?)\] as const;/)[1].matchAll(/"([a-z0-9_]+)"/g)].map(([, name]) => name);
  const signalSet = new Set(signals);

  const detection = /\b(detect|detects|detected|find|finds|report|reports|return|returns|list|lists|scan|scans|show|shows)\b/i;
  const auditSubject = /\b(audit|audits|signal|signals)\b/i;
  const limit = /\b(signal|signals|limited|saved|human review|not a violation)\b|does not establish/i;
  const partial = /\b(for example|such as|among|including|one of)\b/i;
  const identifier = /`([a-z][a-z0-9]*(?:_[a-z0-9]+)+)`/g;
  const toolName = /^(morrow|canvas|moodle|blackboard)_/;
  const conformance = /\b(conformance|conformant|compliance|compliant)\b/i;
  const negated = /\b(no|not|never|cannot|without|neither|nor)\b/i;

  const problems = [];
  for (const doc of CLAIM_DOCS) {
    for (const sentence of sentences(read(doc))) {
      const where = `${doc}:${sentence.line}`;
      if (conformance.test(sentence.text) && !negated.test(sentence.text)) {
        problems.push(`${where} claims conformance: ${sentence.text}`);
      }
      if (!detection.test(sentence.text) || !auditSubject.test(sentence.text)) continue;
      if (!limit.test(sentence.text)) {
        problems.push(`${where} states what the audit detects without its saved-source signal limit: ${sentence.text}`);
      }
      const namedIdentifiers = [...sentence.text.matchAll(identifier)]
        .map(([, name]) => name)
        .filter((name) => !toolName.test(name));
      const unknown = namedIdentifiers.filter((name) => !signalSet.has(name));
      if (unknown.length > 0) {
        problems.push(`${where} names signals the audit does not return: ${unknown.join(", ")}`);
      }
      const namedSignals = namedIdentifiers.filter((name) => signalSet.has(name));
      if (namedSignals.length > 0 && !partial.test(sentence.text)) {
        const missing = signals.filter((name) => !namedSignals.includes(name));
        if (missing.length > 0) {
          problems.push(`${where} names part of the signal set as if it were all of it; missing: ${missing.join(", ")}`);
        }
      }
    }
  }
  assert.deepEqual(problems, [], `${COURSE_AUDIT} is the authority for what the audit detects`);
});

const CANVAS_CATALOG = "connector/extension/generated/canvas-api-catalog.json";
const EDIT_POLICY = "connector/extension/src/edit-policy.js";
const ITEM_BANK_COVERAGE = "docs/implementation/NEW-QUIZZES-ITEM-BANKS-COVERAGE.md";
const PROOF_HARNESS_LEDGER = "proof-harness/ledger.json";
const ITEM_BANK_FAN_OUT = "packages/mcp-server/src/item-bank-fan-out.ts";

const NUMBER_WORDS = [
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve",
  "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty",
];
const numberValue = (word) => (/^\d+$/.test(word) ? Number(word) : NUMBER_WORDS.indexOf(word.toLowerCase()));

const itemBankOperations = () => JSON.parse(read(CANVAS_CATALOG)).operations
  .filter((operation) => operation.family === "new-quizzes-item-banks");

/** The lines of a text that talk about Item Banks: a Markdown paragraph or list item, or one line of source. */
const itemBankUnits = (text) => text.split("\n").filter((line) => /Item Banks?\b/.test(line));

test("the claim documents count the Item Bank reads and changes the catalog carries", () => {
  const operations = itemBankOperations();
  const reads = operations.filter((operation) => operation.readOnly === true).length;
  const changes = operations.length - reads;
  const problems = [];
  for (const doc of CLAIM_DOCS) {
    for (const match of read(doc).matchAll(/\b([A-Za-z]+|\d+) (?:Item Bank )?reads and ([A-Za-z]+|\d+) (?:course-bound|owner-write)\b/g)) {
      if (numberValue(match[1]) !== reads || numberValue(match[2]) !== changes) {
        problems.push(`${doc}: "${match[0]}", but the catalog carries ${reads} reads and ${changes} changes`);
      }
    }
  }
  assert.deepEqual(problems, [], `${CANVAS_CATALOG} is the authority for the Item Bank operation counts`);
});

test("the README counts the Item Bank changes the Edit policy offers and the ones it keeps change by change", async () => {
  const { categoriesForBinding } = await import(new URL(EDIT_POLICY, root).href);
  const operations = JSON.parse(read(CANVAS_CATALOG)).operations.map((operation) => ({ ...operation, provider: "canvas" }));
  const bank = categoriesForBinding({ provider: "canvas", courseId: "42" }, operations)
    .filter((category) => category.id.startsWith("action:canvas:canvas_item_bank_"));
  const edit = bank.filter((category) => category.availability === "edit").length;
  const review = bank.filter((category) => category.availability === "review").length;
  const paragraph = itemBankUnits(read("README.md")).find((line) => /standing Edit grant/.test(line)) || "";
  const standing = paragraph.match(/\b([A-Za-z]+|\d+) of (?:them|the [A-Za-z]+ changes) can hold a standing Edit grant/);
  const oneByOne = paragraph.match(/\b([A-Za-z]+|\d+) (?:of them )?are approved change by change/);
  assert.ok(standing && oneByOne, "README.md must state how many Item Bank changes can hold a standing Edit grant and how many are approved change by change");
  assert.deepEqual([numberValue(standing[1]), numberValue(oneByOne[1])], [edit, review],
    `${EDIT_POLICY} offers ${edit} Item Bank changes for Edit and keeps ${review} change by change`);
});

test("the Item Bank live status follows the attended record, never the proof harness", () => {
  const coverage = read(ITEM_BANK_COVERAGE);
  const start = coverage.indexOf("\n## Item Banks");
  const table = coverage.slice(start, coverage.indexOf("\n## ", start + 1));
  assert.ok([...table.matchAll(/\| proven \|\s*$/gm)].length > 0, `${ITEM_BANK_COVERAGE} records no Item Bank task proven live`);
  const harness = Object.values(JSON.parse(read(PROOF_HARNESS_LEDGER)).rows);
  const harnessProvedAChange = harness.some((row) => String(row.id).startsWith("canvas_item_bank_") && row.kind === "write" && row.verdict === "PASS");

  const unproven = /live-unverified|live-untested|no (?:connected|Morrow-connected) Canvas tenant has (?:proved|answered)|no retained live Canvas receipt/i;
  const aboutTheRoutes = /Item Banks?\b|private (?:route|operation)s?|frame contract/i;
  const problems = [];
  for (const file of [...CLAIM_DOCS, COURSE_AUDIT, ITEM_BANK_FAN_OUT]) {
    for (const unit of itemBankUnits(read(file))) {
      for (const sentence of sentences(unit)) {
        if (unproven.test(sentence.text) && aboutTheRoutes.test(sentence.text)) {
          problems.push(`${file} calls the Item Bank routes unproven: ${sentence.text}`);
        }
        if (!harnessProvedAChange && sentence.text.includes(PROOF_HARNESS_LEDGER)) {
          problems.push(`${file} cites ${PROOF_HARNESS_LEDGER} for Item Banks, where no Item Bank change ran: ${sentence.text}`);
        }
      }
    }
  }
  for (const doc of ["README.md", "LIMITATIONS.md"]) {
    if (!itemBankUnits(read(doc)).some((line) => line.includes("NEW-QUIZZES-ITEM-BANKS-COVERAGE.md"))) {
      problems.push(`${doc} states the Item Bank live status without citing ${ITEM_BANK_COVERAGE}`);
    }
  }
  assert.deepEqual(problems, [], `${ITEM_BANK_COVERAGE} is the attended record of what Item Banks proved live`);
});

test("the New Quiz question and settings limits follow the attended record", () => {
  const coverage = read(ITEM_BANK_COVERAGE);
  const provenRow = (task) => coverage.split("\n").some((line) => line.startsWith(`| ${task}`) && /\| proven \|\s*$/.test(line));
  const neverRun = /none of these three has run against a live Canvas course/i;
  const claims = [
    { task: "Create each of the 12 question types", stale: neverRun },
    { task: "Change a question's type", stale: neverRun },
    { task: "Delete a question", stale: neverRun },
    {
      task: "Edit points, answer choices (add and remove)",
      stale: /would add, remove, rename, or duplicate any provider interaction UUID|has not verified the provider's handling of newly generated interaction UUIDs/i,
    },
    { task: "Settings: shuffle questions, time limit", stale: /every documented setting combination is live-unverified/i },
  ];
  const limitations = collapse(read("LIMITATIONS.md"));
  const problems = claims
    .filter(({ task, stale }) => provenRow(task) && stale.test(limitations))
    .map(({ task, stale }) => `LIMITATIONS.md says ${stale} although ${ITEM_BANK_COVERAGE} marks "${task}" proven`);
  assert.deepEqual(problems, []);
});

// Written before the fix (final sweep 2026-09-23): the README said the quiz check covers only
// directly listed questions and choice-based answer settings, does not judge bank contents, and
// marks every bank draw incomplete. The check reads the bank behind each draw, checks every
// question type, and marks a bank incomplete only when it cannot read it in full.
const QUIZ_CHECK = "packages/mcp-server/src/quiz-check.ts";
const QUIZ_ITEM_PAYLOAD = "packages/mcp-server/src/quiz-item-payload.ts";

test("the README's quiz check says what the quiz check reads and checks", () => {
  const source = read(QUIZ_CHECK);
  const bound = (name) => {
    const value = new RegExp(`^const ${name} = ([0-9_]+);$`, "m").exec(source)?.[1];
    assert.ok(value, `${QUIZ_CHECK} must declare ${name}`);
    return Number(value.replaceAll("_", ""));
  };
  const types = Number(/cover all (\d+) question types/.exec(source)?.[1]);
  const algorithms = /const CREATE_ALGORITHMS[^{]*\{([\s\S]*?)\}\);/.exec(read(QUIZ_ITEM_PAYLOAD))?.[1] ?? "";
  assert.equal([...algorithms.matchAll(/^\s+"?[a-z-]+"?: \[/gm)].length, types,
    `${QUIZ_CHECK} must name the question types ${QUIZ_ITEM_PAYLOAD} checks`);
  assert.match(source, /Morrow reads that bank to check the questions it can supply/, `${QUIZ_CHECK} must keep its bank-draw limit`);

  const readme = read("README.md");
  const start = readme.indexOf("\n## Check a New Quiz");
  assert.notEqual(start, -1, "README.md must keep its Check a New Quiz section");
  const section = collapse(readme.slice(start, readme.indexOf("\n## ", start + 1)));
  for (const stale of [/directly listed/, /choice-based/, /bank contents/, /bank draws are marked incomplete/i]) {
    assert.doesNotMatch(section, stale, "README.md must describe the quiz check the code runs");
  }
  assert.ok(section.includes(`all ${types} question types`), `README.md must say the check covers all ${types} question types`);
  assert.ok(section.includes(`up to ${bound("MAX_BANKS")} Item Banks for each quiz`), "README.md must state the bank limit per quiz");
  assert.ok(section.includes(`${bound("MAX_BANK_ITEM_READS")} bank questions in one check`), "README.md must state the bank question limit per check");
  assert.match(section, /A bank Morrow cannot read in full is marked incomplete/);

  const proven = read(ITEM_BANK_COVERAGE).split("\n")
    .some((line) => line.startsWith("| Check a quiz's saved state") && /\| proven \|\s*$/.test(line));
  if (proven) {
    assert.doesNotMatch(section, /Live Canvas verification is still required/, `${ITEM_BANK_COVERAGE} marks the quiz check proven`);
    assert.ok(section.includes("NEW-QUIZZES-ITEM-BANKS-COVERAGE.md"), `README.md must cite ${ITEM_BANK_COVERAGE} for the quiz check's live status`);
  }
});
