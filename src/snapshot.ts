// Self-contained snapshot export: assemble one HTML document that re-renders a
// frozen viewport offline. The library bundle and captured data are inlined, so
// the file is shareable as-is.

import type { ChartSnapshot } from './types';

/** Escape a string for safe inclusion in element text / a <script> body. */
function escapeForScript(s: string): string {
  // Break "</script" so the HTML parser can't end inline blocks early.
  return s.replace(/<\/(script)/gi, '<\\/$1');
}

/**
 * Build a complete, self-contained HTML document that renders `snapshot`
 * offline. `libJs` is the ESM library bundle source (it defines and exports
 * `ChartNavigator`); `css` is the chart stylesheet (already includes uPlot's).
 * The data is inlined as JSON, so the file needs no network access.
 */
export function buildStandaloneHtml(
  snapshot: ChartSnapshot,
  assets: { libJs: string; css: string; title?: string },
): string {
  const snapJson = escapeForScript(JSON.stringify(snapshot));
  const title = (assets.title ?? 'Chart snapshot').replace(
    /[<>&]/g,
    (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c]!,
  );
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>${assets.css}</style>
<style>
  /* Fill the page responsively, with a 1em gutter. The chain html→body→root
     all carry a DEFINITE height (100% of the viewport, less the body padding),
     so #vcn-root never falls back to a content-derived height. That matters
     because the library forces position:relative on the root: an auto height
     there is circular — the pane stack sizes off root.clientHeight while the
     root sizes off the panes — and collapses to the per-pane floor (~half the
     window). A definite height breaks the loop; the ResizeObserver then re-fits
     the panes (and the watermark) to any window size, fully offline. */
  html,body{margin:0;height:100%;background:#fff;font:13px/1.4 system-ui,sans-serif}
  body{box-sizing:border-box;padding:1em}
  #vcn-root{width:100%;height:100%}
</style>
</head>
<body>
<div id="vcn-root"></div>
<script type="application/json" id="vcn-snapshot">${snapJson}</script>
<script type="module">
${escapeForScript(assets.libJs)}
const snap = JSON.parse(document.getElementById('vcn-snapshot').textContent);
new ChartNavigator(document.getElementById('vcn-root'), {
  snapshot: snap,
  recipe: snap.recipe,
  extent: snap.extent,
  barMs: snap.barMs,
  minimap: true,
  hooks: { requestFrame: () => {} },
});
</script>
</body>
</html>`;
}
