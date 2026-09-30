/**
 * Shared header brand block for every Ehte email.
 *
 * - Shows the hosted Ehte logo (white PNG, designed for the dark teal hero).
 * - If no logoUrl is configured, falls back to the plain "Ehte" text so emails
 *   never break.
 * - Must be a public HTTPS PNG URL. SVG and base64 images are blocked by Gmail/Outlook.
 */

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

export function renderBrandMark(logoUrl?: string, fallbackName = 'Ehte'): string {
  if (!logoUrl) {
    return `<span style="font-size:20px;font-weight:700;letter-spacing:-0.02em;color:#ffffff;">${escapeAttr(fallbackName)}</span>`;
  }

  // Logo file is 726x348 (3x); displayed at 92x44 so it stays sharp on retina screens.
  return `<img src="${escapeAttr(logoUrl)}" alt="${escapeAttr(fallbackName)}" width="92" height="44" style="display:inline-block;border:0;outline:none;text-decoration:none;height:44px;width:92px;vertical-align:middle;" />`;
}
