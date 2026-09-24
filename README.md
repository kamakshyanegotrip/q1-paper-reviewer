# Q1 Paper Reviewer

A static web app for **evidence-first pre-submission review** of research manuscripts targeting Scopus Q1 journals.

Upload a manuscript (PDF, DOCX or TXT) and a multi-agent review engine running on **n8n** evaluates it:

1. Text extraction (OCR fallback for scanned PDFs) with page markers
2. Study-design classification and manuscript inventory (Gemini)
3. Adaptive checklist (110+ Q1 criteria, Quick / Full / Forensic depth)
4. Seven independent Claude specialist reviewers (theory, method, statistics, literature, integrity, reporting, editor)
5. Evidence validator — every quote is matched against the manuscript
6. Rule-based number & language audit (sample sizes, p-values, thresholds, CMB, causal verbs)
7. Cross-validation (objectives, hypotheses, tables, contradictions)
8. Crossref reference verification (mismatches, missing DOIs, retractions)
9. Adjudication and Claude Opus synthesis
10. **You** confirm, modify or reject each finding in the browser

## Architecture

```
GitHub Pages (this repo, static)  ──POST multipart──▶  n8n  /webhook/q1-review-submit
                                   ◀──poll JSON──────  n8n  /webhook/q1-review-status
```

* `index.html`, `app.js`, `styles.css` — dependency-free single-page app (hash routing).
* `config.js` — API base URL (no secrets).
* `sample-result.json` — sample report for a fictional manuscript.

## Access

Submissions require an **access key** (entered in *Settings*, stored only in the user's browser). The key is checked by the n8n workflows; it is never committed to this repository. To rotate it, change `ACCESS_KEY` in the *Web Submission Gate* node (main workflow) and the *Check Access Key* node (status workflow).

## Privacy

This site stores nothing server-side. Manuscript text is processed by Google Gemini and Anthropic Claude through the owner's n8n server. Do not upload manuscripts received in confidence as a journal reviewer.

Findings are AI-generated decision support and must be validated by a human.
