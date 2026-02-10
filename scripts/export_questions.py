#!/usr/bin/env python3
from __future__ import annotations

import argparse
import csv
import json
from pathlib import Path
from typing import Any



def load_json(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def pick_choice(question: dict[str, Any], label: str) -> str | None:
    for choice in question.get("choices", []) or []:
        if choice.get("label") == label:
            return choice.get("text")
    return None


def flatten_questions(bank: dict[str, Any], pandas_module: Any) -> Any:
    rows: list[dict[str, Any]] = []

    for question in bank.get("questions", []):
        kind = question.get("kind", "mcq")
        common = {
            "kind": kind,
            "id": question.get("id"),
            "exam": question.get("exam"),
            "number": question.get("number"),
            "confidence": question.get("confidence"),
            "needs_human_review": question.get("needs_human_review", False),
            "review_reasons": ";".join(question.get("review_reasons", []) or []),
        }

        if kind == "scenario":
            scenario_id = question.get("scenario_id")
            scenario_text = question.get("scenario_text")

            for subq in question.get("subquestions", []):
                rows.append(
                    {
                        **common,
                        "scenario_id": scenario_id,
                        "scenario_text": scenario_text,
                        "subq_index": subq.get("subq_index"),
                        "subq_id": subq.get("id"),
                        "subq_number": subq.get("number"),
                        "question_text": subq.get("text"),
                        "correct_label": subq.get("correct_label"),
                        "points": subq.get("points", 1),
                        "A": pick_choice(subq, "A"),
                        "B": pick_choice(subq, "B"),
                        "C": pick_choice(subq, "C"),
                        "D": pick_choice(subq, "D"),
                    }
                )
        else:
            rows.append(
                {
                    **common,
                    "scenario_id": question.get("scenario_id"),
                    "scenario_text": question.get("scenario_text"),
                    "subq_index": None,
                    "subq_id": None,
                    "subq_number": None,
                    "question_text": question.get("text"),
                    "correct_label": question.get("correct_label"),
                    "points": 1,
                    "A": pick_choice(question, "A"),
                    "B": pick_choice(question, "B"),
                    "C": pick_choice(question, "C"),
                    "D": pick_choice(question, "D"),
                }
            )

    return pandas_module.DataFrame(rows)


def export_questions(input_path: Path, output_csv: Path, output_xlsx: Path) -> tuple[int, int]:
    try:
        import pandas as pd
    except ModuleNotFoundError as exc:
        raise SystemExit(
            "Missing dependency: pandas. Install with `pip install pandas xlsxwriter`."
        ) from exc

    bank = load_json(input_path)
    frame = flatten_questions(bank, pd)

    frame.to_csv(
        output_csv,
        index=False,
        encoding="utf-8-sig",
        quoting=csv.QUOTE_MINIMAL,
        escapechar="\\",
    )

    with pd.ExcelWriter(output_xlsx, engine="xlsxwriter") as writer:
        frame.to_excel(writer, index=False, sheet_name="questions")
        frame.loc[frame["needs_human_review"] == True].to_excel(
            writer,
            index=False,
            sheet_name="needs_review",
        )

    needs_review_count = int((frame["needs_human_review"] == True).sum())
    return len(frame), needs_review_count


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Export flattened questions bank from JSON to CSV/XLSX."
    )
    parser.add_argument(
        "--input",
        type=Path,
        default=Path("questions.corrected.json"),
        help="Path to source questions JSON (default: questions.corrected.json)",
    )
    parser.add_argument(
        "--out-csv",
        type=Path,
        default=Path("questions.export.csv"),
        help="Output CSV path (default: questions.export.csv)",
    )
    parser.add_argument(
        "--out-xlsx",
        type=Path,
        default=Path("questions.export.xlsx"),
        help="Output XLSX path (default: questions.export.xlsx)",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    rows, review_rows = export_questions(args.input, args.out_csv, args.out_xlsx)
    print(
        "Export complete: "
        f"{rows} rows, {review_rows} rows in needs_review. "
        f"Files: {args.out_csv} and {args.out_xlsx}"
    )


if __name__ == "__main__":
    main()
