# Morrow proof harness coverage report

Built 2026-09-20T05:51:46.767Z against sandbox course 89585.

## Provable operations

378 of 766 provable operations carry live evidence (49.3%).

| Verdict | Count |
| --- | ---: |
| Live evidence (PASS) | 378 |
| Defect found (FAIL) | 2 |
| Blocked, with a recorded reason | 386 |
| Not yet run | 0 |

## Every operation that is not provable here, and why

| Classification | Operations | Reason |
| --- | ---: | --- |
| NO-TENANT | 571 | A site write acts on the whole Canvas site; the sandbox course gives no authority to prove it. |
| NEEDS-LEARNER-ATTEMPT | 80 | The object exists only after a learner attempt, and the sandbox course has none. |
| EXTERNAL-DEPENDENT | 44 | Canvas has no read that shows the saved result, so no readback can prove the effect. |
| HELD | 10 | multi_step_upload_requires_reviewed_transfer |

## Scenarios

7 of 7 educator scenarios pass.

