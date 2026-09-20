# Educator scenarios

Each scenario is one thing a teacher actually asks for, written the way they would ask it, with
the tool chain it should take, the readback from Canvas that proves it happened, and the cleanup
that returns the sandbox to what it held before.

A scenario passes only when Canvas itself shows the result. A scenario that touches a learner
also asserts the privacy boundary on every read path it uses: an untokenized learner identity
anywhere in the chain fails the scenario, it is never a note.

Every scenario runs against the sandbox course alone.
