#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";

const DEFAULT_TOPICS = [
  "gdpr_rights",
  "controller_obligations",
  "lawful_bases",
  "international_transfers",
  "data_breach"
];

const TOPIC_LABELS = {
  gdpr_rights: "data subject rights",
  controller_obligations: "controller obligations",
  lawful_bases: "lawful bases for processing",
  international_transfers: "international data transfers",
  data_breach: "personal data breaches"
};

function parseArgs(argv) {
  const options = {
    out: "ai_questions.json",
    count: 200,
    topics: DEFAULT_TOPICS,
    difficulty: "medium",
    seedPrefix: new Date().toISOString().slice(0, 10)
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) continue;
    i++;

    if (key === "out") options.out = value;
    if (key === "count") options.count = Math.max(1, Number.parseInt(value, 10) || 1);
    if (key === "topics") options.topics = value.split(",").map(v => v.trim()).filter(Boolean);
    if (key === "difficulty") options.difficulty = value.trim() || "medium";
    if (key === "seed-prefix") options.seedPrefix = value.trim() || options.seedPrefix;
  }

  if (!options.topics.length) options.topics = DEFAULT_TOPICS;
  return options;
}

function sanitizeQuestionText(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .replace(/Article\s+\d+/gi, "GDPR provision")
    .replace(/Art\.\s*\d+/gi, "GDPR provision")
    .trim();
}

function normalizeText(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(text) {
  return normalizeText(text).split(" ").filter(Boolean);
}

function jaccardSimilarity(a, b) {
  const setA = new Set(tokenize(a));
  const setB = new Set(tokenize(b));
  if (!setA.size || !setB.size) return 0;
  let intersection = 0;
  for (const token of setA) {
    if (setB.has(token)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function hasLongOverlap(a, b, runLength = 8) {
  const aTokens = tokenize(a);
  const bText = ` ${tokenize(b).join(" ")} `;
  for (let i = 0; i <= aTokens.length - runLength; i++) {
    const phrase = aTokens.slice(i, i + runLength).join(" ");
    if (phrase && bText.includes(` ${phrase} `)) return true;
  }
  return false;
}

function uniqueStrings(values) {
  const seen = new Set();
  const out = [];
  for (const v of values) {
    const key = normalizeText(v);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(v.trim());
  }
  return out;
}

function qualityGate(candidate, sourceQuestion, acceptedQuestions) {
  const reasons = [];
  const hasShape =
    candidate &&
    typeof candidate.question === "string" &&
    Array.isArray(candidate.choices) &&
    candidate.choices.length === 4 &&
    Number.isInteger(candidate.correct_index) &&
    candidate.correct_index >= 0 &&
    candidate.correct_index <= 3;

  if (!hasShape) reasons.push("Invalid JSON contract");

  if (candidate?.choices && uniqueStrings(candidate.choices).length !== 4) {
    reasons.push("Choices are not unique");
  }

  if (/\b(Article|Art\.)\s*\d+/i.test(candidate?.question || "")) {
    reasons.push("Question text cites article numbers");
  }

  const sanitizedQuestion = sanitizeQuestionText(candidate?.question || "");
  const srcQuestion = sanitizeQuestionText(sourceQuestion?.text || "");
  if (jaccardSimilarity(sanitizedQuestion, srcQuestion) > 0.78 || hasLongOverlap(sanitizedQuestion, srcQuestion, 8)) {
    reasons.push("Question is too similar to legacy source question");
  }

  const maxSimilarityToGenerated = acceptedQuestions.reduce((max, q) => {
    return Math.max(max, jaccardSimilarity(sanitizedQuestion, q));
  }, 0);

  if (maxSimilarityToGenerated > 0.82) {
    reasons.push("Question is too similar to already generated AI question");
  }

  let confidence = 0.95;
  if (reasons.length) confidence = Math.max(0.2, 0.95 - reasons.length * 0.2);

  return {
    ok: reasons.length === 0,
    confidence,
    reasons
  };
}

function shuffle(arr) {
  const copy = arr.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function fallbackGenerateQuestion(sourceQuestion, topic, variantSeed = 0) {
  const topicLabel = TOPIC_LABELS[topic] || topic.replaceAll("_", " ");
  const correctChoice = sourceQuestion.choices.find(c => c.label === sourceQuestion.correct_label)?.text || "It depends on context and legal obligations.";
  const wrongChoices = sourceQuestion.choices.filter(c => c.label !== sourceQuestion.correct_label).map(c => c.text);
  const genericDistractors = [
    "Processing is always allowed if data is publicly available.",
    "Controllers can skip documentation when risk is low.",
    "Consent is the only valid legal basis in GDPR."
  ];

  const distractors = uniqueStrings([...wrongChoices, ...genericDistractors]).slice(0, 3);
  const combined = shuffle([sanitizeQuestionText(correctChoice), ...distractors]).slice(0, 4);
  const correctIndex = combined.findIndex(choice => normalizeText(choice) === normalizeText(correctChoice));

  const contextBits = tokenize(sourceQuestion.text).filter(t => t.length > 4).slice(0, 3).join(", ");
  const templates = [
    `A team is reviewing ${topicLabel}. Which option is the most GDPR-compliant?`,
    `For ${topicLabel}, which action best aligns with GDPR expectations in practice?`,
    `During a compliance assessment focused on ${topicLabel}, which statement is most accurate?`,
    `Which option best demonstrates correct handling of ${topicLabel} under GDPR?`
  ];
  const template = templates[variantSeed % templates.length];
  const context = contextBits ? ` Context: ${contextBits}.` : "";

  return {
    question: `${template}${context}`,
    choices: combined,
    correct_index: correctIndex >= 0 ? correctIndex : 0
  };
}

async function callOpenAiJson(messages) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not set");
  }

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: "gpt-5-mini",
      input: messages,
      text: {
        format: {
          type: "json_object"
        }
      }
    })
  });

  if (!response.ok) throw new Error(`OpenAI API error: ${response.status}`);

  const data = await response.json();
  if (!data.output_text) throw new Error("OpenAI API returned empty output_text");
  return JSON.parse(data.output_text);
}

async function generateWithModel({ sourceQuestion, topic, difficulty }) {
  const generatorPrompt = [
    {
      role: "system",
      content:
        "You generate GDPR quiz questions. Return strict JSON with keys: question, choices, correct_index. Keep exactly 4 choices with one correct answer. Do not cite article numbers in question text. Keep medium difficulty unless requested otherwise. Do not copy the source question wording and do not reuse any 8-word sequence from the source question."
    },
    {
      role: "user",
      content: `Topic: ${topic}\nDifficulty: ${difficulty}\nSource question (for meaning only, do not copy wording): ${sourceQuestion.text}\nCorrect concept: ${sourceQuestion.choices.find(c => c.is_correct)?.text || ""}`
    }
  ];

  return callOpenAiJson(generatorPrompt);
}

async function validateWithModel(candidate) {
  const validatorPrompt = [
    {
      role: "system",
      content:
        "Validate a GDPR multiple choice question. Return strict JSON: {\"ok\": boolean, \"confidence\": number, \"reasons\": string[]}. Rules: exactly one correct answer, no article citation in question text, medium difficulty, and good distractors."
    },
    {
      role: "user",
      content: JSON.stringify(candidate)
    }
  ];

  return callOpenAiJson(validatorPrompt);
}

async function loadKnowledgeSource() {
  const raw = await fs.readFile("questions.json", "utf8");
  const parsed = JSON.parse(raw);
  return parsed.questions || [];
}

function buildAiItem(candidate, index, opts, topic) {
  return {
    id: `ai_${String(index + 1).padStart(6, "0")}`,
    topic,
    difficulty: opts.difficulty || "medium",
    question: sanitizeQuestionText(candidate.question),
    choices: candidate.choices.map(c => String(c).trim()),
    correct_index: candidate.correct_index,
    source: {
      gdpr_ref: "GDPR (conceptual)",
      seed: `${opts.seedPrefix}|${topic}|${String(index + 1).padStart(4, "0")}`
    }
  };
}

async function main() {
  const opts = parseArgs(process.argv);
  const sourceQuestions = await loadKnowledgeSource();
  if (!sourceQuestions.length) throw new Error("No source questions available in questions.json");

  const acceptedQuestions = [];
  const items = [];

  for (let i = 0; i < opts.count; i++) {
    const sourceQuestion = sourceQuestions[i % sourceQuestions.length];
    const topic = opts.topics[i % opts.topics.length];
    let accepted = null;

    for (let attempt = 0; attempt < 3; attempt++) {
      let generated;
      let modelValidation = { ok: true, confidence: 0.9, reasons: [] };

      try {
        generated = await generateWithModel({ sourceQuestion, topic, difficulty: opts.difficulty });
        if (process.env.OPENAI_API_KEY) {
          modelValidation = await validateWithModel(generated);
        }
      } catch {
        generated = fallbackGenerateQuestion(sourceQuestion, topic, i + attempt);
      }

      const gate = qualityGate(generated, sourceQuestion, acceptedQuestions);
      const modelOk = modelValidation.ok !== false && Number(modelValidation.confidence || 0) >= 0.85;

      if (gate.ok && gate.confidence >= 0.85 && modelOk) {
        accepted = generated;
        break;
      }
    }

    if (!accepted) continue;

    const aiItem = buildAiItem(accepted, items.length, opts, topic);
    items.push(aiItem);
    acceptedQuestions.push(aiItem.question);
  }

  const out = {
    version: 1,
    generated_at: new Date().toISOString(),
    items
  };

  const outputPath = path.resolve(opts.out);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(out, null, 2)}\n`, "utf8");

  console.log(`Generated ${items.length} AI questions -> ${opts.out}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
