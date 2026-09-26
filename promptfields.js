// The pure part of a prompt: validating what an author submitted, normalising
// it, finding its blanks, and scoring it for the trending list.
//
// Split out of server.js so it can be tested without a Firestore or an
// Anthropic key — these are the rules most likely to be subtly wrong (a regex
// that misses a placeholder, a weight that makes the front page never turn
// over), and they are the cheapest to check. Nothing here touches I/O.

/**
 * Hacker-News-shaped decay. Views alone would let a months-old prompt that
 * once went round a group chat sit at the top forever; dividing by age makes
 * "trending" mean recent, which is what the word means to a reader.
 *
 * This used to be imported from analytics.js. That file was the CROSS-APP
 * view counter and moved to the landing service; the maths is Spellbook's own
 * and stayed. Same shape, one owner each.
 */
function trendScore(weight, ageHours) {
  return weight / Math.pow(Math.max(ageHours, 0) + 2, 1.5);
}

// Closed vocabularies rather than free text, because the whole value of "which
// platform is this for" is being able to filter on it — and free text gives you
// "Claude", "claude", "Claude.ai" and "anthropic claude" as four platforms
// within a week. `other` plus the free-text tags field is the escape hatch.
const PLATFORMS = [
  'claude', 'claude-code', 'chatgpt', 'gemini', 'copilot', 'cursor',
  'perplexity', 'grok', 'midjourney', 'api', 'local', 'other',
];
const CATEGORIES = [
  'coding', 'writing', 'research', 'analysis', 'image', 'agents',
  'productivity', 'learning', 'fun', 'other',
];

// Display names for the closed platform list. The page has its own copy for
// the browser; this one is for what the server draws (link-preview cards).
const PLATFORM_LABELS = {
  claude: 'Claude', 'claude-code': 'Claude Code', chatgpt: 'ChatGPT', gemini: 'Gemini',
  copilot: 'Copilot', cursor: 'Cursor', perplexity: 'Perplexity', grok: 'Grok',
  midjourney: 'Midjourney', api: 'API / SDK', local: 'Local model', other: 'Other',
};

/**
 * The name printed under a prompt, never an email address.
 *
 * The byline used to be `displayName || email`, and a shared-account session
 * with no display name bridges in with its email AS the display name - so an
 * author who never chose a name published their full address on every card.
 * Anything with an @ is cut to the part before it, which is what registration
 * already offers as the default name. Control characters and bidi overrides
 * go too: this string is drawn into HTML meta tags and a PNG.
 * (2026-09-26)
 */
function publicByline(name) {
  const s = String(name == null ? '' : name)
    .replace(/[\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const at = s.indexOf('@');
  const cut = (at === -1 ? s : s.slice(0, at)).trim().slice(0, 60);
  return cut || 'anonymous';
}

function clean(v, max) {
  return String(v == null ? '' : v).trim().slice(0, max);
}

function pickList(values, allowed, max) {
  const seen = [];
  (Array.isArray(values) ? values : []).forEach((v) => {
    const s = String(v || '').trim().toLowerCase();
    if (allowed.includes(s) && !seen.includes(s) && seen.length < max) seen.push(s);
  });
  return seen;
}

function cleanTags(values) {
  const seen = [];
  (Array.isArray(values) ? values : []).forEach((v) => {
    const s = String(v || '').trim().toLowerCase()
      .replace(/[^a-z0-9+#.-]+/g, '-').replace(/^-+|-+$/g, '');
    if (s && s.length <= 24 && !seen.includes(s) && seen.length < 8) seen.push(s);
  });
  return seen;
}

/**
 * Pull {{placeholders}} out of the body. This is the feature that makes a
 * prompt library more than a notes app: a reader gets a form to fill in rather
 * than a wall of text to hand-edit, and the author does not have to describe
 * the blanks in prose. Always derived from the body, never accepted as input,
 * so the two can never disagree.
 */
function extractVariables(body) {
  const out = [];
  // Apostrophes and a longer cap because authors write English, not tokens:
  // `{{what didn't work}}` and `{{something adjacent I actually understand}}`
  // are the natural way to name a blank, and both were silently dropped by a
  // 40-character alphanumeric rule — no form field, no error, the prompt just
  // quietly had fewer blanks than its text showed.
  //
  // Commas and slashes stay OUT on purpose. `{{name, role, company}}` and
  // `{{a lot / some / nothing}}` are three blanks and a set of options
  // wearing one placeholder, and rendering either as a single text box helps
  // nobody. Leaving them unmatched keeps the pressure on splitting them up.
  const re = /\{\{\s*([a-zA-Z0-9_ '\u2019.-]{1,60}?)\s*\}\}/g;
  let m = re.exec(body);
  while (m && out.length < 20) {
    const name = m[1].trim();
    if (name && !out.includes(name)) out.push(name);
    m = re.exec(body);
  }
  return out;
}

/**
 * Weighted because the three signals mean different things. A copy is someone
 * actually using the prompt, which is the strongest evidence it works; a save
 * is intent; a vote is an opinion. Then decayed by age, so "trending" means
 * recent — views alone would freeze the front page on whatever once went round
 * a group chat.
 */
function computeTrend(data, now) {
  const created = new Date(data.createdAt || (now || Date.now())).getTime();
  const ageHours = ((now || Date.now()) - created) / 3600000;
  const weight = (data.score || 0) + 1
    + 0.5 * (data.copyCount || 0)
    + 0.25 * (data.saveCount || 0)
    + 0.25 * (data.remixCount || 0);
  return Number(trendScore(weight, ageHours).toFixed(6));
}

/**
 * Turn a request body into the stored fields, or an error to show the author.
 * Counters, authorship and createdAt are deliberately NOT produced here — a
 * client must never be able to set its own score, and an edit must not be able
 * to reset one.
 */
function bodyToPromptFields(body, user) {
  const title = clean(body.title, 120);
  const text = clean(body.body, 8000);
  if (!title) return { error: 'Give the prompt a title.' };
  if (text.length < 10) return { error: 'The prompt body is too short.' };
  const platforms = pickList(body.platforms, PLATFORMS, 6);
  if (!platforms.length) return { error: 'Pick at least one platform this prompt is for.' };
  const category = CATEGORIES.includes(String(body.category || '').toLowerCase())
    ? String(body.category).toLowerCase() : 'other';
  return {
    fields: {
      title,
      body: text,
      summary: clean(body.summary, 240),
      platforms,
      models: (Array.isArray(body.models) ? body.models : [])
        .map((m) => clean(m, 40).toLowerCase()).filter(Boolean).slice(0, 4),
      category,
      tags: cleanTags(body.tags),
      variables: extractVariables(text),
      visibility: body.visibility === 'private' ? 'private' : 'public',
      authorId: user.uid,
      authorName: publicByline(user.displayName || user.email),
    },
  };
}

module.exports = {
  trendScore,
  PLATFORMS, CATEGORIES, PLATFORM_LABELS, publicByline,
  clean, pickList, cleanTags, extractVariables, computeTrend, bodyToPromptFields,
};
