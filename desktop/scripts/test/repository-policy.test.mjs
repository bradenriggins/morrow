import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

/**
 * The public repository tells a visitor how to report a security problem and how to ask for help
 * without putting student information or an unfixed flaw in a public issue. GitHub shows the root
 * SECURITY.md on the repository's Security tab, and the issue chooser shows the templates and
 * contact links under .github/ISSUE_TEMPLATE. The website's Security and Support pages are the
 * places these files send people. CI runs this file on every change (ci.yml `check-repository`).
 *
 * Failure mode pinned down (written before the fix; final sweep 2026-09-23): the repository had
 * Issues open and no security policy, no issue template, and no contact links, so a researcher who
 * started on GitHub could only open a public issue, and an educator asking for help had nothing
 * that told them to leave student names and screenshots out.
 */
const repositoryRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const read = (path) => readFileSync(join(repositoryRoot, path), "utf8");
const collapse = (value) => value.replace(/\s+/g, " ").trim();

const REPORT_ADDRESS = "hello@meetmorrow.app";
const SECURITY_PAGE = "https://meetmorrow.app/security";
const SUPPORT_PAGE = "https://meetmorrow.app/support";
const TEMPLATES = ".github/ISSUE_TEMPLATE";

test("the repository's security policy sends reports to email, not to a public issue", () => {
  assert.ok(existsSync(join(repositoryRoot, "SECURITY.md")), "the repository root must carry SECURITY.md");
  const policy = collapse(read("SECURITY.md"));
  assert.ok(policy.includes(`mailto:${REPORT_ADDRESS}`), `SECURITY.md must link ${REPORT_ADDRESS}`);
  assert.ok(policy.includes(SECURITY_PAGE), `SECURITY.md must link ${SECURITY_PAGE}, which states the response times`);
  assert.match(policy, /do not (?:open|report [^.]* in) a public (?:GitHub )?issue/i, "SECURITY.md must say not to report a security problem in a public issue");
  assert.match(policy, /do not include student information/i, "SECURITY.md must say not to include student information");
  assert.match(policy, /Morrow Desktop/, "SECURITY.md must name the products whose releases receive fixes");
  assert.match(policy, /Morrow for Muse/, "SECURITY.md must name the products whose releases receive fixes");
});

test("a new issue starts from a template, and the chooser links the Security and Support pages", () => {
  const config = read(`${TEMPLATES}/config.yml`);
  assert.match(config, /^blank_issues_enabled: false$/m, "a blank issue skips every warning, so the chooser must not offer one");
  const links = [...config.matchAll(/^\s+url: (\S+)$/gm)].map(([, url]) => url);
  assert.ok(links.includes(SECURITY_PAGE), `the issue chooser must link ${SECURITY_PAGE}`);
  assert.ok(links.includes(SUPPORT_PAGE), `the issue chooser must link ${SUPPORT_PAGE}`);
  assert.match(config, /student information/i, "the chooser's contact links must say to keep student information out");
});

test("every issue template keeps student information and security reports out of the issue", () => {
  const templates = readdirSync(join(repositoryRoot, TEMPLATES)).filter((name) => /\.(?:ya?ml|md)$/.test(name) && name !== "config.yml");
  assert.ok(templates.length > 0, `${TEMPLATES} must hold at least one issue template`);
  for (const name of templates) {
    const text = read(`${TEMPLATES}/${name}`);
    const flat = collapse(text);
    assert.match(flat, /student information/i, `${name} must warn against posting student information`);
    assert.ok(flat.includes(REPORT_ADDRESS), `${name} must send security reports to ${REPORT_ADDRESS}`);
    if (name.endsWith(".md")) continue;
    // An issue form can require the reporter to confirm the warning before the issue is created.
    assert.match(text, /- type: checkboxes[\s\S]*?student information[\s\S]*?required: true/i,
      `${name} must require the reporter to confirm that the issue holds no student information`);
  }
});
