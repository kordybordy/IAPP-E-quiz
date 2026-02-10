const DEFAULT_CONFIG = {
  generatorModel: "gpt-4.1-mini",
  verifierModel: "gpt-4.1-mini",
  embeddingModel: "text-embedding-3-small",
  temperature: 0.2,
  maxOutputTokens: 700,
  overlapThreshold: 0.25,
  similarity: {
    duplicateThreshold: 0.92,
    tooFarThreshold: 0.55,
    targetMin: 0.65,
    targetMax: 0.85,
    topK: 5,
    semanticAttempts: 3
  },
  retry: {
    maxAttempts: 4,
    baseDelayMs: 300
  }
};

const responseSchema = {
  name: "gdpr_question",
  schema: {
    type: "object",
    additionalProperties: false,
    required: [
      "language",
      "article_ref",
      "question",
      "choices",
      "correct_label",
      "rationale_short",
      "difficulty",
      "tags",
      "needs_human_review"
    ],
    properties: {
      language: { type: "string", enum: ["pl", "en"] },
      article_ref: { type: "string" },
      question: { type: "string", minLength: 12, maxLength: 600 },
      choices: {
        type: "array",
        minItems: 4,
        maxItems: 4,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["label", "text"],
          properties: {
            label: { type: "string", enum: ["A", "B", "C", "D"] },
            text: { type: "string", minLength: 1, maxLength: 300 }
          }
        }
      },
      correct_label: { type: "string", enum: ["A", "B", "C", "D"] },
      rationale_short: { type: "string", minLength: 10, maxLength: 600 },
      difficulty: { type: "integer", minimum: 1, maximum: 5 },
      tags: {
        type: "array",
        minItems: 1,
        items: { type: "string", minLength: 2, maxLength: 40 }
      },
      needs_human_review: { type: "boolean" }
    }
  }
};

const verifierSchema = {
  name: "gdpr_verification",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["ok", "issues", "needs_human_review"],
    properties: {
      ok: { type: "boolean" },
      issues: {
        type: "array",
        items: { type: "string" }
      },
      needs_human_review: { type: "boolean" }
    }
  }
};

export function normalizeText(input) {
  return String(input || "")
    .toLowerCase()
    .replace(/ł/g, "l")
    .replace(/ß/g, "ss")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function detectLanguage(paragraph, fallback = "pl") {
  const text = normalizeText(paragraph);
  if (!text) return fallback;
  const polishMarkers = /(ktor|ktora|ktore|administrator|podmiot|danych|przetwarzani|zgod|obowiazk|wyjatek|prawo)/;
  const englishMarkers = /(which|controller|processor|lawful|processing|obligation|rights|data subject|transfer)/;
  if (polishMarkers.test(text)) return "pl";
  if (englishMarkers.test(text)) return "en";
  return fallback;
}

export function tagParagraphTopic(paragraph) {
  const text = normalizeText(paragraph);
  const rules = [
    { tag: "rights", re: /\b(prawo|rights?|data subject|sprzeciw|dostep|usuniecie|portability|rectification)\b/ },
    { tag: "obligations", re: /\b(obowiazk|obligation|controller|administrator|informacyjn|accountability)\b/ },
    { tag: "definitions", re: /\b(definicj|means|oznacza|identifiable|pseudonymi[sz]acj)\b/ },
    { tag: "transfers", re: /\b(transfer|third country|panstw trzecich|scc|adequacy|przekazywan)\b/ },
    { tag: "legal_basis", re: /\b(zgoda|consent|legal basis|uzasadnion|contract|obowiazek prawny)\b/ },
    { tag: "security", re: /\b(security|naruszen|breach|integrity|confidentiality|bezpieczenst)\b/ }
  ];

  const tags = rules.filter((rule) => rule.re.test(text)).map((rule) => rule.tag);
  return tags.length ? tags : ["general_gdpr"];
}

export function ngramOverlap(a, b, n = 5) {
  const na = normalizeText(a);
  const nb = normalizeText(b);
  if (!na || !nb) return 0;

  const tokensA = na.split(" ");
  const tokensB = nb.split(" ");
  if (tokensA.length < n || tokensB.length < n) return 0;

  const gramsA = new Set();
  for (let i = 0; i <= tokensA.length - n; i += 1) {
    gramsA.add(tokensA.slice(i, i + n).join(" "));
  }

  const gramsB = new Set();
  for (let i = 0; i <= tokensB.length - n; i += 1) {
    gramsB.add(tokensB.slice(i, i + n).join(" "));
  }

  let intersection = 0;
  for (const g of gramsA) {
    if (gramsB.has(g)) intersection += 1;
  }

  return intersection / Math.max(gramsA.size, 1);
}

export function cosineSimilarity(a = [], b = []) {
  if (!a.length || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] ** 2;
    normB += b[i] ** 2;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom ? dot / denom : 0;
}

export function validateChoiceIntegrity(question) {
  if (!question || !Array.isArray(question.choices)) return { ok: false, reason: "choices_missing" };
  if (question.choices.length !== 4) return { ok: false, reason: "choices_count" };

  const labels = question.choices.map((c) => c.label);
  const texts = question.choices.map((c) => normalizeText(c.text));

  if (new Set(labels).size !== 4) return { ok: false, reason: "duplicate_labels" };
  if (new Set(texts).size !== 4) return { ok: false, reason: "duplicate_choice_texts" };
  if (!labels.includes(question.correct_label)) return { ok: false, reason: "correct_label_not_in_choices" };

  return { ok: true };
}

export function estimateDifficulty(questionText, choices) {
  const text = `${questionText} ${(choices || []).map((c) => c.text).join(" ")}`;
  const normalized = normalizeText(text);
  const len = normalized.length;

  let score = 1;
  if (len > 180) score += 1;
  if (len > 320) score += 1;
  if (/\b(not|except|nie|z wyjatkiem|ktore z ponizszych nie)\b/.test(normalized)) score += 1;
  if (/\b(scenario|przypadek|sytuacja|administrator|podmiot)\b/.test(normalized)) score += 1;

  return Math.min(score, 5);
}

export function decideSimilarityAction(maxCosine, cfg = DEFAULT_CONFIG.similarity) {
  if (maxCosine > cfg.duplicateThreshold) {
    return { action: "reject", reason: "too_similar_duplicate" };
  }
  if (maxCosine < cfg.tooFarThreshold) {
    return { action: "revise", reason: "too_distant_from_bank_style" };
  }
  if (maxCosine < cfg.targetMin || maxCosine > cfg.targetMax) {
    return { action: "revise", reason: "outside_target_similarity_window" };
  }
  return { action: "accept", reason: "within_target_similarity_window" };
}

function hashInput(input) {
  const raw = JSON.stringify(input);
  let hash = 0;
  for (let i = 0; i < raw.length; i += 1) {
    hash = (hash << 5) - hash + raw.charCodeAt(i);
    hash |= 0;
  }
  return String(hash);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRetry(fn, retryConfig) {
  const { maxAttempts, baseDelayMs } = retryConfig;
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const status = error?.status;
      const retryable = status === 429 || status === 503 || error?.retryable;
      if (!retryable || attempt === maxAttempts) break;
      const jitter = Math.floor(Math.random() * 120);
      await sleep(baseDelayMs * 2 ** (attempt - 1) + jitter);
    }
  }
  throw lastError;
}

async function callOpenAI({ apiKey, model, temperature, maxOutputTokens, input, extraBody = {} }) {
  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      temperature,
      max_output_tokens: maxOutputTokens,
      input,
      ...extraBody
    })
  });

  if (!res.ok) {
    const error = new Error(`OpenAI error: ${res.status}`);
    error.status = res.status;
    error.retryable = res.status === 429 || res.status === 503;
    throw error;
  }

  const data = await res.json();
  const output = data?.output?.[0]?.content?.[0]?.text;
  if (!output) {
    throw new Error("Missing JSON output from OpenAI Responses API");
  }

  return JSON.parse(output);
}

async function embedTexts({ apiKey, model, texts }) {
  if (!Array.isArray(texts) || !texts.length) return [];
  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      input: texts
    })
  });
  if (!res.ok) {
    const error = new Error(`Embeddings error: ${res.status}`);
    error.status = res.status;
    error.retryable = res.status === 429 || res.status === 503;
    throw error;
  }
  const data = await res.json();
  return (data?.data || []).map((item) => item.embedding);
}

export class AIQuestionService {
  constructor({ apiKey, cache = new Map(), config = {} }) {
    if (!apiKey) throw new Error("Missing OPENAI_API_KEY");
    this.apiKey = apiKey;
    this.cache = cache;
    this.config = {
      ...DEFAULT_CONFIG,
      ...config,
      similarity: { ...DEFAULT_CONFIG.similarity, ...(config.similarity || {}) },
      retry: { ...DEFAULT_CONFIG.retry, ...(config.retry || {}) }
    };
  }

  async generateFromParagraph({ paragraph, language = "pl", articleRef = "", existingQuestions = [] }) {
    const detectedLanguage = detectLanguage(paragraph, language);
    const paragraphTags = tagParagraphTopic(paragraph);
    const input = { paragraph, detectedLanguage, articleRef, paragraphTags };
    const cacheKey = hashInput(input);
    if (this.cache.has(cacheKey)) return this.cache.get(cacheKey);

    let lastError = null;
    for (let i = 0; i < this.config.similarity.semanticAttempts; i += 1) {
      try {
        const generated = await withRetry(() => this.generateCandidate(input), this.config.retry);
        const validated = this.postValidate(generated, paragraph, paragraphTags);
        const verified = await withRetry(() => this.verifyCandidate(paragraph, validated), this.config.retry);
        if (!verified.ok) {
          throw new Error(`Verification failed: ${(verified.issues || []).join("; ") || "unknown"}`);
        }

        const similarity = await withRetry(
          () => this.assessSimilarity(validated.question, existingQuestions),
          this.config.retry
        );

        const result = {
          ...validated,
          verification: verified,
          overlap_score: ngramOverlap(paragraph, validated.question, 5),
          similarity
        };

        if (similarity.action === "accept") {
          this.cache.set(cacheKey, result);
          return result;
        }
        if (similarity.action === "reject") {
          throw new Error(`Similarity rejected: ${similarity.reason}`);
        }

        lastError = new Error(`Similarity revise: ${similarity.reason}`);
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError || new Error("Unable to generate question in similarity window");
  }

  async generateCandidate({ paragraph, detectedLanguage, articleRef, paragraphTags }) {
    return callOpenAI({
      apiKey: this.apiKey,
      model: this.config.generatorModel,
      temperature: this.config.temperature,
      maxOutputTokens: this.config.maxOutputTokens,
      input: [
        {
          role: "system",
          content:
            "Tworzysz pytania jednokrotnego wyboru A-D z fragmentu RODO. Nie kopiuj zdań 1:1. Jedna odpowiedź poprawna, 3 wiarygodne dystraktory. Zakaz pytań o pojedyncze słowo i o wyjątki spoza fragmentu. Poziom średni jak bank egzaminacyjny."
        },
        {
          role: "user",
          content: JSON.stringify({
            language: detectedLanguage,
            article_ref: articleRef,
            paragraph_tags: paragraphTags,
            paragraph
          })
        }
      ],
      extraBody: {
        text: {
          format: {
            type: "json_schema",
            name: responseSchema.name,
            schema: responseSchema.schema,
            strict: true
          }
        }
      }
    });
  }

  postValidate(candidate, paragraph, paragraphTags) {
    const integrity = validateChoiceIntegrity(candidate);
    if (!integrity.ok) {
      throw new Error(`Choice integrity failed: ${integrity.reason}`);
    }

    const overlap = ngramOverlap(paragraph, candidate.question, 5);
    if (overlap > this.config.overlapThreshold) {
      throw new Error(`Question too close to source paragraph (overlap=${overlap.toFixed(3)})`);
    }

    const heuristicDifficulty = estimateDifficulty(candidate.question, candidate.choices);
    if (heuristicDifficulty < 2 || candidate.difficulty < 2) {
      throw new Error("Question difficulty too low");
    }

    const normalizedQuestion = normalizeText(candidate.question);
    if (/\b(co oznacza|jaki wyraz|ktore slowo)\b/.test(normalizedQuestion)) {
      throw new Error("Question too lexical/trivial");
    }

    return {
      ...candidate,
      tags: Array.from(new Set([...(candidate.tags || []), ...paragraphTags]))
    };
  }

  async verifyCandidate(paragraph, candidate) {
    return callOpenAI({
      apiKey: this.apiKey,
      model: this.config.verifierModel,
      temperature: 0,
      maxOutputTokens: 300,
      input: [
        {
          role: "system",
          content:
            "You are a strict legal verifier. Check only against the provided paragraph. Confirm one correct answer, three incorrect distractors, no external assumptions and no trivial copy."
        },
        {
          role: "user",
          content: JSON.stringify({ paragraph, candidate })
        }
      ],
      extraBody: {
        text: {
          format: {
            type: "json_schema",
            name: verifierSchema.name,
            schema: verifierSchema.schema,
            strict: true
          }
        }
      }
    });
  }

  async assessSimilarity(questionText, existingQuestions) {
    const bankTexts = (existingQuestions || [])
      .map((q) => (typeof q === "string" ? q : q?.question || q?.text || ""))
      .map((t) => String(t).trim())
      .filter(Boolean)
      .slice(0, 400);

    if (!bankTexts.length) {
      return {
        action: "accept",
        reason: "bank_missing_skip_similarity",
        max_cosine_to_any_existing: null,
        top_matches: []
      };
    }

    const embeddings = await embedTexts({
      apiKey: this.apiKey,
      model: this.config.embeddingModel,
      texts: [questionText, ...bankTexts]
    });
    const [questionEmbedding, ...bankEmbeddings] = embeddings;
    const scored = bankEmbeddings.map((embedding, idx) => ({
      text: bankTexts[idx],
      cosine: cosineSimilarity(questionEmbedding, embedding)
    }));
    scored.sort((a, b) => b.cosine - a.cosine);
    const topMatches = scored.slice(0, this.config.similarity.topK);
    const maxCosine = topMatches[0]?.cosine ?? 0;
    const decision = decideSimilarityAction(maxCosine, this.config.similarity);

    return {
      ...decision,
      max_cosine_to_any_existing: maxCosine,
      top_matches: topMatches
    };
  }
}
