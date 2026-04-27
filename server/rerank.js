import { pipeline } from '@xenova/transformers';

let _pipePromise = null;

async function getPipeline(model) {
  if (!_pipePromise) {
    _pipePromise = pipeline('text-classification', model, {
      quantized: true
    });
  }
  return _pipePromise;
}

// Cross-encoder rerank: scores (query, passage) pairs.
// This is optional and can be slow on CPU; keep candidate count small.
export async function crossEncoderRerank(query, passages, { model } = {}) {
  const q = (query ?? '').toString().trim();
  const arr = Array.isArray(passages) ? passages : [];
  if (!q || arr.length === 0) return arr.map(() => 0);

  const m = (model ?? '').toString().trim() || 'Xenova/ms-marco-MiniLM-L-6-v2';
  const pipe = await getPipeline(m);

  const pairs = arr.map((p) => ({
    text: q,
    text_pair: (p ?? '').toString()
  }));

  const out = await pipe(pairs, {
    // Keep deterministic.
    topk: 1
  });

  const scores = [];
  for (const r of out) {
    // transformers.js returns either {label,score} or [{label,score}]
    const one = Array.isArray(r) ? r[0] : r;
    const s = Number(one?.score);
    scores.push(Number.isFinite(s) ? s : 0);
  }
  return scores;
}

