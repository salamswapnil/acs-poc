
import {  writeFile } from 'node:fs/promises';
import { join } from 'node:path';


 export function sanitizeFileName(title) {
  return title.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').trim() || 'untitled';
}

 export function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export async function generateAccessibilityHtmlReport(scanResults, outputDir, baseName) {
  const violationsHtml = scanResults.violations.map((violation, index) => `
    <section class="violation">
      <button class="toggle" type="button" aria-expanded="false">
        ${index + 1}. ${escapeHtml(violation.id)} — ${escapeHtml(violation.help)} (${violation.impact || 'unknown'})
      </button>
      <div class="details" hidden>
        <p>${escapeHtml(violation.description)}</p>
        <p><strong>Help:</strong> <a href="${escapeHtml(violation.helpUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(violation.helpUrl)}</a></p>
        <ul>
          ${violation.nodes
            .map(
              (node) => `
            <li>
              <strong>Target:</strong> ${escapeHtml(node.target.join(', '))}
              <details>
                <summary>HTML Snippet</summary>
                <pre>${escapeHtml(node.html)}</pre>
              </details>
            </li>`
            )
            .join('')}
        </ul>
      </div>
    </section>
  `).join('');

  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(baseName)} - Accessibility Report</title>
<style>
  body { font-family: Arial, sans-serif; margin: 0; padding: 24px; background: #f4f6fb; color: #111; }
  header { margin-bottom: 24px; }
  h1 { margin: 0 0 8px; }
  .summary { margin: 8px 0 0; }
  .violation { background: #fff; border: 1px solid #d5d8e0; border-radius: 8px; margin-bottom: 16px; padding: 16px; }
  .toggle { display: block; width: 100%; text-align: left; border: none; background: transparent; font-size: 16px; font-weight: 600; cursor: pointer; padding: 0; color: #1f2a44; }
  .toggle:hover { color: #0d3b7f; }
  .details { margin-top: 12px; }
  pre { background: #f6f8fb; padding: 12px; border-radius: 6px; overflow: auto; }
  details { margin-top: 12px; }
  a { color: #0d3b7f; text-decoration: none; }
  a:hover { text-decoration: underline; }
</style>
</head>
<body>
<header>
  <h1>Accessibility Report</h1>
  <p class="summary">Violations: ${scanResults.violations.length}</p>
  <p class="summary">Incomplete: ${scanResults.incomplete.length}, Passes: ${scanResults.passes.length}, Inapplicable: ${scanResults.inapplicable.length}</p>
</header>
${violationsHtml || '<p>No accessibility violations found.</p>'}
<script>
  document.querySelectorAll('.toggle').forEach((button) => {
    button.addEventListener('click', () => {
      const expanded = button.getAttribute('aria-expanded') === 'true';
      button.setAttribute('aria-expanded', String(!expanded));
      const details = button.nextElementSibling;
      if (details) {
        details.hidden = expanded;
      }
    });
  });
</script>
</body>
</html>
`;

  await writeFile(join(outputDir, `${baseName}.html`), html, 'utf8');
}