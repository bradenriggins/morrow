// Runs in a Morrow review tab. Morrow Bridge adds its signature to an approval form, or to the
// form that closes a change the person checked themselves, only when a person's own click or key
// press submits it. A submit that a script starts is not trusted, so the
// form stays unsent and the review server refuses any post without the signature.
//
// The review server shows each learner by label only, because any local program can read it. This
// script asks Morrow Bridge who each label on this page is and shows "Name (Student A1)" in the
// page text. It never writes a name into a form field, the request details, or anything sent.
(() => {
  if (globalThis.__morrowReviewApproval) return;
  globalThis.__morrowReviewApproval = true;

  const approvePath = (form) => {
    try {
      const path = new URL(form.getAttribute("action") || "", location.href).pathname;
      return /\/(?:approve|cancel|close)$/.test(path) ? path : null;
    } catch {
      return null;
    }
  };

  const showProblem = (form, text) => {
    let note = form.parentElement?.querySelector(".review-approval-problem");
    if (!note) {
      note = document.createElement("p");
      note.className = "warning review-approval-problem";
      note.setAttribute("role", "alert");
      form.after(note);
    }
    note.textContent = text;
  };

  const hidden = (form, name, value) => {
    const input = document.createElement("input");
    input.type = "hidden";
    input.name = name;
    input.value = value;
    form.append(input);
  };

  // A signing failure names its cause: no answer (the worker is gone),
  // a missing key (the connection restarted or the review ended), or a
  // stale page (anything else, including an unknown code). The codes
  // match signReviewApproval in review-approval.js.
  const signFailureText = (path, code, silent) => {
    const closing = /\/close$/.test(path);
    const cancelling = /\/cancel$/.test(path);
    const kept = closing ? "Nothing was closed." : cancelling ? "Nothing was cancelled." : "Nothing was approved.";
    const act = closing ? "this click" : cancelling ? "this cancellation" : "this approval";
    if (silent) return `Morrow Bridge did not answer. Check that Morrow Bridge is connected, reload this page, and select the button again. ${kept}`;
    if (code === "review_approval_key_missing") return `Morrow Bridge no longer holds this review's approval key: the connection restarted or the review ended. Reload this page for a fresh review, then select the button again. ${kept}`;
    if (code === "review_approval_sender_refused" || code === "review_approval_request_invalid") return `This review page is stale. Reload it and select the button again. ${kept}`;
    return `Morrow Bridge could not confirm ${act}. Check that Morrow Bridge is connected, reload this page, and select the button again. ${kept}`;
  };

  const LABEL = /\bStudent A[1-9][0-9]{0,5}\b/g;
  const SKIP = "pre, code, script, style, textarea, select, option, input, template, noscript, [data-morrow-learner-label]";
  let learnerNames = new Map();
  let observer = null;

  const nameText = (label) => `${learnerNames.get(label)} (${label})`;

  const nameTextNode = (node) => {
    const text = node.nodeValue || "";
    LABEL.lastIndex = 0;
    if (!LABEL.test(text) || node.parentElement?.closest(SKIP)) return;
    LABEL.lastIndex = 0;
    const parts = document.createDocumentFragment();
    let last = 0;
    let named = false;
    for (const match of text.matchAll(LABEL)) {
      if (!learnerNames.has(match[0])) continue;
      named = true;
      parts.append(document.createTextNode(text.slice(last, match.index)));
      const span = document.createElement("span");
      span.dataset.morrowLearnerLabel = match[0];
      span.textContent = nameText(match[0]);
      parts.append(span);
      last = match.index + match[0].length;
    }
    if (!named) return;
    parts.append(document.createTextNode(text.slice(last)));
    node.replaceWith(parts);
  };

  const nameWithin = (root) => {
    if (!learnerNames.size || !root) return;
    if (root.nodeType === Node.TEXT_NODE) {
      nameTextNode(root);
      return;
    }
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    nodes.forEach(nameTextNode);
  };

  const showNames = (names) => {
    for (const span of document.querySelectorAll("[data-morrow-learner-label]")) {
      const label = span.dataset.morrowLearnerLabel;
      if (names.has(label)) span.textContent = `${names.get(label)} (${label})`;
      else span.replaceWith(document.createTextNode(label));
    }
    document.body?.normalize();
    learnerNames = names;
    if (!names.size) {
      observer?.disconnect();
      observer = null;
      return;
    }
    nameWithin(document.body);
    if (!observer && document.body) {
      observer = new MutationObserver((records) => {
        for (const record of records) record.addedNodes.forEach(nameWithin);
      });
      observer.observe(document.body, { childList: true, subtree: true });
    }
  };

  const askForNames = () => {
    Promise.resolve(chrome.runtime.sendMessage({ type: "morrow_review_learner_names" }))
      .catch(() => null)
      .then((response) => {
        const names = new Map();
        if (response?.ok && response.names && typeof response.names === "object") {
          for (const [label, name] of Object.entries(response.names)) {
            if (/^Student A[1-9][0-9]{0,5}$/.test(label) && typeof name === "string" && name.trim()) names.set(label, name);
          }
        }
        if (names.size || learnerNames.size) showNames(names);
      });
  };

  chrome.runtime.onMessage?.addListener((message) => {
    if (message?.type === "morrow_review_learner_names_changed") askForNames();
    return false;
  });
  askForNames();

  // The first navigation has no proof, so the server answers with no review and no nonce.
  // Ask Morrow Bridge to sign this page, then load the review. A program that only knows the
  // URL cannot make that signature.
  const openReview = () => {
    if (typeof location.pathname !== "string" || !location.pathname) return;
    if (document.querySelector?.('input[name="nonce"]')) return;
    const path = location.pathname;
    Promise.resolve(chrome.runtime.sendMessage({ type: "morrow_review_approval_sign", approvePath: path, nonce: "open" }))
      .catch(() => null)
      .then(async (response) => {
        if (!response?.ok || typeof response.presence !== "string" || document.querySelector?.('input[name="nonce"]')) return;
        const requestSignal = (expiresAt) => AbortSignal.timeout(Math.max(1, Math.min(2_147_483_647, 8_000)));
        const page = await fetch(location.href, {
          credentials: "same-origin",
          headers: { accept: "text/html", "x-morrow-review-presence": response.presence },
          signal: requestSignal(),
        }).catch(() => null);
        if (!page?.ok) {
          try { const canceled = page?.body?.cancel?.(); if (canceled && typeof canceled.catch === "function") canceled.catch(() => {}); } catch {}
          return;
        }
        const reader = page.body?.getReader?.();
        if (!reader) return;
        const decoder = new TextDecoder("utf-8", { fatal: true });
        let html = "";
        let size = 0;
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          size += next.value.byteLength;
          if (size > 2 * 1024 * 1024) { try { reader.cancel(); } catch {} return; }
          html += decoder.decode(next.value, { stream: true });
        }
        html += decoder.decode();
        const parsed = new DOMParser().parseFromString(html, "text/html");
        if (!parsed.documentElement) return;
        document.replaceChild(parsed.documentElement, document.documentElement);
        for (const old of document.querySelectorAll("script[src]")) {
          const script = document.createElement("script");
          script.src = old.getAttribute("src");
          if (old.defer) script.defer = true;
          old.replaceWith(script);
        }
        askForNames();
      });
  };
  openReview();

  document.addEventListener("submit", (event) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    const path = approvePath(form);
    if (!path) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (!event.isTrusted || form.dataset.morrowApproving === "true") return;
    const nonce = form.querySelector('input[name="nonce"]')?.value || "";
    const submitter = event.submitter instanceof HTMLButtonElement ? event.submitter : null;
    form.dataset.morrowApproving = "true";
    const buttons = [...form.querySelectorAll("button")];
    buttons.forEach((button) => { button.disabled = true; });
    chrome.runtime.sendMessage({ type: "morrow_review_approval_sign", approvePath: path, nonce })
      .catch(() => null)
      .then((response) => {
        if (!response?.ok || typeof response.presence !== "string") {
          delete form.dataset.morrowApproving;
          buttons.forEach((button) => { button.disabled = false; });
          showProblem(form, signFailureText(path, response?.code, response === null || response === undefined));
          return;
        }
        form.querySelectorAll('input[name="presence"], input[data-morrow-submitter]').forEach((input) => input.remove());
        hidden(form, "presence", response.presence);
        if (submitter?.name) {
          hidden(form, submitter.name, submitter.value);
          form.lastElementChild.dataset.morrowSubmitter = "true";
        }
        HTMLFormElement.prototype.submit.call(form);
      });
  }, true);
})();
