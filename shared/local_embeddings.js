const DEFAULT_LOCAL_EMBEDDING_MODEL =
  process.env.FAQ_LOCAL_EMBEDDING_MODEL || "BAAI/bge-small-en-v1.5";

const extractorPromiseByModel = new Map();

async function getExtractor(model = DEFAULT_LOCAL_EMBEDDING_MODEL) {
  const resolvedModel = String(model || DEFAULT_LOCAL_EMBEDDING_MODEL).trim() || DEFAULT_LOCAL_EMBEDDING_MODEL;

  if (!extractorPromiseByModel.has(resolvedModel)) {
    const promise = import("@huggingface/transformers")
      .then(({ pipeline }) =>
        pipeline("feature-extraction", resolvedModel, {
          dtype: "fp32"
        })
      )
      .catch((error) => {
        extractorPromiseByModel.delete(resolvedModel);
        throw error;
      });

    extractorPromiseByModel.set(resolvedModel, promise);
  }

  return extractorPromiseByModel.get(resolvedModel);
}

export async function embedTexts(texts, options = {}) {
  const model = String(options.model || DEFAULT_LOCAL_EMBEDDING_MODEL).trim() || DEFAULT_LOCAL_EMBEDDING_MODEL;
  const input = Array.isArray(texts) ? texts.map((text) => String(text ?? "")) : [String(texts ?? "")];
  const extractor = await getExtractor(model);
  const output = await extractor(input, {
    pooling: "mean",
    normalize: true
  });

  return typeof output?.tolist === "function" ? output.tolist() : [];
}

export function getDefaultLocalEmbeddingModel() {
  return DEFAULT_LOCAL_EMBEDDING_MODEL;
}
