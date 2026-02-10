import test from "node:test";
import assert from "node:assert/strict";
import {
  cosineSimilarity,
  decideSimilarityAction,
  detectLanguage,
  estimateDifficulty,
  ngramOverlap,
  normalizeText,
  tagParagraphTopic,
  validateChoiceIntegrity
} from "../backend/aiQuestionService.js";

test("normalizeText strips punctuation/diacritics", () => {
  const out = normalizeText("Zażółć, gęślą! jaźń.");
  assert.equal(out, "zazolc gesla jazn");
});

test("ngramOverlap catches copied phrase", () => {
  const p = "Administrator danych może przetwarzać dane osobowe wyłącznie zgodnie z prawem.";
  const q = "Kiedy administrator danych może przetwarzać dane osobowe wyłącznie zgodnie z prawem?";
  const score = ngramOverlap(p, q, 3);
  assert.ok(score > 0.4);
});

test("choice integrity validates labels/text/correct", () => {
  const ok = validateChoiceIntegrity({
    choices: [
      { label: "A", text: "One" },
      { label: "B", text: "Two" },
      { label: "C", text: "Three" },
      { label: "D", text: "Four" }
    ],
    correct_label: "C"
  });
  assert.equal(ok.ok, true);

  const bad = validateChoiceIntegrity({
    choices: [
      { label: "A", text: "One" },
      { label: "A", text: "Two" },
      { label: "C", text: "Three" },
      { label: "D", text: "Four" }
    ],
    correct_label: "B"
  });
  assert.equal(bad.ok, false);
});

test("difficulty heuristic detects harder patterns", () => {
  const easy = estimateDifficulty("Która odpowiedź jest poprawna?", [
    { text: "A" },
    { text: "B" },
    { text: "C" },
    { text: "D" }
  ]);
  const harder = estimateDifficulty(
    "W przedstawionym przypadku, który obowiązek administratora NIE ma zastosowania i który wyjątek jest właściwy?",
    [{ text: "Opt 1" }, { text: "Opt 2" }, { text: "Opt 3" }, { text: "Opt 4" }]
  );

  assert.ok(harder > easy);
});

test("language detection defaults and detects Polish/English", () => {
  assert.equal(detectLanguage("Administrator danych przetwarza dane osobowe."), "pl");
  assert.equal(detectLanguage("The controller must rely on a lawful basis for processing."), "en");
  assert.equal(detectLanguage(""), "pl");
});

test("topic tagging identifies transfer/legal basis patterns", () => {
  const tags = tagParagraphTopic("Przekazywanie danych do państw trzecich wymaga odpowiednich zabezpieczeń, np. SCC.");
  assert.ok(tags.includes("transfers"));
});

test("cosine similarity and threshold-based decider work", () => {
  assert.equal(cosineSimilarity([1, 0], [1, 0]), 1);
  assert.equal(Math.round(cosineSimilarity([1, 0], [0, 1]) * 100), 0);

  assert.equal(decideSimilarityAction(0.95).action, "reject");
  assert.equal(decideSimilarityAction(0.50).action, "revise");
  assert.equal(decideSimilarityAction(0.75).action, "accept");
});
