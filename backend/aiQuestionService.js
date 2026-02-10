const DEFAULT_CONFIG = {
  generatorModel: "gpt-4.1-mini",
  verifierModel: "gpt-4.1-mini",
  temperature: 0.1,
  maxOutputTokens: 700,
  overlapThreshold: 0.25,
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
    required: ["language", "article_ref", "question", "choices", "correct_label", "rationale", "difficulty"],
    properties: {
      language: { type: "string", enum: ["pl", "en"] },
      article_ref: { type: "string", minLength: 1 },
      question: { type: "string", minLength: 5, maxLength: 600 },
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
      rationale: { type: "string", minLength: 10, maxLength: 1500 },
      difficulty: { type: "integer", minimum: 1, maximum: 5 }
    }
  }
};

const verifierSchema = {
  name: "gdpr_verification",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["is_grounded", "all_distractors_incorrect", "is_not_trivial_copy", "notes"],
    properties: {
      is_grounded: { type: "boolean" },
      all_distractors_incorrect: { type: "boolean" },
      is_not_trivial_copy: { type: "boolean" },
      notes: { type: "string" }
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

async function callOpenAI({ apiKey, model, temperature, maxOutputTokens, messages, jsonSchema }) {
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
      input: messages,
      text: {
        format: {
          type: "json_schema",
          name: jsonSchema.name,
          schema: jsonSchema.schema,
          strict: true
        }
      }
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

export class AIQuestionService {
  constructor({ apiKey, cache = new Map(), config = {} }) {
    if (!apiKey) throw new Error("Missing OPENAI_API_KEY");
    this.apiKey = apiKey;
    this.cache = cache;
    this.config = { ...DEFAULT_CONFIG, ...config, retry: { ...DEFAULT_CONFIG.retry, ...(config.retry || {}) } };
  }

  async generateFromParagraph({ paragraph, language = "pl", articleRef = "" }) {
    const input = { paragraph, language, articleRef };
    const cacheKey = hashInput(input);
    if (this.cache.has(cacheKey)) return this.cache.get(cacheKey);

    const generated = await withRetry(() => this.generateCandidate(input), this.config.retry);
    const validated = this.postValidate(generated, paragraph);
    const verified = await withRetry(() => this.verifyCandidate(paragraph, validated), this.config.retry);

    if (!verified.is_grounded || !verified.all_distractors_incorrect || !verified.is_not_trivial_copy) {
      throw new Error(`Verification failed: ${verified.notes}`);
    }

    const result = { ...validated, verification: verified, overlap_score: ngramOverlap(paragraph, validated.question, 5) };
    this.cache.set(cacheKey, result);
    return result;
  }

  async generateCandidate({ paragraph, language, articleRef }) {
    return callOpenAI({
      apiKey: this.apiKey,
      model: this.config.generatorModel,
      temperature: this.config.temperature,
      maxOutputTokens: this.config.maxOutputTokens,
      jsonSchema: responseSchema,
      messages: [
        {
          role: "system",
          content:
            "You generate GDPR multiple-choice questions. Use only the provided paragraph as ground truth. Do not introduce external legal facts. Provide 4 options A-D, exactly one correct answer, and rationale for audit. Avoid copying sentences verbatim."
        },
        {
          role: "user",
          content: JSON.stringify({
            task: "Generate one MCQ in structured JSON.",
            constraints: {
              language,
              article_ref: articleRef,
              distractors: "plausible but false according to the paragraph",
              avoid_copy: true,
              grounded_only: true
            },
            paragraph
          })
        }
      ]
    });
  }

  postValidate(candidate, paragraph) {
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

    return candidate;
  }

  async verifyCandidate(paragraph, candidate) {
    return callOpenAI({
      apiKey: this.apiKey,
      model: this.config.verifierModel,
      temperature: 0,
      maxOutputTokens: 300,
      jsonSchema: verifierSchema,
      messages: [
        {
          role: "system",
          content:
            "You are a strict legal verifier. Check only against the provided paragraph. Flag failures if any answer requires external assumptions or if question is trivial copy."
        },
        {
          role: "user",
          content: JSON.stringify({ paragraph, candidate })
        }
      ]
    });
  }
}
