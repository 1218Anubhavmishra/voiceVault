let _embedder = null;

export const DEFAULT_EMBED_MODEL = 'Xenova/all-MiniLM-L6-v2';

export async function embedTexts(texts, { model = DEFAULT_EMBED_MODEL } = {}) {
  const arr = Array.isArray(texts) ? texts : [];
  if (arr.length === 0) return [];
  const embedder = await getEmbedder(model);

  // Run one-by-one to keep memory predictable on Windows.
  const out = [];
  for (const t of arr) {
    const s = (t ?? '').toString();
    // feature-extraction returns [tokens, dims] or similar; use mean pooling.
    const r = await embedder(s, { pooling: 'mean', normalize: true });
    // Xenova returns a Tensor-like with .data (TypedArray)
    const vec = r?.data;
    out.push(vec ? Float32Array.from(vec) : new Float32Array());
  }
  return out;
}

async function getEmbedder(model) {
  if (_embedder && _embedder.modelId === model) return _embedder.fnPromise;
  const fnPromise = (async () => {
    const { pipeline, env } = await import('@xenova/transformers');
    // Docker bakes the model into this dir at build time so restarts don't re-download it.
    const cacheDir = (process.env.VOICEVAULT_MODEL_CACHE_DIR ?? '').toString().trim();
    if (cacheDir) env.cacheDir = cacheDir;
    return pipeline('feature-extraction', model);
  })();
  _embedder = { modelId: model, fnPromise };
  try {
    return await fnPromise;
  } catch (e) {
    if (_embedder?.fnPromise === fnPromise) _embedder = null;
    throw e;
  }
}

/** Load the embedding model (and download it if not cached) so the first search doesn't pay for it. */
export async function warmupEmbedder(model = DEFAULT_EMBED_MODEL) {
  const embedder = await getEmbedder(model);
  await embedder('warmup', { pooling: 'mean', normalize: true });
}

export function float32ToBuffer(vec) {
  if (!vec || vec.byteLength === 0) return Buffer.alloc(0);
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

export function bufferToFloat32(buf) {
  if (!buf || !Buffer.isBuffer(buf) || buf.length === 0) return new Float32Array();
  // Copy to an aligned ArrayBuffer
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return new Float32Array(ab);
}

export function cosineSim(a, b) {
  const n = Math.min(a?.length ?? 0, b?.length ?? 0);
  if (n === 0) return 0;
  let dot = 0;
  let aa = 0;
  let bb = 0;
  for (let i = 0; i < n; i += 1) {
    const x = a[i];
    const y = b[i];
    dot += x * y;
    aa += x * x;
    bb += y * y;
  }
  if (aa === 0 || bb === 0) return 0;
  return dot / (Math.sqrt(aa) * Math.sqrt(bb));
}

