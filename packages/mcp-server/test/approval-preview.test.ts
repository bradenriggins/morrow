import { describe, expect, it } from "vitest";
import { formattedTextPreview } from "../src/approval-preview.js";

describe("rich approval content", () => {
  it("preserves educational HTML and embedded raster images without changing the original request", () => {
    const content = '<h2>Oxygen transport</h2><p>Review <strong>hemoglobin</strong> and O<sub>2</sub>.</p><table><tr><th scope="col">Cell</th><td>Red blood cell</td></tr></table><ol start="2"><li>Explain its role.</li></ol><img src="data:image/png;base64,iVBORw0KGgo=" alt="Cell diagram">';
    const result = formattedTextPreview("Lesson", content);
    expect(result).toContain('aria-label="Lesson preview"');
    expect(result).toContain("<h2>Oxygen transport</h2>");
    expect(result).toContain("<strong>hemoglobin</strong> and O<sub>2</sub>");
    expect(result).toContain('<th scope="col">Cell</th>');
    expect(result).toContain('<ol start="2">');
    expect(result).toContain('src="data:image/png;base64,iVBORw0KGgo="');
    expect(result).not.toContain("iframe");
    expect(content).toContain('<img src="data:image/png;base64,iVBORw0KGgo=" alt="Cell diagram">');
  });

  it("removes executable content, navigation, forms, external resources, and control-spoofing styles", () => {
    const result = formattedTextPreview('Question "title"', '</div><p id="work-status" class="approve" style="position:fixed">Keep this text.</p><script>fetch("/approve")</script><style>body{display:none}</style><iframe src="/operations"></iframe><form action="/approve"><input name="nonce"><button>Approve</button></form><img src="https://invalid.example/track" onerror="alert(1)" alt="Diagram"><img src="data:image/svg+xml;base64,PHN2Zz4=" alt="Vector image"><a href="javascript:alert(1)">Link text</a><meta http-equiv="refresh" content="0;url=https://invalid.example"><svg onload="alert(1)"><foreignObject><p>Plain text</p></foreignObject></svg>');
    expect(result).toContain("Keep this text.");
    expect(result).toContain("Link text");
    expect(result).toContain("External images and media are not loaded");
    expect(result).toContain("Question &quot;title&quot; preview");
    expect(result).not.toMatch(/<(?:script|style|iframe|form|input|button|meta|svg)\b|\s(?:src|href|style|id|onerror|onload)=/i);
    expect(result).not.toContain('class="approve"');
    expect(result).not.toContain('fetch("/approve")');
  });
});
