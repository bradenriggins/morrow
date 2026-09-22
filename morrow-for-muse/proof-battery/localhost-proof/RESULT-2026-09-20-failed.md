# Localhost proof run, 2026-09-20 ~21:00 UTC: FAILED (environmental)

- Write op: 05b90ce6-98f1-4e25-b766-f88686f69098 (POST /api/v1/courses/89585/assignments)
- Browser task: browser-task:52a1723d-c197-4ae8-92d2-c026bc2f2dab (closed)
- Form-host server: restarted on this VM, verified 200 at / and 404 on
  unknown paths, URL http://127.0.0.1:38267
- Browser result: the form-host URL was unreachable from the browser
  after 2 attempts (navigation error each time; browser stayed on the
  Canvas dashboard). Per the stop condition, no other page was
  substituted and no GET was used for the POST. No Canvas request was
  sent; no side effects; nothing was created.
- Canvas session stayed alive (user 28206, Braden Riggins, re-verified
  at /api/v1/users/self during the run).

Root cause: the form-host server ran on the engineering VM while the
managed browser task runs on different infrastructure ("leased VM
egress" route). 127.0.0.1 is per-host, so the browser's localhost is
not the server's localhost. In the real product both the connector
(the ephemeral server) and the browser task run on the educator's own
Muse VM, so they share loopback; this proof rig does not replicate
that co-location. The failure is a harness limitation, not a product
refutation, but the localhost lane remains UNPROVEN in a managed
browser.

Faithful next step: run this proof from Braden's own Muse chat, where
his managed browser and the connector share the VM.
