// Runs in a Morrow review tab. Morrow Bridge adds its signature to an approval form only when a
// person's own click or key press submits it. A submit that a script starts is not trusted, so the
// form stays unsent and the review server refuses any post without the signature.
(() => {
  if (globalThis.__morrowReviewApproval) return;
  globalThis.__morrowReviewApproval = true;

  const approvePath = (form) => {
    try {
      const path = new URL(form.getAttribute("action") || "", location.href).pathname;
      return /\/approve$/.test(path) ? path : null;
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
          showProblem(form, "Morrow Bridge could not confirm this approval. Check that Morrow Bridge is connected, reload this page, and select the button again. Nothing was approved.");
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
