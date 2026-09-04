# Catalog baseline exceptions

The PDF counts are planning estimates. Exported donor receipts are authoritative.

| Donor | PDF estimate | Verified receipt | Eligible before collision/profile disposition | Receipt |
| --- | ---: | ---: | ---: | --- |
| Morrow Canvas callable surface | 270 | 284 | 284 | Live pinned registry export: 262 provider definitions plus 22 admin definitions. |
| ExamplePlatform MCP tools/list | 205 | 222 | 187 | 35 held MindTap/Connect rows. SHA-256 `5234b664a8a4ae83c9459745c08a2b1943b3132152118b79b7771e1eeb7be9c5`; clean detached VPS worktree at `7cc052cf2063e1f2492c0ac20aee41ee3a22a10f` with hermetic test telemetry. |

The catalog exporter does not force either PDF estimate. It emits the live count and
marks a `pdf_*_count_estimate_drift` baseline exception when the observed count differs.
