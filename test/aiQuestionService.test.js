import test from "node:test";
import assert from "node:assert/strict";
import {
  estimateDifficulty,
  ngramOverlap,
  normalizeText,
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
