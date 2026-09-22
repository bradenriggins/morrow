// The client side of one Morrow connection: reads that resolve a large result through its
// artifact handle, changes that go through the same approval page a person sees, and a log.
// Ported from the live BT2 sweep that proved these paths, so the harness keeps the machinery
// that already worked instead of a second copy that has to be proven again.
import { execFile } from "node:child_process";
import { appendFile } from "node:fs/promises";
import { promisify } from "node:util";
import { SOURCE_BINDING as SB } from "../connect.mjs";

/** How long one change waits for the person to approve it in Chrome. */
const APPROVAL_WAIT_MS = Number(process.env.MORROW_PROOF_APPROVAL_WAIT_MS) || 10 * 60_000;

/** Opens a review in the Chrome where Morrow Bridge is paired. Elsewhere the person opens the logged link. */
async function openInChrome(url) {
  if (process.platform !== "darwin") return;
  await promisify(execFile)("open", ["-a", process.env.MORROW_PROOF_BROWSER || "Google Chrome", url]).catch(() => undefined);
}

export function makeTools(client, logPath) {
  const log = async (text) => { const line = `${new Date().toISOString()} ${text}\n`; process.stdout.write(line); if (logPath) await appendFile(logPath, line).catch(() => {}); };

  async function resolveArtifact(result) {
    let value = result;
    while (value?.structuredContent?.schema === "morrow.result-artifact.v1") {
      const artifact = value.structuredContent;
      let text = ""; let offset = 0;
      for (;;) {
        const page = (await client.callTool({ name: "morrow_result_page", arguments: { handle: artifact.handle, offset, limit: 16000 } }, { timeout: 60000 })).structuredContent;
        text += page.text;
        if (page.nextOffset === null) break;
        offset = page.nextOffset;
      }
      value = JSON.parse(text);
    }
    return value;
  }

  const callTool = async (name, args, timeout = 240000) => resolveArtifact(await client.callTool({ name, arguments: args }, { timeout }));

  // Morrow accepts an approval only from a person's click on the review page in Chrome, signed by
  // the paired Morrow Bridge. A program that posts the page's form itself is refused, and this
  // harness is such a program, so it opens the review in Chrome and waits for the person's decision.
  // The page is read first only to report a review that offers no approval at all.
  async function approve(approvalUrl, operationId) {
    // Morrow offers the Approve control only once it has named everything the change addresses,
    // and naming it is a fresh Canvas read that can take a few seconds. A person would open the
    // page again; giving up on the first load reports a change as withheld that was only not
    // ready yet.
    let page; let body = "";
    for (let load = 0; load < 5; load += 1) {
      page = await fetch(approvalUrl);
      body = await page.text();
      if (/<form method="post" action="[^"]*\/approve"/.test(body)) break;
      await new Promise((resolve) => setTimeout(resolve, 4000));
    }
    if (!/<form method="post" action="[^"]*\/approve"/.test(body)) {
      const shown = body.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
      const sentence = /(Morrow [^.]{10,200}\.)/.exec(shown)?.[1] || "";
      const error = new Error(`approval_withheld:http_${page?.status ?? 0}`);
      error.approvalWithheld = { reason: `http_${page?.status ?? 0}`, sentence };
      throw error;
    }
    await openInChrome(approvalUrl);
    await log(`approve in Chrome: ${approvalUrl}`);
    const deadline = Date.now() + APPROVAL_WAIT_MS;
    while (Date.now() < deadline) {
      const record = (await callTool("morrow_operation_get", { operation_id: operationId }, 60000))?.structuredContent ?? {};
      if (record.state && record.state !== "awaiting_approval" && record.state !== "planned") return;
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    const error = new Error("approval_withheld:approval_not_given");
    error.approvalWithheld = { reason: "approval_not_given", sentence: `No approval was given in Chrome within ${Math.round(APPROVAL_WAIT_MS / 1000)} seconds.` };
    throw error;
  }

  /** Reads one artifact handle Morrow returns in place of a large result. */
  async function readArtifact(artifact) {
    let text = ""; let offset = 0;
    for (;;) {
      const page = (await client.callTool({ name: "morrow_result_page", arguments: { handle: artifact.handle, offset, limit: 16000 } }, { timeout: 60000 })).structuredContent;
      text += page.text;
      if (page.nextOffset === null) break;
      offset = page.nextOffset;
    }
    return JSON.parse(text);
  }

  /** Reads one Canvas capability through the verified course connection. */
  async function read(name, args = {}) {
    const value = await callTool("morrow_capability_read", { name, arguments: { ...args, _morrow: { source_binding_id: SB } } });
    const structured = value?.structuredContent ?? {};
    // A large listing comes back as a handle in place of the records, so it is
    // paged here and read as the listing it stands for.
    const paged = structured.data?.schema === "morrow.result-artifact.v1" ? await readArtifact(structured.data) : structured.data;
    // A paged result carries the whole tool answer, so the records are read from
    // the result it holds rather than from the page wrapper.
    const held = paged?.structuredContent ?? paged;
    // A refusal states its code at the envelope root; a provider failure states
    // it inside the held result. Both are the reason this read did not answer.
    return {
      ok: structured.status === "succeeded",
      code: held?.code ?? structured.code ?? null,
      reason: structured.reason ?? held?.reason ?? null,
      data: held?.result?.data ?? held?.data ?? held,
      raw: structured,
    };
  }

  /** Plans one change, approves it on Morrow's page, and waits for the saved result. */
  /**
   * Morrow's own planners are top-level controls rather than catalog capabilities, so they are
   * asked for by name. What they hand back is approved and followed exactly like any other change.
   */
  async function plan(label, name, args) {
    // A planner answers in one of two ways: as one change already awaiting approval, or as the
    // list of operations it would run. Both are how the change is made, so both are followed.
    const asked = await callTool(name, { source_binding_id: SB, ...args });
    const report = asked?.structuredContent ?? {};
    if (report.status === "awaiting_approval" && report.receipts?.approvalUrl) {
      return await change(label, name, args, { direct: true });
    }
    if (report.status === "planned" && Array.isArray(report.operations) && report.operations.length > 0) {
      const steps = [];
      for (const operation of report.operations) {
        const step = await change(`${label}.step${operation.step ?? steps.length + 1}`, operation.tool, operation.arguments || {});
        steps.push(step);
        if (!["verified", "sent_unchecked"].includes(String(step.outcome))) break;
      }
      const last = steps.at(-1) ?? {};
      return { label, tool: name, outcome: last.outcome ?? "not_planned", steps: steps.length,
        ...(last.operationId ? { operationId: last.operationId } : {}) };
    }
    if (report.status === "verified") return { label, tool: name, outcome: "verified" };
    await log(`${label}: not_planned ${report.status ?? "no status"} ${(asked?.content?.[0]?.text || "").slice(0, 120)}`);
    return { label, tool: name, outcome: "not_planned", plan: { status: report.status ?? null } };
  }

  async function change(label, name, args, { operationId, direct = false } = {}) {
    const entry = { label, tool: name, at: new Date().toISOString() };
    try {
      const planned = direct
        ? await callTool(name, { source_binding_id: SB, ...args })
        : await callTool("morrow_capability_change", { name, arguments: { ...args, _morrow: { source_binding_id: SB, operation_id: operationId || `${label}-${Date.now()}` } } });
      const plan = planned?.structuredContent ?? {};
      entry.plan = { status: plan.status, code: plan.data?.code, text: (planned?.content?.[0]?.text || "").slice(0, 160) };
      if (plan.status === "verified") { entry.outcome = "verified"; await log(`${label}: verified (no approval needed)`); return entry; }
      if (plan.operationId && ["applied_or_unknown", "awaiting_verification", "cancelled", "failed", "closed_by_person"].includes(plan.effectState)) {
        entry.operationId = plan.operationId;
        entry.state = plan.effectState;
        entry.verification = plan.verification?.status;
        entry.attention = Array.isArray(plan.attention)
          ? plan.attention.filter((code) => !/^[0-9a-f]{64}$/.test(String(code)))
          : [];
        entry.outcome = plan.effectState === "awaiting_verification" ? "sent_unchecked" : plan.effectState;
        await log(`${label}: ${entry.outcome}`);
        return entry;
      }
      if (["applied_or_unknown", "awaiting_verification", "cancelled", "failed", "closed_by_person"].includes(plan.status)) {
        entry.operationId = plan.operationId;
        entry.state = plan.effectState ?? plan.status;
        entry.verification = plan.verification?.status;
        entry.attention = Array.isArray(plan.attention)
          ? plan.attention.filter((code) => !/^[0-9a-f]{64}$/.test(String(code)))
          : [];
        entry.outcome = plan.status === "awaiting_verification" ? "sent_unchecked" : plan.status;
        await log(`${label}: ${entry.outcome}`);
        return entry;
      }
      if (plan.status !== "awaiting_approval" || !plan.receipts?.approvalUrl) {
        entry.outcome = "not_planned";
        await log(`${label}: not_planned ${entry.plan.code || ""} ${entry.plan.text}`);
        return entry;
      }
      entry.operationId = plan.operationId;
      await approve(plan.receipts.approvalUrl, plan.operationId);
      let state = "";
      for (let attempt = 0; attempt < 90; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        const record = (await callTool("morrow_operation_get", { operation_id: plan.operationId }, 60000))?.structuredContent ?? {};
        state = record.state;
        entry.verification = record.verification?.status;
        // Morrow's own account of what happened, including the named reason a
        // change was refused before it was sent.
        if (Array.isArray(record.attention) && record.attention.length) {
          entry.attention = record.attention.filter((code) => !/^[0-9a-f]{64}$/.test(String(code)));
        }
        if (["verified", "failed", "cancelled", "awaiting_verification", "applied_or_unknown", "closed_by_person"].includes(state)) break;
        // A change held back by an earlier unresolved change to the same target
        // will not move until that one is settled. Waiting out the poll teaches
        // nothing, so the sweep records the hold and goes on.
        if (state === "approved" && entry.attention?.includes("provider_effect_target_conflict")) break;
      }
      entry.state = state;
      entry.outcome = state === "verified" ? "verified"
        : state === "awaiting_verification" ? "sent_unchecked"
        : state || "unsettled";
    } catch (error) {
      if (error?.approvalWithheld) {
        entry.outcome = "approval_withheld";
        entry.approvalReason = error.approvalWithheld.reason;
        entry.approvalSentence = error.approvalWithheld.sentence.slice(0, 220);
      } else {
        entry.outcome = "threw"; entry.error = String(error).slice(0, 300);
      }
    }
    await log(`${label}: ${entry.outcome}${entry.error ? " " + entry.error : ""}`);
    return entry;
  }

  return { log, read, change, plan, callTool };
}
