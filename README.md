# Visibility Score – website

A static website that estimates how visible each brand in an AI answer is to readers,
using the trained XGBoost model from `../visibility_xgboost_model.R`.

```
index.html          start screen
how-it-works.html   method and paper abstract
favicon.svg         browser tab icon (the logo)
contact.html        contact form                           <- set CONTACT_ENDPOINT here
app.html            the tool (UI, OpenAI calls)            <- set PROXY_URL here
scoring.js          segmentation, feature computation, XGBoost evaluation
model.js            the trained model, exported from R     <- generated, do not edit
```

## Setup

1. Deploy the Cloudflare Worker in `../worker` (see `../worker/README.md`). It holds the
   OpenAI API key and forwards the two OpenAI calls.
2. Open `app.html` and set `PROXY_URL` to the Worker address.
3. Double-click `index.html`, or upload all files to any static web host
   (GitHub Pages, Netlify, your own server).

"Try an example" works without the Worker.

## How a score is computed

1. **Generate (optional):** the prompt goes to the OpenAI Responses API (`CONFIG.GENERATE_MODEL`,
   default `gpt-5.6-luna`, low reasoning). The answer is streamed into the text box while it is
   written. Web search is off by default; the "Web search" switch adds the `web_search` tool.
2. **Segment:** the answer is split into sentences, list items, table rows and headings.
   Markdown and inline citation links are removed before words are counted.
3. **Extract:** a second OpenAI call (`CONFIG.EXTRACT_MODEL`, default `gpt-5.6-terra`, medium
   reasoning, structured JSON output)
   first lists every option mentioned (including passing mentions), then returns for each brand which
   segments describe it, the recommendation section,
   its framing (overall recommendation / suggested option / summary) and the format.
4. **Features** (computed in the browser, same definitions as the R code):
   rank of first mention, `textshare_main` and `textshare_rec` (brand words divided by all
   response words), `overrec`, `rank_in_rec`, number of brands overall and in the
   recommendation, framing dummies and format dummies. Features are centered with the
   per-domain means stored in the model bundle.
5. **Predict:** the 225 boosted trees are evaluated in JavaScript. The result is on the
   1–7 visibility scale. Each brand is predicted once per study domain (with that domain's
   dummy and centering) and the three predictions are averaged.

The JavaScript evaluation reproduces R's `predict()` to within 0.00001 (checked against 40
reference predictions that the export script stores in `model.js`).

## Model choice

Tested in October 2026 on four answers:

- **Generation: `gpt-5.6-luna`, low reasoning.** About 10 s per answer, roughly 20 times cheaper than
  `gpt-5.5` or `gpt-5.6-terra`, and the answers read like ChatGPT, with cited sources.
- **Extraction: `gpt-5.6-terra`, medium reasoning.** About 4–11 s and about $0.01 per answer. It gave
  consistent format, framing and recommendation labels. `gpt-5.6-luna` was cheaper but
  inconsistent: the format and framing changed between runs, and once all brands were marked as recommended.

## After retraining the model

```
cd "papers/Visibility scoring/app"
Rscript export_model_for_web.R
```

This rewrites `website/model.js` from `visibility_xgboost_final_model.rds`. It needs the
R packages `xgboost` and `jsonlite`.

## Judgment calls to review

- **Domain for new texts:** the model has domain dummies, but a new answer belongs to none
  of the three study domains. The page averages the three predictions.
- **`rank_in_rec_quality`:** the R code uses `max(rank_in_rec) + 1 - rank_in_rec`, with the
  max taken over the training survey (1, 1 and 3). The website uses
  `max(training max of the domain, number of recommended brands in this answer)`.
- **Recommended brands:** follows the paper (Appendix A): a brand counts as recommended if it
  appears in the recommendation section or gets its own pick there, including use-case and conditional
  picks ("Best camera: X", "choose A if…"). Brands only listed neutrally, as a caution or as a passing
  fallback do not count. The study had at most 3 recommended brands; the page warns above that.
- **Shared segments:** words in a segment that describes several brands equally are split
  evenly between them. This mirrors how shared table cells were coded in Survey 2.

## Security note

Never put the OpenAI API key in this folder: every file here is public. The key lives
only in the Cloudflare Worker as a secret. The Worker accepts requests only from the
allowed pages and forwards only the models and fields the page uses, but anyone can
imitate those requests, so keep a monthly spending limit on the key.
