# Exam Simulator (Static)

This is a **pure static** exam simulator (HTML + JS) that:
- randomly draws **50 questions** from the question bank
- lets you answer
- scores you and shows a full review

No Python, no server.

## Run locally
Just open `index.html` in a browser.

> Tip: some browsers block `fetch()` from `file://`.  
> If that happens, use any tiny static server, e.g. VS Code “Live Server”.
> On GitHub Pages it works normally.

## Host on GitHub Pages
1. Create a new GitHub repo (e.g. `exam-simulator`)
2. Upload these files to the repo root:
   - `index.html`
   - `app.js`
   - `styles.css`
   - `questions.json`
   - `.nojekyll`
3. In GitHub:
   - Settings → Pages → “Deploy from a branch”
   - Branch: `main` / folder: `/ (root)`
4. Your site appears at:
   `https://<username>.github.io/<repo>/`

## AI question cleanup (optional)
If you want to automatically clean up grammar/wording in `questions.json`, use the
script below. **Do not hard-code API keys in source files**—set it as an environment
variable instead.

```bash
export OPENAI_API_KEY="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"
node scripts/ai_correct_questions.js --in questions.json --out questions.corrected.json
```

Options:
- `--limit 10` → process only the first 10 questions
- `--start-id 50` → start from a given question id
- `--model gpt-4.1-mini` → choose a model
- `--delay-ms 500` → add delay between requests

## Privacy
All answers are stored only in your browser (LocalStorage). Nothing is sent anywhere.
