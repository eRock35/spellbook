/**
 * Link-preview cards (2026-09-26): the picture a pasted prompt link unfolds
 * into in Messages, Slack, X or LinkedIn.
 *
 * The football app's approach (its cards.js), for the same reasons: an SVG
 * built here from data the server read, rasterised by resvg (Rust, prebuilt
 * binaries, no system libraries) with Inter bundled in fonts/ (SIL OFL,
 * licence beside it). System fonts are never loaded, so a card looks the same
 * in a test and in Cloud Run. Never an image the browser uploads: a card
 * lives on this domain, and letting a request choose the picture would make
 * it an image host.
 *
 * Prompt titles and bodies are USER TEXT, so everything drawn goes through
 * latin() (Inter's Latin subset has no emoji or symbols - they would draw as
 * blanks - so they are removed, and accented letters outside it fall back to
 * their base letter) and then x() (XML escaping, control characters out).
 *
 * 1200x630, the size unfurlers crop least. No model call.
 */

const path = require('path');
const { PLATFORM_LABELS } = require('./promptfields');

let Resvg = null;
try { ({ Resvg } = require('@resvg/resvg-js')); } catch (e) { Resvg = null; }

const FONT_FILES = ['Inter-Regular.ttf', 'Inter-Bold.ttf', 'Inter-Black.ttf'].map((f) => path.join(__dirname, 'fonts', f));
const W = 1200;
const H = 630;
const C = {
  bg: '#0D0B14', bg2: '#221A55', text: '#FFFFFF', dim: '#B9B3D6', faint: '#8A84A8',
  tint: '#9B8CFF', tint2: '#C4A6FF', line: '#2A2540', box: '#FFFFFF0F', boxLine: '#FFFFFF24',
};
const SITE = 'spellbook.strongtechnicalconsulting.com';

/** Text for an SVG text node or attribute. Control characters dropped. */
function x(s) {
  return String(s === undefined || s === null ? '' : s)
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// What Inter's bundled subset can draw (measured from its cmap): ASCII,
// Latin-1, OE/oe, the general punctuation block (dashes, curly quotes,
// bullet, ellipsis), euro, trademark and minus.
const DRAWABLE = /[ -~ -¬®-ÿŒœ‐-‧‰-›€™−]/;

/**
 * User text reduced to what the font can draw: whitespace (newlines included)
 * collapsed to single spaces, a letter outside the subset replaced by its
 * base letter where it has one ("ł" has none and goes; "č" becomes "c"), and
 * everything else - emoji, symbols, other scripts - removed.
 */
function latin(s) {
  let out = '';
  for (const ch of String(s == null ? '' : s).normalize('NFC')) {
    if (/\s/.test(ch)) { out += ' '; continue; }
    if (DRAWABLE.test(ch)) { out += ch; continue; }
    const base = ch.normalize('NFKD').replace(/[̀-ͯ]/g, '');
    if (base && base !== ch && [...base].every((c) => DRAWABLE.test(c))) out += base;
  }
  return out.replace(/\s+/g, ' ').trim();
}

const perChar = (size, weight) => size * (weight >= 700 ? 0.6 : 0.54);

/** Roughly fit `s` in `px` at `size` (Inter averages ~0.56em a character). */
function fit(s, size, px, weight = 400) {
  const str = String(s || '').replace(/\s+/g, ' ').trim();
  const max = Math.max(4, Math.floor(px / perChar(size, weight)));
  return str.length <= max ? str : `${str.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Approximate rendered width of `s` in px. Per-character classes rather than
 * one average, because a title in capitals is half again as wide as the same
 * title in lower case, and a single average either wastes the line or
 * overflows the card.
 */
function measure(s, size, weight) {
  let em = 0;
  for (const ch of String(s || '')) {
    if (/[ il.,:;'!|ijtf()\[\]\u2019]/.test(ch)) em += 0.3;
    else if (/[MWmw@%]/.test(ch)) em += 0.86;
    else if (/[A-Z0-9&#?]/.test(ch)) em += 0.68;
    else if (/[a-z]/.test(ch)) em += 0.54;
    else em += 0.62;
  }
  return em * size * (weight >= 700 ? 1.06 : 1);
}

/**
 * Greedy word wrap into at most `maxLines`, the last one ellipsised when the
 * text runs on. A word longer than a line is cut rather than overflowing.
 */
function wrap(s, size, px, weight, maxLines) {
  const fits = (t) => measure(t, size, weight) <= px;
  const cut = (t) => { let o = t; while (o.length > 1 && !fits(`${o}…`)) o = o.slice(0, -1); return `${o.trimEnd()}…`; };
  const words = String(s || '').split(' ').filter(Boolean);
  const lines = [];
  let cur = '';
  let i = 0;
  for (; i < words.length; i++) {
    let w = words[i];
    if (!fits(w)) w = cut(w);
    const next = cur ? `${cur} ${w}` : w;
    if (fits(next)) { cur = next; continue; }
    lines.push(cur);
    cur = w;
    if (lines.length === maxLines) break;
  }
  if (lines.length < maxLines && cur) { lines.push(cur); cur = ''; i = words.length; }
  if (i < words.length || cur) lines[maxLines - 1] = cut(lines[maxLines - 1] || '');
  return lines.slice(0, maxLines);
}

function text(xp, y, s, { size = 32, weight = 400, fill = C.text, anchor = 'start', px = 1080 } = {}) {
  return `<text x="${xp}" y="${y}" font-family="Inter" font-size="${size}" font-weight="${weight}" fill="${fill}"` +
    ` text-anchor="${anchor}">${x(fit(s, size, px, weight))}</text>`;
}

/** One excerpt line with its {{blanks}} picked out in the tint colour. */
function excerptLine(xp, y, line, size) {
  const parts = String(line).split(/(\{\{[^{}]{1,60}\}\})/);
  const spans = parts.filter(Boolean).map((part) => (/^\{\{[^{}]{1,60}\}\}$/.test(part)
    ? `<tspan fill="${C.tint2}" font-weight="700">${x(part)}</tspan>`
    : `<tspan>${x(part)}</tspan>`)).join('');
  return `<text x="${xp}" y="${y}" font-family="Inter" font-size="${size}" font-weight="400" fill="${C.dim}" xml:space="preserve">${spans}</text>`;
}

function pill(xp, y, label, { fill = '#9B8CFF26', stroke = '#9B8CFF66', color = C.tint2, size = 22 } = {}) {
  const w = Math.min(360, Math.round(String(label).length * size * 0.6) + 36);
  return { w, svg: `<rect x="${xp}" y="${y - size - 8}" width="${w}" height="${size + 22}" rx="${(size + 22) / 2}" fill="${fill}" stroke="${stroke}"/>` +
    text(xp + 18, y + 2, label, { size, weight: 700, fill: color, px: w - 30 }) };
}

/** A four-pointed sparkle, the app's mark, drawn as a shape (no glyph). */
function sparkle(cx, cy, r, fill) {
  const k = r * 0.28;
  return `<path d="M${cx} ${cy - r} Q${cx + k} ${cy - k} ${cx + r} ${cy} Q${cx + k} ${cy + k} ${cx} ${cy + r}` +
    ` Q${cx - k} ${cy + k} ${cx - r} ${cy} Q${cx - k} ${cy - k} ${cx} ${cy - r}Z" fill="${fill}"/>`;
}

function frame(inner, { footRight = 'Free to browse. Fill in the blanks.' } = {}) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` +
    '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">' +
    `<stop offset="0" stop-color="${C.bg2}"/><stop offset="0.7" stop-color="${C.bg}"/></linearGradient>` +
    '<radialGradient id="glow" cx="0.95" cy="0.02" r="0.65"><stop offset="0" stop-color="#8B5CF6" stop-opacity="0.45"/>' +
    '<stop offset="1" stop-color="#8B5CF6" stop-opacity="0"/></radialGradient></defs>' +
    `<rect width="${W}" height="${H}" fill="url(#g)"/><rect width="${W}" height="${H}" fill="url(#glow)"/>` +
    sparkle(80, 66, 20, C.tint2) + sparkle(104, 48, 8, C.tint) +
    text(122, 78, 'Spellbook', { size: 28, weight: 700 }) +
    inner +
    `<line x1="60" y1="${H - 74}" x2="${W - 60}" y2="${H - 74}" stroke="${C.line}" stroke-width="2"/>` +
    text(60, H - 34, SITE, { size: 22, fill: C.faint, px: 560 }) +
    text(W - 60, H - 34, footRight, { size: 22, fill: C.faint, anchor: 'end', px: 480 }) +
    '</svg>';
}

const plural = (k, one, many) => `${Number(k).toLocaleString('en-US')} ${k === 1 ? one : many}`;

/**
 * One prompt.
 *   { title, platforms: ['claude', ...], copyCount, body, by }
 * Every string is user text and is cleaned here, so a caller cannot forget.
 */
function promptSvg(d) {
  const title = latin(d.title) || 'A prompt on Spellbook';
  const titleLines = wrap(title, 54, 1080, 900, 2);
  let out = '';
  let y = 176;
  titleLines.forEach((line, i) => { out += `<text x="60" y="${y + i * 64}" font-family="Inter" font-size="54" font-weight="900" fill="${C.text}" letter-spacing="-1">${x(line)}</text>`; });
  y += (titleLines.length - 1) * 64 + 62;

  // Platforms: the one thing a reader needs to know before tapping.
  let px = 60;
  for (const k of (d.platforms || []).slice(0, 4)) {
    const label = PLATFORM_LABELS[k];
    if (!label) continue;
    const p = pill(px, y + 8, label);
    if (px + p.w > W - 60) break;
    out += p.svg;
    px += p.w + 12;
  }
  y += 40;

  // The prompt itself, in a box, as the page draws it.
  const lines = wrap(latin(d.body), 27, 1020, 400, titleLines.length > 1 ? 3 : 4);
  if (lines.length) {
    const boxH = lines.length * 40 + 30;
    out += `<rect x="60" y="${y}" width="${W - 120}" height="${boxH}" rx="18" fill="${C.box}" stroke="${C.boxLine}"/>`;
    lines.forEach((line, i) => { out += excerptLine(90, y + 46 + i * 40, line, 27); });
  }

  const copies = Math.max(0, Math.floor(Number(d.copyCount) || 0));
  const by = latin(d.by);
  if (by) out += text(60, 528, `by ${by}`, { size: 28, weight: 700, fill: C.dim, px: 560 });
  out += text(W - 60, 528, copies ? `Copied ${plural(copies, 'time', 'times')}` : 'New on Spellbook',
    { size: 30, weight: 900, fill: C.tint2, anchor: 'end', px: 520 });
  return frame(out);
}

/** The app's own preview, for a link to the front page. Static. */
function appSvg() {
  let out = text(60, 196, 'Prompts worth keeping', { size: 64, weight: 900 });
  out += text(60, 250, 'Shared, voted on and remixed — with a form for every blank.', { size: 30, fill: C.dim });
  const y = 300;
  out += `<rect x="60" y="${y}" width="${W - 120}" height="150" rx="18" fill="${C.box}" stroke="${C.boxLine}"/>`;
  out += excerptLine(90, y + 58, 'Review this {{language}} diff for race conditions. Explain each', 30);
  out += excerptLine(90, y + 102, 'finding for {{audience}} and suggest the smallest fix.', 30);
  let px = 60;
  for (const label of ['Claude', 'Claude Code', 'ChatGPT', 'Gemini', 'Midjourney']) {
    const p = pill(px, 516, label);
    out += p.svg;
    px += p.w + 12;
  }
  return frame(out);
}

/** An SVG to a PNG buffer, or null when the renderer is not installed. */
function png(svg) {
  if (!Resvg) return null;
  const r = new Resvg(svg, { fitTo: { mode: 'width', value: W },
    font: { fontFiles: FONT_FILES, loadSystemFonts: false, defaultFontFamily: 'Inter' } });
  return r.render().asPng();
}

/** A small LRU of rendered cards. A link pasted into a group chat is
 *  fetched by every client in it; the key carries what the card shows. */
function createCache(max = 200) {
  const m = new Map();
  return {
    get(k) { const v = m.get(k); if (v) { m.delete(k); m.set(k, v); } return v || null; },
    set(k, v) { m.set(k, v); if (m.size > max) m.delete(m.keys().next().value); },
    get size() { return m.size; },
  };
}

module.exports = { promptSvg, appSvg, png, createCache, x, latin, fit, wrap, measure, W, H, SITE };
