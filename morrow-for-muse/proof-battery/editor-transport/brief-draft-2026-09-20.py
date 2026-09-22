"""DRAFT: editor-hosted form transport for transport/batch.py.

Apply only after the live proof confirms the primitive. This file is a
design scratchpad, not imported by anything.
"""

import html as _html

# Public HTML editors that render pasted HTML, in fallback order. The form
# CONTENT is packed with the connector (built by connector code, carried in
# the brief); the editor is only a renderer. No Morrow infrastructure.
EDITOR_HOSTS = [
    "https://www.w3schools.com/html/tryit.asp?filename=tryhtml_form_submit",
    "https://www.tutorialspoint.com/online_html_editor.php",
    "https://jsfiddle.net/",
]

CSRF_PLACEHOLDER = "HARVESTED_CSRF_TOKEN"


def _form_html(action, fields, method, csrf_field):
    """Build the complete self-contained form HTML for one write op.

    The CSRF value is the literal placeholder HARVESTED_CSRF_TOKEN; the
    brief instructs the task to substitute the token harvested in Step 2.
    The placeholder (never a real token) is what travels in the brief,
    logs, and reports.
    """
    parts = ["<!doctype html>", "<html><body>"]
    parts.append('<form method="POST" action="%s" target="_top">'
                 % _html.escape(action, quote=True))
    if method in ("PUT", "DELETE"):
        parts.append('<input type="hidden" name="_method" value="%s">' % method)
    for name in sorted(fields):
        vals = fields[name]
        if not isinstance(vals, list):
            vals = [vals]
        for v in vals:
            parts.append('<input type="hidden" name="%s" value="%s">'
                         % (_html.escape(str(name), quote=True),
                            _html.escape(str(v), quote=True)))
    parts.append('<input type="hidden" name="%s" value="%s">'
                 % (_html.escape(csrf_field, quote=True), CSRF_PLACEHOLDER))
    parts.append('<button type="submit">Submit</button>')
    parts.append("</form></body></html>")
    return "\n".join(parts)


# Brief text replacing the old form-host fallback chain:
EDITOR_CHAIN_BRIEF = """\
For each FORM op below, the brief gives you the COMPLETE HTML of a form.
The form posts directly to the API (method POST, target _top, so the whole
tab navigates to the API's JSON response, which you read from the page).
For PUT or DELETE ops the form carries a hidden _method field that the API
honors through the POST.
1) Go to the editor page: {primary}
2) In the code editor pane, select all and paste the op's HTML, replacing
   the literal text HARVESTED_CSRF_TOKEN with the token from STEP 2.
3) Run / Preview the page.
4) In the result pane, click the Submit button. The tab POSTs to the API;
   read the JSON response from the page.
5) For the next op, go back to the editor page and repeat with that op's HTML.
If an editor page fails to load or run, use the next one in this order:
{fallbacks}
If no editor works, report that op as failed with the reason. Never
substitute a GET, and never click through the web UI.
Every write form includes the {csrf_field} field from Step 2 (you pasted
your harvested token over the placeholder). If a write returns 422
mentioning unprocessable_content, your token is stale: re-harvest it from
a fresh page and retry that op once.
Pace yourself: about one op every two seconds. On HTTP 429, wait the
Retry-After seconds and retry that op once.\
"""
