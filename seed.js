// The prompts a brand-new Spellbook starts with.
//
// An empty library is a worse pitch than a small one: the first visitor cannot
// tell a prompt library from a notes app until they have seen what a good
// entry looks like, and nobody writes the first one into an empty page. So the
// app ships with a shelf already stocked.
//
// These are NOT decoration and they are not samples of the format. Every one
// is a prompt worth running, and they were chosen to show the thing that makes
// this more than a text file: the {{blanks}}. A reader gets a form to fill in,
// not a wall of text to hand-edit.
//
// HOW THIS DIFFERS FROM board.js AND schedule.js ELSEWHERE. Those are read-path
// seeds: what a fresh database *serves*, never written, so "restore the
// original" cannot drift. That shape is wrong here. A prompt is voted on,
// saved, copied and remixed, and none of that can attach to something that
// exists only in a file. So these are written once, into real documents, and
// from that moment they are ordinary prompts: they rank, they can be remixed,
// and they can be edited or deleted like any other.
//
// Written once means exactly once. `control/seed` is created with create(),
// which fails if it exists - so two instances booting together cannot both
// seed, and a later deploy cannot resurrect a prompt someone deleted on
// purpose. Deleting that one document is the only way to seed again, and that
// is a deliberate act rather than a side effect of a restart.
//
// AUTHORSHIP. The byline is Spellbook, because Spellbook is what wrote them.
// The owning uid is the admin's, so they can be fixed from inside the app like
// anything else - without it a typo in a seed would need a Firestore write to
// correct. With no ADMIN_EMAIL configured they fall back to a reserved id and
// become read-only, which is the honest outcome rather than a silent one.

const { extractVariables, computeTrend } = require('./promptfields');

const SEED_AUTHOR_NAME = 'Spellbook';
const RESERVED_AUTHOR_ID = 'spellbook-seed';

const PROMPTS = [
  {
    title: 'Get oriented in an unfamiliar codebase',
    summary: 'Ask for the map before the tour: entry points, the seams, and what is load-bearing.',
    category: 'coding',
    platforms: ['claude-code', 'claude', 'cursor', 'copilot'],
    tags: ['onboarding', 'architecture', 'reading-code'],
    body: `I've just been handed this codebase and I need to be useful in it by {{deadline}}.
My job here is {{what I've been asked to change}}.

Don't summarise every file. Instead:

1. Name the entry points — where does a request, a job, or a command actually start?
2. Trace ONE representative path end to end, the one closest to my task, and
   name the files it passes through in order.
3. Point at the seams: the three or four places where a change is meant to be
   made, and the places that look editable but are load-bearing.
4. Tell me what is generated, vendored, or copied from somewhere else, so I
   don't hand-edit something a script will overwrite.
5. List what you had to guess, and what you'd need to read to stop guessing.

Then, and only then, tell me where you'd make my change and why there.`,
  },
  {
    title: 'Adversarial review of my own diff',
    summary: 'Not "does this look fine" — what input makes it wrong, and which reviewer rejects it.',
    category: 'coding',
    platforms: ['claude-code', 'claude', 'cursor'],
    tags: ['code-review', 'bugs', 'testing'],
    body: `Review this change the way someone trying to find a bug in it would, not
the way someone trying to approve it would.

<diff>
{{paste the diff}}
</diff>

For each problem you find, give me all three of:
- the concrete input or state that triggers it,
- what goes wrong (wrong output, crash, silent corruption, cost),
- the smallest fix.

Rank by how bad it is if it ships, not by how easy it is to explain.

Then answer these separately:
- What does this change quietly make slower, more expensive, or less reversible?
- Which existing test would have caught this if it had been written, and what
  would it assert?
- If you had to approve this as-is, what would you write in the review that you
  would regret later?

If you find nothing real, say so plainly. Don't pad the list.`,
  },
  {
    title: 'Pre-mortem: how this fails',
    summary: 'Assume the plan already failed and work backwards. Cheaper than finding out.',
    category: 'analysis',
    platforms: ['claude', 'chatgpt', 'gemini'],
    tags: ['planning', 'risk', 'decisions'],
    body: `It's {{a date 6 months out}}. We did {{the thing I'm planning}} and it went badly
enough that {{who would be annoyed}} is asking what happened.

Write the post-mortem. Not hedged predictions — a specific account of what
went wrong, in past tense, as if it already happened.

Cover:
- The failure everyone saw coming and did nothing about.
- The one nobody saw coming, which in hindsight was obvious.
- The thing that worked, and was therefore expanded until it stopped working.
- The moment where it could still have been turned around cheaply, and what
  would have had to be noticed then.

Then, separately: which of these can I actually cheapen or detect early, and
what is the smallest thing I could do this week to do it?`,
  },
  {
    title: 'Make this sound like a person wrote it',
    summary: 'Strips the hedging and the throat-clearing without flattening the meaning.',
    category: 'writing',
    platforms: ['claude', 'chatgpt', 'gemini'],
    tags: ['editing', 'tone', 'business-writing'],
    body: `Rewrite the text below so it reads like it was written by one competent person
with something to say, not assembled by a committee.

Audience: {{who reads this}}
What I want them to do after reading: {{the action}}

Rules:
- Cut throat-clearing. The first sentence should carry information.
- No "delve", "leverage", "robust", "seamless", "it's worth noting",
  "in today's fast-paced".
- Keep every concrete number, name and commitment exactly as written. If
  something is vague in the original, leave it vague rather than inventing
  precision.
- Shorter is better, but not at the cost of a fact.
- Keep the parts where the author is taking a position. Those are the point.

Give me the rewrite, then three lines on what you cut and why.

<text>
{{paste the draft}}
</text>`,
  },
  {
    title: 'Argue me out of this decision',
    summary: 'Steelman the alternative you already rejected, before it steelmans itself later.',
    category: 'analysis',
    platforms: ['claude', 'chatgpt', 'grok'],
    tags: ['decisions', 'critical-thinking'],
    body: `I've decided to {{the decision}}.

My reasoning: {{why}}
What I'm optimising for: {{the goal}}
What I've already ruled out: {{the alternatives}}

Do not validate this. Do three things:

1. Make the strongest honest case for the alternative I rejected most quickly.
   Not a token counter-argument — the version someone who chose it would give.
2. Name the assumption my decision rests on that I have not actually checked,
   and tell me how I'd check it.
3. Tell me what would have to be true for me to be wrong, and whether I could
   observe it before it's too late to change course.

Finish with a straight answer: on what you know, is this the right call? If it
is, say so — I'm asking for pressure, not for a reversal.`,
  },
  {
    title: 'Turn a messy thread into who owes what',
    summary: 'Decisions, owners, dates, and the questions nobody answered.',
    category: 'productivity',
    platforms: ['claude', 'chatgpt', 'gemini', 'copilot'],
    tags: ['meetings', 'email', 'summarising'],
    body: `Below is a {{thread transcript or chat log}}.

Give me exactly four sections, and nothing else:

**Decided** — what was actually settled, and by whom. Only things that were
decided, not things that were discussed favourably.

**Owed** — who owes what to whom, by when. One line each:
"NAME — does WHAT — by WHEN". Write "no date given" rather than inventing one.

**Open** — questions that were asked and never answered, and disagreements
that were talked past rather than resolved.

**Mine** — just the items where {{my name}} is on the hook, restated as things
I could start doing tomorrow.

If something is ambiguous, put it in Open rather than guessing which way it
went.

<thread>
{{paste it here}}
</thread>`,
  },
  {
    title: 'Explain it from what I already know',
    summary: 'Anchored on an adjacent thing you understand, so it lands instead of washing over.',
    category: 'learning',
    platforms: ['claude', 'chatgpt', 'gemini', 'perplexity'],
    tags: ['learning', 'explanation'],
    body: `Teach me {{the thing I want to understand}}.

Here is what I already know well: {{something adjacent I actually understand}}.
Here is why I'm learning it: {{what I'm trying to do}}.

Start from the adjacent thing and build outward. Specifically:

1. What is the same as what I already know? Say it in one paragraph so I can
   stop re-learning it.
2. What is genuinely different, and what breaks if I carry my existing
   intuition across? This is the part I actually need.
3. Give me the smallest real example — something I could run, do, or work
   through myself in under ten minutes.
4. Name the mistake that people with my exact background reliably make here.

Skip the history and the "there are many approaches" survey unless the choice
between approaches is the thing I need to understand.`,
  },
  {
    title: 'Commit message that explains why',
    summary: 'The diff shows what changed. The message has to carry what the diff cannot.',
    category: 'coding',
    platforms: ['claude-code', 'claude', 'cursor', 'copilot'],
    tags: ['git', 'commits', 'documentation'],
    body: `Write the commit message for this change.

<diff>
{{paste the diff}}
</diff>

Context the diff doesn't show: {{why this was needed}}

The subject line: under 60 characters, imperative mood, says what the change
accomplishes rather than which files moved.

The body: the reasoning a reader will not be able to recover from the diff in
six months. Specifically —
- What was wrong before, concretely enough that someone could reproduce it.
- Why this fix rather than the obvious alternative.
- Anything here that looks wrong but is deliberate, so nobody "fixes" it back.

Do not list the files changed; git already does that. Do not describe the diff
line by line. If the change is genuinely trivial, write one line and stop.`,
  },
  {
    title: 'Find the number that actually matters',
    summary: 'Point it at a table and make it argue for one metric instead of listing twelve.',
    category: 'analysis',
    platforms: ['claude', 'chatgpt', 'gemini'],
    tags: ['data', 'metrics', 'reporting'],
    body: `Here is the data: {{paste the table or describe it}}

The decision this feeds: {{what changes depending on it}}
The audience: {{who sees the result}}

Don't give me a dashboard. Give me:

1. The single number that should drive this decision, and why that one rather
   than the more obvious candidate.
2. What would make that number lie — a denominator that shifts, a survivorship
   effect, a seasonal pattern, a definition that changed mid-period.
3. The one comparison that makes it mean something. A number with nothing to
   compare it against is a fact, not a finding.
4. What I should check before I put it in front of {{the audience}}, in the
   order I should check it.

If the data can't support the decision, say that first and say what would.`,
  },
  {
    title: 'Research notes into a decision memo',
    summary: 'Recommendation first, then the reasoning, then what would change your mind.',
    category: 'writing',
    platforms: ['claude', 'chatgpt', 'gemini'],
    tags: ['memo', 'research', 'decisions'],
    body: `Turn these notes into a one-page memo for {{who has to decide}}.

<notes>
{{paste the notes}}
</notes>

The decision on the table: {{the question}}
How much they already know: {{how much context they have}}

Structure, in this order:

**Recommendation** — one sentence, up front. What to do.
**Why** — three points, strongest first. Each grounded in something in the
notes, not in general reasoning.
**What it costs** — money, time, or what this forecloses. Do not skip this.
**What would change my mind** — the specific thing that, if true, flips the
recommendation.
**What I don't know** — gaps in the notes, named rather than papered over.

One page. If something in the notes doesn't serve the decision, cut it.`,
  },
  {
    title: 'Debug by hypothesis, not by guessing',
    summary: 'Forces a ranked list of causes and a cheap test for each before anything is changed.',
    category: 'coding',
    platforms: ['claude-code', 'claude', 'cursor'],
    tags: ['debugging', 'errors'],
    body: `Something is broken and I want to stop changing things at random.

What I see: {{the symptom}}
What I expected: {{expected behaviour}}
Error output:
\`\`\`
{{stack trace or log}}
\`\`\`
What I already tried: {{what didn't work}}
What changed recently - a deploy, a dependency, config, data, or nothing:
{{the last thing that changed}}

Before suggesting any fix:

1. Give me the three most likely causes, ranked, with your reasoning for the
   ranking. Say which is most likely given what changed recently.
2. For each, the cheapest test that would rule it in or out — a log line, a
   one-line check, a value to print. Cheapest first.
3. Tell me what the error message is NOT telling me: what it would look like
   if the real fault were one layer below where it surfaced.

Only after I come back with results should you propose a change.`,
  },
  {
    title: 'Outreach that does not read like a template',
    summary: 'One specific reason you are writing to this person, and one easy thing to say yes to.',
    category: 'writing',
    platforms: ['claude', 'chatgpt', 'gemini'],
    tags: ['email', 'outreach', 'sales'],
    body: `Write a short first email to {{their name}}, {{their role}} at {{their company}}.

Why them specifically (something they did, said, shipped or published, not flattery):
{{what I noticed about them}}
What I want: {{the ask}}
What's in it for them, honestly, even if it's small: {{what they get}}
How we're connected, if at all: {{our connection}}

Constraints:
- Under 120 words.
- The first line proves I know who they are. Not flattery — a specific fact.
- One ask, and make it easy to say yes to. A 15-minute call is easier than a
  meeting; a yes/no question is easier than either.
- No "I hope this finds you well", no "quick question", no "circling back",
  no paragraph about my company before the reason I'm writing.
- If the honest answer to "what's in it for them" is "not much", say something
  true and small rather than inflating it.

Give me the email, then one alternative subject line.`,
  },
];

/**
 * Turn the shelf above into storable documents. Exported separately from the
 * writing so a test can check the shape without a database — an invalid seed
 * would otherwise be discovered by a deploy.
 */
function seedDocuments(authorId, now) {
  const base = now || Date.now();
  return PROMPTS.map((p, i) => {
    // Staggered a minute apart, oldest first, so "newest" and "trending" have
    // a stable order to produce instead of an arbitrary one. All identical
    // timestamps would make the front page reshuffle on every read.
    const createdAt = new Date(base - (PROMPTS.length - i) * 60000).toISOString();
    const fields = {
      title: p.title,
      body: p.body,
      summary: p.summary,
      platforms: p.platforms,
      models: [],
      category: p.category,
      tags: p.tags,
      variables: extractVariables(p.body),
      visibility: 'public',
      authorId,
      authorName: SEED_AUTHOR_NAME,
      // No invented engagement. A seeded prompt with 40 upvotes nobody cast
      // would be a lie on the one surface the app is asking people to trust.
      score: 0, upvotes: 0, downvotes: 0,
      copyCount: 0, saveCount: 0, remixCount: 0, viewCount: 0,
      remixOf: null,
      seeded: true,
      createdAt,
      updatedAt: createdAt,
    };
    fields.trendScore = computeTrend(fields, base);
    return fields;
  });
}

/**
 * Write them, once, ever. Returns what happened rather than throwing: a
 * failure to stock the shelf must not stop the app from serving, and a cold
 * start that cannot reach Firestore is a problem the request path will report
 * far more clearly than a crash at boot.
 */
async function ensureSeeded(db, opts) {
  const o = opts || {};
  const authorId = o.authorId || RESERVED_AUTHOR_ID;
  const marker = db.collection('control').doc('seed');
  try {
    // create() is the lock. Two instances booting at once both try; one wins,
    // the loser gets ALREADY_EXISTS and stops. A plain get-then-set would let
    // both through and double the library.
    await marker.create({ at: new Date().toISOString(), count: PROMPTS.length, authorId });
  } catch (e) {
    if (e && e.code === 6) return { seeded: false, reason: 'already-seeded' };
    console.error('seed: could not claim the marker', e);
    return { seeded: false, reason: 'error' };
  }
  try {
    const docs = seedDocuments(authorId);
    const batch = db.batch();
    docs.forEach((d) => batch.set(db.collection('prompts').doc(), d));
    await batch.commit();
    return { seeded: true, count: docs.length };
  } catch (e) {
    // The marker is claimed but nothing was written, which would leave the
    // library empty forever. Give the claim back so the next boot can retry.
    console.error('seed: write failed, releasing the marker', e);
    try { await marker.delete(); } catch (e2) { /* nothing better to do */ }
    return { seeded: false, reason: 'error' };
  }
}

module.exports = { PROMPTS, SEED_AUTHOR_NAME, RESERVED_AUTHOR_ID, seedDocuments, ensureSeeded };
