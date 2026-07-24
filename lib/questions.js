/**
 * Question generation for Human Bingo squares, via the Groq API.
 *
 * Every player gets a completely different set of traits, so a room of P players
 * on an N x N grid needs P * N * N unique statements. We fan those out across
 * parallel Groq calls, dedupe globally, and top up if a batch comes back short.
 */

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const BATCH_SIZE = 20;
const MAX_ROUNDS = 3;

export const CATEGORIES = {
  hobbies: 'hobbies, sports and pastimes',
  personality: 'personality traits, habits and daily routines',
  travel: 'travel, places lived and languages',
  food: 'food, drink and cooking preferences',
  skills: 'skills, talents and things they can do',
  quirky: 'quirky, surprising or funny personal facts',
};

/** Emergency pool used only if Groq is unreachable, so a room never dies mid-start. */
const FALLBACK_BANK = [
  'Plays a musical instrument', 'Has visited more than 3 countries', 'Speaks 3+ languages',
  'Can solve a Rubik\'s cube', 'Has a pet cat', 'Has a pet dog', 'Is an early riser',
  'Drinks coffee every morning', 'Prefers tea over coffee', 'Has run a 10K',
  'Can whistle a tune', 'Has been skydiving', 'Bakes their own bread', 'Grows houseplants',
  'Has a tattoo', 'Reads more than one book a month', 'Watches horror movies alone',
  'Has broken a bone', 'Can drive a manual car', 'Has camped in the wild',
  'Plays video games weekly', 'Has done karaoke in public', 'Knows how to knit or sew',
  'Has lived in another city', 'Is left-handed', 'Has a sibling twin', 'Loves spicy food',
  'Is vegetarian or vegan', 'Has cooked for more than 10 people', 'Can do a cartwheel',
  'Has met someone famous', 'Collects something unusual', 'Has climbed a mountain',
  'Rides a bike to work', 'Has swum in the ocean this year', 'Can juggle',
  'Has written a poem', 'Plays chess', 'Has been on live TV or radio', 'Draws or paints',
  'Has a middle name they dislike', 'Sings in the shower', 'Has hiked over 10km in a day',
  'Takes photos as a hobby', 'Has built something from wood', 'Enjoys puzzles or sudoku',
  'Has been scuba diving', 'Owns more than 50 books', 'Has volunteered for a charity',
  'Can touch their toes', 'Has fallen asleep in a cinema', 'Supports a sports team',
  'Has moved house 5+ times', 'Learned something new this month', 'Dances at parties',
  'Has a podcast they never miss', 'Prefers mountains over beaches', 'Has been surfing',
  'Can name 10 countries in Africa', 'Has kept a diary', 'Is the eldest child',
  'Has stayed up all night working', 'Enjoys cooking from scratch', 'Has a nickname',
];

const norm = (s) =>
  String(s).toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();

/**
 * Exact-match dedupe is not enough: the model happily returns both "Can swim" and
 * "Can swim laps", which look silly sitting on the same card. Treat one trait as a
 * duplicate of another when either fully contains the other.
 */
function isDuplicate(key, seen) {
  if (seen.has(key)) return true;
  for (const existing of seen) {
    if (existing.includes(key) || key.includes(existing)) return true;
  }
  return false;
}

const SYSTEM_PROMPT = `You write squares for a "Human Bingo" icebreaker game.

Each square is a short statement about a PERSON. Players walk around and must find another
person in the room that the statement is true about.

Rules for every statement you write:
- Start with a verb in third person: "Plays...", "Has...", "Can...", "Speaks...", "Prefers...".
- Maximum 55 characters. Short and scannable.
- Must be verifiable by simply asking someone. No opinions, no maths, no trivia questions.
- Common enough that in a group of ~15 people at least one person matches, but not so common
  that everyone matches (avoid "Has a phone", "Drinks water").
- Safe for any workplace or classroom: nothing about religion, politics, sex, health
  conditions, income, or appearance.
- Never repeat an idea you have already written in this response, and never write two
  statements about the same activity ("Can swim" and "Can swim laps" is a mistake).
- Be specific. A statement that needs a detail to be true is far more fun than a vague one.

Good: "Has run a half marathon", "Speaks three languages", "Has lived abroad for a year",
      "Can solve a Rubik's cube in under a minute", "Has broken a bone skiing"
Weak: "Can cook", "Watches TV", "Likes music", "Has a phone" - almost everyone matches these,
      so they make the game boring. Never write squares like that.

Reply with JSON only, in the form: {"traits": ["Plays a musical instrument", "..."]}`;

const ANGLES = [
  'Lean towards everyday routines and small habits.',
  'Lean towards things a person has done at least once in their life.',
  'Lean towards abilities and things a person can physically do.',
  'Lean towards tastes and preferences that split a group roughly in half.',
  'Lean towards childhood or past experiences.',
  'Lean towards mildly unusual facts that make a good story.',
];

function buildUserPrompt(count, { categories, theme, avoid, angleIndex }) {
  const cats = (categories || []).map((c) => CATEGORIES[c]).filter(Boolean);
  const lines = [`Write exactly ${count} different Human Bingo squares.`];

  if (cats.length) lines.push(`Spread them across these topics: ${cats.join('; ')}.`);
  else lines.push('Spread them across hobbies, personality, travel, food, skills and quirky facts.');

  if (theme) {
    lines.push(
      `The group playing is: "${theme}". Tailor the squares to that group so they feel personal ` +
        `and recognisable, while staying easy to answer.`
    );
  }

  lines.push(ANGLES[angleIndex % ANGLES.length]);

  if (avoid && avoid.length) {
    // Only the tail matters - it keeps the model from repeating the most recent batches.
    const sample = avoid.slice(-60);
    lines.push(`Do NOT reuse or reword any of these already-used squares:\n- ${sample.join('\n- ')}`);
  }

  return lines.join('\n\n');
}

async function callGroq(count, opts) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error('GROQ_API_KEY is not set');

  const model = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);

  try {
    const res = await fetch(GROQ_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature: 1.1,
        top_p: 0.95,
        max_tokens: 2048,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: buildUserPrompt(count, opts) },
        ],
      }),
    });

    if (!res.ok) {
      throw new Error(`Groq responded ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }

    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content ?? '{}';
    const parsed = JSON.parse(content);
    const list = Array.isArray(parsed) ? parsed : parsed.traits || parsed.squares || parsed.questions;

    if (!Array.isArray(list)) throw new Error('Groq returned no traits array');

    return list
      .filter((t) => typeof t === 'string')
      .map((t) => t.trim().replace(/^[-*\d.\s]+/, '').replace(/\s+/g, ' '))
      .filter((t) => t.length >= 8 && t.length <= 80);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Produce `count` distinct trait statements.
 * Returns { traits, degraded } - degraded is true if the fallback bank had to be used.
 */
export async function generateTraits(count, { categories = [], theme = '', exclude = [] } = {}) {
  const seen = new Set(exclude.map(norm));
  const traits = [];
  let degraded = false;
  let angle = 0;

  const accept = (list) => {
    for (const t of list) {
      const key = norm(t);
      if (!key || isDuplicate(key, seen)) continue;
      seen.add(key);
      traits.push(t);
    }
  };

  const hasKey = Boolean(process.env.GROQ_API_KEY);
  if (!hasKey) {
    console.warn('[groq] GROQ_API_KEY is not set - serving squares from the built-in bank');
  }

  for (let round = 0; hasKey && round < MAX_ROUNDS && traits.length < count; round++) {
    const missing = count - traits.length;
    // Over-request a little: dedupe always eats a few.
    const target = Math.ceil(missing * 1.25) + 4;
    const batches = Math.max(1, Math.ceil(target / BATCH_SIZE));
    const per = Math.ceil(target / batches);

    const results = await Promise.allSettled(
      Array.from({ length: batches }, (_, i) =>
        callGroq(per, { categories, theme, avoid: traits, angleIndex: angle + i })
      )
    );
    angle += batches;

    let anyOk = false;
    for (const r of results) {
      if (r.status === 'fulfilled') {
        anyOk = true;
        accept(r.value);
      } else {
        console.error('[groq] batch failed:', r.reason?.message || r.reason);
      }
    }

    if (!anyOk && round === MAX_ROUNDS - 1) break;
  }

  if (traits.length < count) {
    degraded = true;
    console.warn(
      `[groq] only produced ${traits.length}/${count} traits - padding from the built-in bank`
    );
    const bank = [...FALLBACK_BANK].sort(() => Math.random() - 0.5);
    for (const t of bank) {
      if (traits.length >= count) break;
      const key = norm(t);
      if (isDuplicate(key, seen)) continue;
      seen.add(key);
      traits.push(t);
    }
    // Absolute last resort: recycle so a board is never short of squares.
    let i = 0;
    while (traits.length < count) traits.push(FALLBACK_BANK[i++ % FALLBACK_BANK.length]);
  }

  return { traits: traits.slice(0, count), degraded };
}
