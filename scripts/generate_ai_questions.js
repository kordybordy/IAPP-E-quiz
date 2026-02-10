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

  if (!options.topics.length) {
    options.topics = DEFAULT_TOPICS;
  }

  return options;
}

function sanitizeQuestionText(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .replace(/Article\s+\d+/gi, "GDPR provision")
    .replace(/Art\.\s*\d+/gi, "GDPR provision")
    .trim();
}

function validateGeneratedQuestion(candidate) {
  const reasons = [];
  const hasShape =
    candidate &&
    typeof candidate.question === "string" &&
    Array.isArray(candidate.choices) &&
    candidate.choices.length === 4 &&
    Number.isInteger(candidate.correct_index) &&
    candidate.correct_index >= 0 &&
    candidate.correct_index <= 3;

  if (!hasShape) {
    reasons.push("Invalid JSON contract");
  }

  if (/\b(Article|Art\.)\s*\d+/i.test(candidate?.question || "")) {
    reasons.push("Question text cites article numbers");
  }

  const duplicateChoices = new Set(candidate?.choices || []).size !== 4;
  if (duplicateChoices) {
    reasons.push("Choices are not unique");
  }

  let confidence = 0.95;
  if (reasons.length) {
    confidence = Math.max(0.2, 0.95 - reasons.length * 0.25);
  }

  return {
    ok: reasons.length === 0,
    confidence,
    reasons
  };
}

function fallbackGenerateQuestion(sourceQuestion, topic) {
  const choices = sourceQuestion.choices.map(c => c.text);
  const correctLabel = sourceQuestion.correct_label;
  const correctIndex = sourceQuestion.choices.findIndex(c => c.label === correctLabel);

  return {
    question: sanitizeQuestionText(sourceQuestion.text),
    choices,
    correct_index: correctIndex >= 0 ? correctIndex : 0,
    topic
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

  if (!response.ok) {
    throw new Error(`OpenAI API error: ${response.status}`);
  }

  const data = await response.json();
  const output = data.output_text;
  return JSON.parse(output);
}

async function generateWithModel({ sourceQuestion, topic, difficulty }) {
  const generatorPrompt = [
    {
      role: "system",
      content:
        "You generate GDPR quiz questions. Return strict JSON with keys: question, choices, correct_index. Keep exactly 4 choices. Exactly one correct answer. Do not cite article numbers in question text. Difficulty should be medium unless explicitly different."
    },
    {
      role: "user",
      content: `Topic: ${topic}\nDifficulty: ${difficulty}\nKnowledge fragment: ${sourceQuestion.text}\nCorrect answer context: ${sourceQuestion.choices.find(c => c.is_correct)?.text || ""}`
    }
  ];

  const generated = await callOpenAiJson(generatorPrompt);

  const validatorPrompt = [
    {
      role: "system",
      content:
        "Validate a GDPR multiple choice question. Return strict JSON: {\"ok\": boolean, \"confidence\": number, \"reasons\": string[]}. Rules: exactly one correct answer, no article number citation in question text, medium difficulty quality."
    },
    {
      role: "user",
      content: JSON.stringify(generated)
    }
  ];

  const validated = await callOpenAiJson(validatorPrompt);
  return { generated, validated };
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
    choices: candidate.choices,
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

  if (!sourceQuestions.length) {
    throw new Error("No source questions available in questions.json");
  }

  const items = [];

  for (let i = 0; i < opts.count; i++) {
    const sourceQuestion = sourceQuestions[i % sourceQuestions.length];
    const topic = opts.topics[i % opts.topics.length];
    let accepted = null;

    for (let attempt = 0; attempt < 3; attempt++) {
      let generated;
      let validated;
      try {
        ({ generated, validated } = await generateWithModel({ sourceQuestion, topic, difficulty: opts.difficulty }));
      } catch {
        generated = fallbackGenerateQuestion(sourceQuestion, topic);
        validated = validateGeneratedQuestion(generated);
      }

      if (validated.ok && validated.confidence >= 0.85) {
        accepted = generated;
        break;
      }
    }

    if (!accepted) {
      continue;
    }

    items.push(buildAiItem(accepted, items.length, opts, topic));
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
