// The client side of one Morrow connection: reads that resolve a large result through its
// artifact handle, changes that go through the same approval page a person sees, and a log.
// Ported from the live BT2 sweep that proved these paths, so the harness keeps the machinery
// that already worked instead of a second copy that has to be proven again.
import { appendFile } from "node:fs/promises";
import { SOURCE_BINDING as SB } from "../connect.mjs";

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

  // Morrow's approval page issues one session cookie and a nonce bound to it. A later page keeps the
  // same session, so the cookie is carried like a browser would.
  // Morrow names each approval's cookie after its own nonce and scopes it to that
  // review's own path, so only the cookie this page issued belongs on this
  // approval. Sending every cookie ever issued grows one header without bound and
  // the review is refused for a reason that has nothing to do with the change.
  async function approve(approvalUrl, attempt = 0) {
    // Morrow offers the Approve control only once it has named everything the change addresses,
    // and naming it is a fresh Canvas read that can take a few seconds. A person would open the
    // page again; giving up on the first load reports a change as withheld that was only not
    // ready yet.
    let page; let body; let cookie; let nonce;
    for (let load = 0; load < 5; load += 1) {
      page = await fetch(approvalUrl);
      body = await page.text();
      const issued = page.headers.getSetCookie?.() ?? [page.headers.get("set-cookie")].filter(Boolean);
      cookie = issued.map((value) => String(value).split(";", 1)[0].trim()).filter(Boolean).join("; ");
      nonce = /name="nonce" value="([^"]+)"/.exec(body)?.[1];
      if (nonce && cookie) break;
      await new Promise((resolve) => setTimeout(resolve, 4000));
    }
    if (!nonce || !cookie) throw new Error(`approval page had no form (${page?.status})`);
    const response = await fetch(`${approvalUrl}/approve`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie, origin: new URL(approvalUrl).origin, referer: approvalUrl },
      body: new URLSearchParams({ nonce }),
    });
    if (!response.ok) {
      // Morrow withholds the approval control when it cannot name what the change
      // points at, and naming it is a fresh Canvas read that can fail on its own.
      // A person would open the page again, so this does too, once.
      if (attempt === 0) {
        await new Promise((resolve) => setTimeout(resolve, 3000));
        return approve(approvalUrl, 1);
      }
      const text = (await response.text()).slice(0, 200);
      const reason = /"code":"([a-z_]+)"/.exec(text)?.[1] || `http_${response.status}`;
      const shown = body.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
      const sentence = /(Morrow [^.]{10,200}\.)/.exec(shown)?.[1] || "";
      const error = new Error(`approval_withheld:${reason}`);
      error.approvalWithheld = { reason, sentence };
      throw error;
    }
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
    return await change(label, name, args, { direct: true });
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
      if (plan.status !== "awaiting_approval" || !plan.receipts?.approvalUrl) {
        entry.outcome = "not_planned";
        await log(`${label}: not_planned ${entry.plan.code || ""} ${entry.plan.text}`);
        return entry;
      }
      entry.operationId = plan.operationId;
      await approve(plan.receipts.approvalUrl);
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
