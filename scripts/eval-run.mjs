import fs from 'node:fs';
import path from 'node:path';

const baseUrl = (process.env.BASE_URL ?? 'http://localhost:5177').toString().trim();
const goldenPath = path.resolve(process.cwd(), 'scripts', 'eval', 'golden.json');
const golden = JSON.parse(fs.readFileSync(goldenPath, 'utf-8'));

const fetchJson = async (url, opts) => {
  const r = await fetch(url, opts);
  const text = await r.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }
  return { ok: r.ok, status: r.status, data };
};

function includesAny(hay, needles) {
  const h = (hay ?? '').toString();
  for (const n of needles ?? []) {
    if (!n) continue;
    if (h.includes(n)) return true;
  }
  return false;
}

function rankOf(items, predicate) {
  for (let i = 0; i < items.length; i += 1) {
    if (predicate(items[i])) return i + 1; // 1-based
  }
  return null;
}

function mrrFromRanks(ranks) {
  const rr = ranks
    .filter((r) => Number.isFinite(r) && r > 0)
    .map((r) => 1 / r);
  if (rr.length === 0) return 0;
  return rr.reduce((a, b) => a + b, 0) / rr.length;
}

function recallAtK(hits, total) {
  if (!total) return 0;
  return Math.max(0, Math.min(1, hits / total));
}

async function evalNotesSearch(cases) {
  let pass = 0;
  let fail = 0;
  const ranks = [];
  for (const c of cases ?? []) {
    const q = (c?.q ?? '').toString().trim();
    const k = Number(c?.k ?? 10) || 10;
    const url = new URL('/api/notes', baseUrl);
    url.searchParams.set('q', q);
    url.searchParams.set('limit', String(k));
    const { ok, status, data } = await fetchJson(url.toString());
    const items = Array.isArray(data?.items) ? data.items : [];

    let okCase = ok && items.length > 0;
    if (okCase && Array.isArray(c?.expect_any_note_title_includes)) {
      okCase = items.some((it) => includesAny(it?.title, c.expect_any_note_title_includes));
    }
    if (okCase && Array.isArray(c?.expect_any_note_ids) && c.expect_any_note_ids.length) {
      okCase = items.some((it) => (c.expect_any_note_ids ?? []).includes((it?.id ?? '').toString()));
    }

    // Metrics (optional): record rank if we have an expected id/title hint.
    let rnk = null;
    if (Array.isArray(c?.expect_any_note_ids) && c.expect_any_note_ids.length) {
      rnk = rankOf(items, (it) => (c.expect_any_note_ids ?? []).includes((it?.id ?? '').toString()));
    } else if (Array.isArray(c?.expect_any_note_title_includes) && c.expect_any_note_title_includes.length) {
      rnk = rankOf(items, (it) => includesAny(it?.title, c.expect_any_note_title_includes));
    }
    if (rnk) ranks.push(rnk);

    const optional = !!c?.optional;
    if (okCase) pass += 1;
    else if (!optional) fail += 1;

    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify(
        {
          suite: 'notes_search',
          name: c?.name ?? q,
          q,
          http_ok: ok,
          status,
          got: items.slice(0, 3).map((x) => ({ id: x.id, title: x.title, status: x.status })),
          rank: rnk,
          result: okCase ? 'pass' : optional ? 'skip' : 'fail'
        },
        null,
        2
      )
    );
  }
  return { pass, fail, mrr: mrrFromRanks(ranks) };
}

async function evalSemanticSearch(cases) {
  let pass = 0;
  let fail = 0;
  const ranks = [];
  for (const c of cases ?? []) {
    const q = (c?.q ?? '').toString().trim();
    const k = Number(c?.k ?? 10) || 10;
    const url = new URL('/api/semantic', baseUrl);
    url.searchParams.set('q', q);
    url.searchParams.set('k', String(k));
    const { ok, status, data } = await fetchJson(url.toString());
    const items = Array.isArray(data?.items) ? data.items : [];
    let okCase = ok && items.length > 0;
    if (okCase && Array.isArray(c?.expect_any_note_ids) && c.expect_any_note_ids.length) {
      okCase = items.some((it) => (c.expect_any_note_ids ?? []).includes((it?.id ?? '').toString()));
    }

    let rnk = null;
    if (Array.isArray(c?.expect_any_note_ids) && c.expect_any_note_ids.length) {
      rnk = rankOf(items, (it) => (c.expect_any_note_ids ?? []).includes((it?.id ?? '').toString()));
    }
    if (rnk) ranks.push(rnk);

    const optional = !!c?.optional;
    if (okCase) pass += 1;
    else if (!optional) fail += 1;

    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify(
        {
          suite: 'semantic_search',
          name: c?.name ?? q,
          q,
          http_ok: ok,
          status,
          got: items.slice(0, 3).map((x) => ({
            id: x.id,
            title: x.title,
            matches: (x.matches ?? []).slice(0, 1)
          })),
          rank: rnk,
          result: okCase ? 'pass' : optional ? 'skip' : 'fail'
        },
        null,
        2
      )
    );
  }
  return { pass, fail, mrr: mrrFromRanks(ranks) };
}

const main = async () => {
  const health = await fetchJson(new URL('/api/health', baseUrl).toString());
  if (!health.ok) {
    // eslint-disable-next-line no-console
    console.error('Server not reachable at', baseUrl);
    process.exit(2);
  }

  const r1 = await evalNotesSearch(golden.notes_search);
  const r2 = await evalSemanticSearch(golden.semantic_search);

  const pass = r1.pass + r2.pass;
  const fail = r1.fail + r2.fail;
  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify(
      {
        baseUrl,
        pass,
        fail,
        metrics: {
          notes_search_mrr: r1.mrr,
          semantic_search_mrr: r2.mrr
        }
      },
      null,
      2
    )
  );
  process.exit(fail ? 1 : 0);
};

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e);
  process.exit(2);
});

