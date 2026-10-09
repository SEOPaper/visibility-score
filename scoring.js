/* Visibility scoring engine
 *
 * 1. segment(text)                  splits an LLM response into numbered segments
 * 2. computeFeatures(segs, ann)     turns the GPT annotation into the model's features
 * 3. scoreBrands(features, domain)  evaluates the exported XGBoost model (model.js)
 *
 * Feature definitions follow visibility_xgboost_model.R and Table 2 of the paper:
 *   rank            position of the brand's first mention (1 = first), reverse-coded and centered
 *   textshare_main  brand words outside the recommendation section / all response words
 *   textshare_rec   brand words inside the recommendation section / all response words
 *   overrec         brand is highlighted in the recommendation section
 *   rank_in_rec     position within the recommendation section (0 = not recommended)
 *   numberofbrands_main / _rec, recommendation framing, format, domain
 */
(function (root) {
  "use strict";

  /* ---------------- segmentation ---------------- */

  const LIST_RE = /^\s*(?:[-*+•–·]|\d{1,2}[.)])\s+/;
  const TABLE_SEP_RE = /^\s*\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)*\|?\s*$/;
  const HEADING_RE = /^\s*#{1,6}\s+/;
  const SENT_SPLIT_RE = /(?<=[.!?])\s+(?=["'„“(\[]?[A-ZÄÖÜ0-9])/;
  const CITATION_RE = /\(\s*\[[^\]]*\]\([^)]*\)(?:\s*,?\s*\[[^\]]*\]\([^)]*\))*\s*\)/g;

  function clean(s) {
    s = s.replace(CITATION_RE, "");
    s = s.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
    s = s.replace(/https?:\/\/\S+/g, "");
    s = s.replace(/\*\*|__|`/g, "");
    s = s.replace(/(?<!\w)[*_](?=\S)|(?<=\S)[*_](?!\w)/g, "");
    return s.replace(/\s+/g, " ").trim();
  }

  function tableCells(line) {
    if ((line.match(/\|/g) || []).length >= 2) return line.trim().replace(/^\||\|$/g, "").split("|").map(clean);
    if ((line.match(/\t/g) || []).length >= 2) return line.split("\t").map(clean);
    return null;
  }

  function countWords(s) {
    return (s.match(/[\p{L}\p{N}][\p{L}\p{N}'’.&+-]*/gu) || []).length;
  }

  function segment(text) {
    const segs = [];
    String(text).replace(/\r\n/g, "\n").split("\n").forEach((line) => {
      if (!line.trim() || (TABLE_SEP_RE.test(line) && line.includes("-"))) return;
      const cells = tableCells(line);
      if (cells) segs.push({ kind: "table", text: cells.filter(Boolean).join(" · ") });
      else if (LIST_RE.test(line)) segs.push({ kind: "list", text: clean(line.replace(LIST_RE, "")) });
      else if (HEADING_RE.test(line)) segs.push({ kind: "heading", text: clean(line.replace(HEADING_RE, "")) });
      else line.trim().split(SENT_SPLIT_RE).forEach((s) => segs.push({ kind: "prose", text: clean(s) }));
    });
    const out = segs.filter((s) => s.text);
    out.forEach((s, i) => { s.id = i; s.words = countWords(s.text); });
    return out;
  }

  function detectFormat(segs) {
    const n = { table: 0, list: 0, prose: 0 };
    segs.forEach((s) => { if (n[s.kind] !== undefined) n[s.kind] += s.words; });
    if (n.table >= n.list && n.table >= n.prose * 0.5 && n.table > 0) return "Table";
    if (n.list >= n.prose * 0.5 && n.list > 0) return "List";
    return "ContinuousText";
  }

  /* ---------------- features ---------------- */

  function firstIndex(haystack, names) {
    const h = haystack.toLowerCase();
    let best = Infinity;
    names.forEach((n) => {
      const i = n ? h.indexOf(n.toLowerCase()) : -1;
      if (i >= 0 && i < best) best = i;
    });
    return best;
  }

  /* ann = {format, recommendation: {present, framing, segments}, brands: [{name, aliases, segments, recommended, rank_in_rec, evidence}]} */
  function computeFeatures(segs, ann) {
    const byId = new Map(segs.map((s) => [s.id, s]));
    const totalWords = segs.reduce((a, s) => a + s.words, 0) || 1;

    const recInfo = ann.recommendation || {};
    const recSet = new Set(recInfo.present ? (recInfo.segments || []).filter((id) => byId.has(id)) : []);

    // How many brands claim each segment; shared segments split their words evenly
    const claims = new Map();
    const brands = (ann.brands || []).filter((b) => b && b.name);

    // Safety net: every option the model listed in mentioned_options becomes a brand,
    // even if it was left out of the detailed brand list.
    const known = (s) => brands.some((b) => [b.name].concat(b.aliases || []).some((n) => n.toLowerCase() === s.toLowerCase()));
    (ann.mentioned_options || []).forEach((name) => {
      if (!name || known(name)) return;
      const n = name.toLowerCase();
      brands.push({ name, aliases: [], segments: segs.filter((s) => s.text.toLowerCase().includes(n)).map((s) => s.id), recommended: false, rank_in_rec: 0, evidence: "" });
    });

    brands.forEach((b) => {
      b._segs = [...new Set((b.segments || []).filter((id) => byId.has(id)))];
      b._segs.forEach((id) => claims.set(id, (claims.get(id) || 0) + 1));
    });

    const mainText = segs.filter((s) => !recSet.has(s.id)).map((s) => s.text).join("\n");
    const recText = segs.filter((s) => recSet.has(s.id)).map((s) => s.text).join("\n");

    const rows = brands.map((b, order) => {
      const names = [b.name].concat(b.aliases || []);
      let mainWords = 0, recWords = 0;
      b._segs.forEach((id) => {
        const w = byId.get(id).words / claims.get(id);
        if (recSet.has(id)) recWords += w; else mainWords += w;
      });
      const mainSegIds = b._segs.filter((id) => !recSet.has(id));
      return {
        name: b.name,
        aliases: b.aliases || [],
        segments: b._segs,
        order,
        posMain: firstIndex(mainText, names),
        firstMainSeg: mainSegIds.length ? Math.min(...mainSegIds) : Infinity,
        posRec: firstIndex(recText, names),
        recommendedRaw: !!b.recommended && recSet.size > 0,
        gptRankInRec: b.rank_in_rec || 0,
        evidence: b.evidence || "",
        mainWords, recWords,
      };
    });

    // Rank: order of first mention in the main response (paper, Table 2)
    [...rows]
      .sort((a, b) => (a.posMain - b.posMain) || (a.firstMainSeg - b.firstMainSeg) || (a.order - b.order))
      .forEach((r, i) => { r.rank = i + 1; });

    // Rank within the recommendation section, among recommended brands
    const recRows = rows.filter((r) => r.recommendedRaw);
    [...recRows]
      .sort((a, b) => (a.posRec - b.posRec) || ((a.gptRankInRec || 99) - (b.gptRankInRec || 99)) || (a.rank - b.rank))
      .forEach((r, i) => { r.rankInRec = i + 1; });

    const nRec = recRows.length;
    let framing = nRec > 0 ? (recInfo.framing || "overall_recommendation") : "none";
    if (framing === "none" && nRec > 0) framing = "summary";

    const format = ["ContinuousText", "List", "Table"].includes(ann.format) ? ann.format : detectFormat(segs);

    return {
      totalWords,
      format,
      framing,
      numberofbrands_main: rows.length,
      numberofbrands_rec: nRec,
      recSegments: [...recSet],
      brands: rows.map((r) => ({
        name: r.name,
        aliases: r.aliases,
        segments: r.segments,
        evidence: r.evidence,
        rank: r.rank,
        textshare_main: r.mainWords / totalWords,
        textshare_rec: r.recommendedRaw ? r.recWords / totalWords : 0,
        overrec: r.recommendedRaw ? 1 : 0,
        rank_in_rec: r.recommendedRaw ? r.rankInRec : 0,
      })),
    };
  }

  /* ---------------- XGBoost evaluation ---------------- */

  function asArray(v) { return Array.isArray(v) ? v : [v]; }

  function prepareModel(model) {
    if (model._ready) return model;
    model.trees = model.trees.map((t) => ({
      l: asArray(t.l), r: asArray(t.r), f: asArray(t.f), d: asArray(t.d),
      t: asArray(t.t).map(Math.fround),
    }));
    model._ready = true;
    return model;
  }

  function predictRaw(model, x) {
    prepareModel(model);
    const xf = x.map(Math.fround);   // XGBoost compares in float32
    let sum = model.base_score;
    for (const tree of model.trees) {
      let n = 0;
      while (tree.l[n] !== -1) {
        const v = xf[tree.f[n]];
        if (v === undefined || Number.isNaN(v)) n = tree.d[n] ? tree.l[n] : tree.r[n];
        else n = v < tree.t[n] ? tree.l[n] : tree.r[n];
      }
      sum += tree.t[n];
    }
    return sum;
  }

  function featureVector(model, brand, resp, domain) {
    const pre = model.preprocessing_by_domain[domain];
    const recMax = Math.max(model.rank_in_rec_max[domain] || 1, resp.numberofbrands_rec);
    const quality = brand.rank_in_rec === 0 ? 0 : recMax + 1 - brand.rank_in_rec;
    const v = {
      rank_c: -brand.rank - pre.rank_rev_mean,
      textshare_c: brand.textshare_main - pre.textshare_main_mean,
      textshare_rec_c: brand.textshare_rec - pre.textshare_rec_mean,
      rank_in_rec_c: quality - pre.rank_in_rec_quality_mean,
      numberofbrands_main: resp.numberofbrands_main,
      numberofbrands_rec: resp.numberofbrands_rec,
      overrec1: brand.overrec,
      suggested_option_framing: resp.framing === "suggested_option" ? 1 : 0,
      summary_framing: resp.framing === "summary" ? 1 : 0,
      overallrec_framing: resp.framing === "overall_recommendation" ? 1 : 0,
      formatList: resp.format === "List" ? 1 : 0,
      formatTable: resp.format === "Table" ? 1 : 0,
      domainSmartphoneRepair: domain === "SmartphoneRepair" ? 1 : 0,
      domainITServices: domain === "ITServices" ? 1 : 0,
    };
    return model.feature_names.map((name) => v[name]);
  }

  /* domain: one of model.domain_levels, or "average" for the mean over all three */
  function scoreBrands(model, resp, domain) {
    const domains = domain === "average" ? model.domain_levels : [domain];
    return resp.brands
      .map((b) => {
        const preds = domains.map((d) => predictRaw(model, featureVector(model, b, resp, d)));
        const score = Math.min(7, Math.max(1, preds.reduce((a, p) => a + p, 0) / preds.length));
        return Object.assign({}, b, { score });
      })
      .sort((a, b) => b.score - a.score || a.rank - b.rank);
  }

  root.VisibilityScoring = { segment, countWords, detectFormat, computeFeatures, predictRaw, featureVector, scoreBrands };
  if (typeof module !== "undefined") module.exports = root.VisibilityScoring;
})(typeof window !== "undefined" ? window : globalThis);
