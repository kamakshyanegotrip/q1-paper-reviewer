/* Q1 Paper Reviewer — static single-page app (no build step, no dependencies).
   Talks to the n8n review engine through two webhooks:
     POST {apiBase}/q1-review-submit   multipart form → { ok, review_id }
     GET  {apiBase}/q1-review-status?id=&key=[&include=result] → progress / final result JSON
   and the human-validation API:
     POST {apiBase}/q1-review-validate     urlencoded {key, review_id, payload, reviewer} → saves decisions
     GET  {apiBase}/q1-review-validations  ?id=&key= → { validations }
     POST {apiBase}/q1-review-finalize     urlencoded {key, review_id, reviewer} → 202, builds final documents
     GET  {apiBase}/q1-review-final        ?id=&key=[&include=audit] → status + links
*/
(function () {
  'use strict';
  const CFG = window.Q1_CONFIG || {};
  const app = document.getElementById('app');

  // ---------- storage (browser-only, fail-safe) ----------
  const store = {
    get(k, d) { try { const v = localStorage.getItem('q1:' + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('q1:' + k, JSON.stringify(v)); return true; } catch (e) { return false; } },
    del(k) { try { localStorage.removeItem('q1:' + k); } catch (e) { /* ignore */ } }
  };
  const settings = () => ({ key: store.get('key', ''), api: store.get('api', '') || CFG.apiBase, oaKey: store.get('oaKey', '') });
  const history = {
    all() { return store.get('history', []); },
    upsert(entry) {
      const list = history.all().filter(r => r.id !== entry.id);
      const prev = history.all().find(r => r.id === entry.id) || {};
      list.unshift(Object.assign({}, prev, entry));
      store.set('history', list.slice(0, 60));
    },
    remove(id) { store.set('history', history.all().filter(r => r.id !== id)); store.del('result:' + id); store.del('val:' + id); store.del('road:' + id); }
  };
  function cacheResult(id, result) {
    if (store.set('result:' + id, result)) return;
    // quota: drop the oldest cached results and retry
    history.all().slice(5).forEach(r => store.del('result:' + r.id));
    store.set('result:' + id, result);
  }

  // ---------- utils ----------
  const esc = s => String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const fmtDate = d => { try { return new Date(d).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }); } catch (e) { return d || ''; } };
  const arr = v => Array.isArray(v) ? v : [];
  let toastTimer;
  function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 3200); }
  function download(name, text, type) {
    const blob = new Blob([text], { type: type || 'application/octet-stream' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }
  const csvCell = v => '"' + String(v === undefined || v === null ? '' : v).replace(/"/g, '""').replace(/\r?\n/g, ' ') + '"';
  const READINESS = {
    READY: 'Ready to submit', READY_AFTER_MINOR_REVISION: 'Ready after minor revision',
    SUBSTANTIVE_REVISION_NEEDED: 'Substantive revision needed', NOT_READY: 'Not ready for submission', UNDETERMINED: 'Not determined', ORIGINALITY_ONLY: 'Originality check done'
  };
  const RATING_W = { Strong: 90, Moderate: 62, Weak: 32, Unclear: 10 };
  const STAGES = [
    ['received', 'Manuscript received', 5],
    ['classifying', 'Text extraction, study-design classification & manuscript inventory', 15],
    ['specialist_review', '7 independent specialist reviewers', 25],
    ['cross_validation', 'Evidence validation & cross-document consistency audit', 55],
    ['reference_check', 'Reference verification (Crossref), citation and novelty checks (OpenAlex)', 65],
    ['adjudication', 'Adjudication of findings', 75],
    ['originality', 'Originality & writing-authenticity screen', 80],
    ['synthesis', 'Q1 synthesis report', 85],
    ['done', 'Report ready', 100]
  ];
  const STAGES_ORIG = [
    ['received', 'Manuscript received', 5],
    ['classifying', 'Text extraction', 15],
    ['originality', 'Open-access phrase search & writing-authenticity review', 80],
    ['done', 'Originality report ready', 100]
  ];
  let curStages = STAGES;

  let pollTimer = null;
  function stopPolling() { if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; } }

  // ---------- API ----------
  async function apiStatus(id, includeResult) {
    const s = settings();
    const url = s.api.replace(/\/$/, '') + CFG.statusPath + '?id=' + encodeURIComponent(id) + '&key=' + encodeURIComponent(s.key) + (includeResult ? '&include=result' : '');
    const res = await fetch(url, { method: 'GET', cache: 'no-store' });
    let data = null; try { data = await res.json(); } catch (e) { /* non-JSON */ }
    if (!res.ok || !data) throw new Error((data && data.error) || ('Status request failed (' + res.status + ')'));
    return data;
  }

  const P = {
    validate: CFG.validatePath || '/q1-review-validate', validations: CFG.validationsPath || '/q1-review-validations',
    finalize: CFG.finalizePath || '/q1-review-finalize', final: CFG.finalPath || '/q1-review-final'
  };
  const apiUrl = path => settings().api.replace(/\/$/, '') + path;
  async function apiJson(res) {
    let d = null; try { d = await res.json(); } catch (e) { /* non-JSON */ }
    if (!res.ok || !d) throw new Error((d && d.error) || ('Request failed (' + res.status + ')'));
    return d;
  }
  async function apiGetJson(path, params) {
    const q = new URLSearchParams(Object.assign({ key: settings().key }, params || {}));
    return apiJson(await fetch(apiUrl(path) + '?' + q.toString(), { method: 'GET', cache: 'no-store' }));
  }
  async function apiPostForm(path, params) {
    const body = new URLSearchParams(Object.assign({ key: settings().key }, params || {}));
    // A writer call that never answers must end with a message, not leave the page waiting forever.
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 300000);
    try {
      return apiJson(await fetch(apiUrl(path), { method: 'POST', body, signal: ctl.signal }));
    } catch (e) {
      if (e && e.name === 'AbortError') throw new Error('No answer from the writer after 5 minutes. Try again.');
      // 'Failed to fetch' means the connection was cut before the writer answered (the server or gateway closed a long request).
      if (e && e.name === 'TypeError') throw new Error('The connection to the writer was cut off before it answered, so the section was not updated. Check the writer runs in n8n for this time; if none finished, try again with fewer sources.');
      throw e;
    } finally { clearTimeout(timer); }
  }


  // ---------- Journal finder ----------
  const JF_PATH = CFG.journalFinderPath || '/q1-journal-finder';
  const QORD = { Q1: 1, Q2: 2, Q3: 3, Q4: 4 };
  function jfFiltersFromForm(f) {
    return {
      require_scopus: f.get('jf_scopus') === 'on', require_wos: f.get('jf_wos') === 'on',
      wos_collections: ['SSCI', 'SCIE', 'ESCI', 'AHCI'].filter(c => f.get('jf_c_' + c) === 'on'),
      min_quartile: f.get('jf_q') || '', abdc_min: f.get('jf_abdc') || '', oa: f.get('jf_oa') || 'any',
      max_apc_usd: f.get('jf_apc') || '', prefer_publishers: f.get('jf_prefer') || '', exclude_publishers: f.get('jf_exclude') || '',
      exclude_journals: f.get('jf_exj') || '', include_discontinued: f.get('jf_disc') === 'on'
    };
  }
  function jfFilterFields(F) {
    F = F || store.get('jfFilters', {}) || {};
    const sel = (name, opts, v) => `<select name="${name}">${opts.map(o => `<option value="${esc(o[0])}"${String(v || '') === o[0] ? ' selected' : ''}>${esc(o[1])}</option>`).join('')}</select>`;
    const cb = (name, label, on) => `<label class="consent" style="margin:4px 0"><input type="checkbox" name="${name}"${on ? ' checked' : ''}> <span>${label}</span></label>`;
    const wc = arr(F.wos_collections);
    return `
      <div class="grid-2">
        <label class="field"><span>Lowest SJR quartile <i>Scopus-based</i></span>${sel('jf_q', [['', 'Any'], ['Q1', 'Q1 only'], ['Q2', 'Q1–Q2'], ['Q3', 'Q1–Q3'], ['Q4', 'Q1–Q4 (ranked only)']], F.min_quartile)}</label>
        <label class="field"><span>Lowest ABDC rating <i>business &amp; management</i></span>${sel('jf_abdc', [['', 'Any'], ['A*', 'A* only'], ['A', 'A* or A'], ['B', 'A* to B'], ['C', 'Any ABDC-listed']], F.abdc_min)}</label>
        <label class="field"><span>Access model</span>${sel('jf_oa', [['any', 'Any'], ['subscription', 'Subscription / hybrid (no compulsory fee)'], ['oa', 'Fully open access'], ['diamond', 'Open access with no fee (diamond)']], F.oa)}</label>
        <label class="field"><span>Highest publication fee (APC) <i>USD, open-access journals</i></span><input type="number" name="jf_apc" min="0" step="50" value="${esc(F.max_apc_usd == null ? '' : F.max_apc_usd)}" placeholder="no limit"></label>
      </div>
      ${cb('jf_scopus', '<b>Must be indexed in Scopus</b> (current source list)', F.require_scopus)}
      ${cb('jf_wos', '<b>Must be indexed in Web of Science</b>', F.require_wos)}
      <div style="margin:2px 0 8px 26px;font-size:14px">Only these collections: ${['SSCI', 'SCIE', 'ESCI', 'AHCI'].map(c => `<label style="margin-right:12px"><input type="checkbox" name="jf_c_${c}"${wc.includes(c) ? ' checked' : ''}> ${c}</label>`).join('')}</div>
      ${cb('jf_disc', 'Also show journals that Scopus has discontinued', F.include_discontinued)}
      <div class="grid-2">
        <label class="field"><span>Prefer publishers <i>comma-separated</i></span><input type="text" name="jf_prefer" value="${esc(Array.isArray(F.prefer_publishers) ? F.prefer_publishers.join(', ') : F.prefer_publishers || '')}" placeholder="e.g. Elsevier, Taylor & Francis"></label>
        <label class="field"><span>Exclude publishers <i>comma-separated</i></span><input type="text" name="jf_exclude" value="${esc(Array.isArray(F.exclude_publishers) ? F.exclude_publishers.join(', ') : F.exclude_publishers || '')}" placeholder="e.g. MDPI, Frontiers"></label>
      </div>
      <label class="field"><span>Exclude journals <i>one per line, exact names</i></span><textarea name="jf_exj" rows="2" placeholder="Journals that already rejected the paper">${esc(Array.isArray(F.exclude_journals) ? F.exclude_journals.join('\n') : F.exclude_journals || '')}</textarea></label>`;
  }

  function renderJournals() {
    const pre = store.get('jfPrefill', null); store.del('jfPrefill');
    const last = store.get('jfLast', null);
    const v = pre || (last && last.query) || {};
    app.innerHTML = `
      <section class="card">
        <div class="card-head" style="margin-bottom:6px"><h1 style="margin:0">Journal finder</h1><small>free sources only</small></div>
        <p class="muted" style="margin-top:0">Finds the journals that publish the papers most similar to yours (OpenAlex), then checks each one against the Scopus source list, SCImago quartiles, Web of Science lists, the ABDC list and DOAJ, and adds a short AI note on scope fit.</p>
        ${settings().key ? '' : '<div class="keywarn">Add your access key in <a href="#" id="jfKey">Settings</a> first.</div>'}
        <form id="jfForm" novalidate>
          <label class="field"><span>Working title</span><input type="text" name="title" required value="${esc(v.title || '')}" placeholder="Title of your paper"></label>
          <label class="field"><span>Abstract <i>recommended</i></span><textarea name="abstract" rows="6" placeholder="Paste the abstract for a much better match">${esc(v.abstract || '')}</textarea></label>
          <div class="grid-2">
            <label class="field"><span>Keywords <i>separate with ; or ,</i></span><input type="text" name="keywords" value="${esc(v.keywords || '')}" placeholder="medical tourism; service quality; PLS-SEM"></label>
            <label class="field"><span>Research field</span><input type="text" name="field" value="${esc(v.field || 'Tourism & Hospitality')}"></label>
            <label class="field"><span>Journal you have in mind <i>optional, checked too</i></span><input type="text" name="target_journal" value="${esc(v.target_journal || '')}" placeholder="e.g. Tourism Management"></label>
            <label class="field"><span>How many suggestions</span><select name="max_results">${[10, 15, 20, 30].map(n => `<option${n === (v.max_results || 15) ? ' selected' : ''}>${n}</option>`).join('')}</select></label>
          </div>
          <details class="more" open><summary>Filters</summary>${jfFilterFields(last && last.filters)}</details>
          <label class="consent"><input type="checkbox" name="private" id="jfPrivate"> <span><b>Private mode</b> — the abstract is read only by the private model (Groq, zero data retention); only short search phrases go to OpenAlex.</span></label>
          <p class="form-error" id="jfError" role="alert"></p>
          <button class="btn btn-primary btn-lg" type="submit" id="jfBtn" style="width:100%">Find journals</button>
        </form>
      </section>
      <div id="jfOut">${last && last.result ? viewJournalFit(last.result) : ''}</div>`;
    const k = $('#jfKey'); if (k) k.addEventListener('click', e => { e.preventDefault(); openSettings(); });
    if (last && last.result) wireJournalFit(last.result, $('#jfOut'));
    $('#jfForm').addEventListener('submit', async e => {
      e.preventDefault();
      const f = new FormData(e.target); const btn = $('#jfBtn'); const err = $('#jfError'); err.textContent = '';
      if (!settings().key) { openSettings('Add your access key first.'); return; }
      const title = String(f.get('title') || '').trim();
      if (title.length < 8 && String(f.get('abstract') || '').trim().length < 40) { err.textContent = 'Give at least a working title (or an abstract).'; return; }
      const filters = jfFiltersFromForm(f); store.set('jfFilters', filters);
      const query = { title, abstract: f.get('abstract') || '', keywords: f.get('keywords') || '', field: f.get('field') || '', target_journal: f.get('target_journal') || '', max_results: parseInt(f.get('max_results'), 10) || 15 };
      btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Searching OpenAlex and the journal lists… (about 20–40 seconds)';
      try {
        const r = await apiPostForm(JF_PATH, Object.assign({}, query, { private: f.get('private') === 'on' ? 'true' : '', filters: JSON.stringify(filters) }));
        store.set('jfLast', { query, filters, result: r });
        $('#jfOut').innerHTML = viewJournalFit(r); wireJournalFit(r, $('#jfOut'));
        $('#jfOut').scrollIntoView({ behavior: 'smooth' });
      } catch (x) { err.textContent = x.message || 'Search failed'; }
      btn.disabled = false; btn.textContent = 'Find journals';
    });
  }

  function jfChips(j) {
    const c = [];
    const sc = j.scopus || {};
    if (sc.indexed === true) c.push(sc.active ? '<span class="tag ok" title="In the current Scopus source list">Scopus</span>' : `<span class="tag bad" title="${esc(sc.discontinued || 'Inactive in Scopus')}">Scopus: discontinued</span>`);
    else if (sc.indexed === false) c.push('<span class="tag" title="Not in the Scopus source list">Not in Scopus</span>');
    else c.push('<span class="tag" title="Scopus list not loaded yet">Scopus: ?</span>');
    if (j.sjr && j.sjr.quartile) c.push(`<span class="tag ${j.sjr.quartile === 'Q1' ? 'ok' : j.sjr.quartile === 'Q2' ? '' : 'warn'}" title="SCImago ${esc(j.sjr.year || '')}: SJR ${esc(j.sjr.sjr)} · h-index ${esc(j.sjr.h_index)}">SJR ${esc(j.sjr.quartile)}</span>`);
    const w = arr((j.wos || {}).collections);
    if (w.length) w.forEach(x => c.push(`<span class="tag ${x === 'ESCI' ? '' : 'ok'}" title="Web of Science ${esc(x)}">WoS ${esc(x)}</span>`));
    if (j.abdc) c.push(`<span class="tag ${/A/.test(j.abdc.rating) ? 'ok' : ''}" title="ABDC 2025 rating">ABDC ${esc(j.abdc.rating)}</span>`);
    const oa = j.oa || {};
    if (oa.diamond) c.push('<span class="tag ok" title="Open access with no author fee">OA · no fee</span>');
    else if (oa.is_oa) c.push(`<span class="tag warn" title="Fully open access">OA${oa.apc_usd != null ? ' · APC $' + esc(Math.round(oa.apc_usd)) : oa.apc_doaj ? ' · ' + esc(oa.apc_doaj) : ''}</span>`);
    else c.push('<span class="tag" title="Subscription or hybrid journal">Subscription / hybrid</span>');
    if (oa.in_doaj) c.push('<span class="tag" title="Listed in DOAJ">DOAJ</span>');
    return c.join(' ');
  }
  function viewJournalFit(JF, opts) {
    opts = opts || {};
    if (!JF || !JF.ok) return `<div class="card empty">${esc((JF && JF.error) || 'No journal suggestions yet.')}</div>`;
    const L = JF.lists || {};
    const li = (k, n) => { const m = L[k]; return m && m.rows ? `<span class="tag ok" title="${esc(m.file || '')}">${n}: ${esc(m.rows)} · ${esc(fmtDate(m.refreshed_at).split(',')[0])}</span>` : `<span class="tag">${n}: not loaded</span>`; };
    const wos = Object.keys(L).filter(k => k.startsWith('wos'));
    const jcard = (j, isT) => `
      <div class="comment jf-row" data-q="${esc(j.sjr && QORD[j.sjr.quartile] || 9)}" data-cite="${esc((j.metrics || {}).two_yr_mean_citedness || 0)}" data-fit="${esc(j.fit_score)}">
        <div style="display:flex;gap:12px;justify-content:space-between;align-items:flex-start;flex-wrap:wrap">
          <div style="min-width:240px;flex:1">
            <div style="font-size:16px">${isT ? '<span class="tag warn">Your choice</span> ' : `<b class="muted">#${esc(j.rank)}</b> `}<b>${esc(j.title)}</b></div>
            <div class="muted" style="font-size:13px">${esc(j.publisher || '—')}${arr(j.issns).length ? ' · ISSN ' + j.issns.map(esc).join(', ') : ''}${j.country ? ' · ' + esc(j.country) : ''}</div>
            <div style="margin-top:6px">${jfChips(j)}</div>
          </div>
          <div style="text-align:right;min-width:150px">
            <div style="font:600 22px var(--sans)">${esc(j.fit_score)}<span class="muted" style="font-size:13px"> / 100</span></div>
            <div class="muted" style="font-size:12px">${esc(j.fit_label)} fit${j.ai_fit ? ' · AI: ' + esc(j.ai_fit) : ''}</div>
            <div class="bar" style="margin:4px 0 0;height:6px"><div style="width:${Math.max(3, Math.min(100, +j.fit_score || 0))}%"></div></div>
          </div>
        </div>
        ${j.reason ? `<p style="margin:8px 0 0;font-size:14px">${esc(j.reason)}</p>` : ''}
        ${j.caution ? `<p class="muted" style="margin:4px 0 0;font-size:13px"><b>Watch out:</b> ${esc(j.caution)}</p>` : ''}
        ${isT && j.note ? `<p class="muted" style="margin:4px 0 0;font-size:13px">${esc(j.note)}</p>` : ''}
        ${isT && arr(j.excluded_because).length ? `<p style="margin:4px 0 0;font-size:13px"><span class="tag bad">Does not meet your filters</span> ${j.excluded_because.map(esc).join('; ')}</p>` : ''}
        <div class="muted" style="font-size:13px;margin-top:6px">${esc(j.matched_papers || 0)} similar paper${j.matched_papers === 1 ? '' : 's'} since ${new Date().getFullYear() - 6}${(j.metrics || {}).two_yr_mean_citedness != null ? ' · 2-yr mean citations ' + esc(j.metrics.two_yr_mean_citedness) : ''}${(j.metrics || {}).h_index ? ' · h-index ' + esc(j.metrics.h_index) : ''}${(j.oa || {}).weeks_to_publish ? ' · ~' + esc(j.oa.weeks_to_publish) + ' weeks to publication (DOAJ)' : ''}${(j.oa || {}).review ? ' · ' + esc(j.oa.review) : ''}</div>
        ${arr(j.sample_titles).length ? `<details style="margin-top:6px"><summary style="font-size:13px;cursor:pointer">Similar papers it published</summary><ul class="clean" style="font-size:13px">${j.sample_titles.map(t => `<li>${esc(t)}</li>`).join('')}</ul></details>` : ''}
        ${j.sjr && j.sjr.categories ? `<p class="muted" style="font-size:12px;margin:4px 0 0">SJR categories: ${esc(j.sjr.categories)}</p>` : ''}
        <p style="font-size:13px;margin:6px 0 0">${[['homepage', 'Journal site'], ['scopus', 'Scopus'], ['sjr', 'SCImago'], ['mjl', 'Web of Science (MJL)'], ['doaj', 'DOAJ'], ['openalex', 'OpenAlex']].filter(l => (j.links || {})[l[0]]).map(l => `<a href="${esc(j.links[l[0]])}" target="_blank" rel="noopener">${l[1]}</a>`).join(' · ')}${isT ? '' : ` · <button class="btn btn-sm btn-ghost" data-usetarget="${esc(j.title)}" style="padding:2px 8px">Use as target journal</button>`}</p>
      </div>`;
    const ex = Object.entries(JF.excluded || {});
    return `
      <div class="card">
        <div class="card-head"><h2>${opts.title || 'Best-fit journals'}</h2><small>${esc(JF.considered || 0)} journals considered · ${esc(JF.similar_papers_found || 0)} similar papers</small></div>
        <p style="font-size:13px;margin-top:0">${li('scopus', 'Scopus')} ${li('sjr', 'SJR')} ${wos.length ? wos.map(k => li(k, 'WoS ' + (k.split(':')[1] || ''))).join(' ') : '<span class="tag">WoS: not loaded</span>'} ${li('abdc', 'ABDC')} <span class="tag ok">OpenAlex · DOAJ live</span></p>
        ${ex.length ? `<p class="muted" style="font-size:13px">Removed by your filters: ${ex.map(([k, n]) => esc(k) + ' (' + n + ')').join(' · ')}</p>` : ''}
        <div class="toolbar"><span class="muted" style="font-size:13px">Sort:</span>
          <button class="btn btn-sm btn-primary" data-jfsort="fit">Best fit</button><button class="btn btn-sm btn-ghost" data-jfsort="q">SJR quartile</button><button class="btn btn-sm btn-ghost" data-jfsort="cite">Citations</button>
          <button class="btn btn-sm btn-ghost" data-jfcsv>Export CSV</button>${opts.rerun ? '<button class="btn btn-sm btn-ghost" data-jfrerun>Change filters</button>' : ''}</div>
        ${JF.target ? jcard(JF.target, true) : ''}
        <div class="jf-list">${arr(JF.journals).map(j => jcard(j, false)).join('') || '<p class="muted">No journal passed your filters. Loosen a filter and try again.</p>'}</div>
        ${arr(JF.notes).length ? `<ul class="clean muted" style="font-size:13px;margin-top:10px">${JF.notes.map(n => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}
        ${arr((JF.query || {}).search_phrases).length ? `<p class="sources">Searches: ${JF.query.search_phrases.map(esc).join(' · ')}</p>` : ''}
      </div>`;
  }
  function wireJournalFit(JF, root) {
    if (!root || !JF || !JF.ok) return;
    $$('[data-jfsort]', root).forEach(b => b.addEventListener('click', () => {
      $$('[data-jfsort]', root).forEach(x => { x.classList.toggle('btn-primary', x === b); x.classList.toggle('btn-ghost', x !== b); });
      const list = $('.jf-list', root); const rows = $$('.jf-row', list);
      const k = b.dataset.jfsort;
      rows.sort((a, c) => k === 'q' ? (+a.dataset.q - +c.dataset.q) || (+c.dataset.fit - +a.dataset.fit) : k === 'cite' ? (+c.dataset.cite - +a.dataset.cite) : (+c.dataset.fit - +a.dataset.fit)).forEach(r => list.appendChild(r));
    }));
    $$('[data-usetarget]', root).forEach(b => b.addEventListener('click', () => {
      store.set('jfUseTarget', b.dataset.usetarget);
      toast('Target journal set: ' + b.dataset.usetarget);
      location.hash = '#/';
    }));
    const csv = $('[data-jfcsv]', root);
    if (csv) csv.addEventListener('click', () => {
      const head = ['Rank', 'Journal', 'Publisher', 'ISSN', 'Fit score', 'AI fit', 'Reason', 'Caution', 'Scopus', 'SJR quartile', 'SJR', 'WoS', 'ABDC', 'Open access', 'APC USD', 'DOAJ', '2-yr mean citations', 'h-index', 'Similar papers', 'Homepage'];
      const rows = arr(JF.journals).map(j => [j.rank, j.title, j.publisher, arr(j.issns).join(' '), j.fit_score, j.ai_fit, j.reason, j.caution, (j.scopus || {}).indexed === true ? ((j.scopus.active ? 'Active' : 'Discontinued')) : (j.scopus || {}).indexed === false ? 'No' : 'Unknown', j.sjr ? j.sjr.quartile : '', j.sjr ? j.sjr.sjr : '', arr((j.wos || {}).collections).join(' '), j.abdc ? j.abdc.rating : '', (j.oa || {}).diamond ? 'Diamond' : (j.oa || {}).is_oa ? 'Yes' : 'No', (j.oa || {}).apc_usd, (j.oa || {}).in_doaj ? 'Yes' : '', (j.metrics || {}).two_yr_mean_citedness, (j.metrics || {}).h_index, j.matched_papers, j.homepage]);
      download('journal-finder.csv', [head].concat(rows).map(r => r.map(csvCell).join(',')).join('\n'), 'text/csv');
    });
  }

  // Journal fit tab inside a review: uses result.journal_fit when the engine produced it, otherwise runs on demand
  function jfPaperFromReview(R) {
    const M = R.meta || {}, I = R.inventory || {};
    const kw = arr(I.keywords).length ? I.keywords.join('; ') : (M.keywords || '');
    return { title: M.title || '', abstract: I.abstract || R.abstract || M.abstract || '', keywords: kw, field: M.field || '', article_type: M.article_type || '', target_journal: M.target_journal || '', max_results: 15 };
  }
  function viewJournalFitTab(R, id) {
    const JF = R.journal_fit || store.get('jf:' + id, null);
    if (JF && JF.ok) return `<div id="jfTab">${viewJournalFit(JF, { rerun: true })}</div>`;
    return `<div id="jfTab"><div class="card"><div class="card-head"><h2>Best-fit journals</h2><small>free sources only</small></div>
      <p class="muted" style="margin-top:0">Find the journals that publish papers most like this one, checked against the Scopus list, SCImago quartiles, Web of Science, ABDC and DOAJ.</p>
      ${JF && JF.error ? `<p class="form-error">${esc(JF.error)}</p>` : ''}
      <button class="btn btn-primary" id="jfRun">Find best-fit journals</button> <button class="btn btn-ghost" data-jfrerun>Open with filters</button></div></div>`;
  }
  function wireJournalFitTab(R, id, demo) {
    const root = $('#jfTab'); if (!root) return;
    const JF = R.journal_fit || store.get('jf:' + id, null);
    if (JF && JF.ok) wireJournalFit(JF, root);
    const open = () => { store.set('jfPrefill', jfPaperFromReview(R)); location.hash = '#/journals'; };
    $$('[data-jfrerun]', root).forEach(b => b.addEventListener('click', open));
    const run = $('#jfRun', root);
    if (run) run.addEventListener('click', async () => {
      if (demo) { open(); return; }
      if (!settings().key) { openSettings('Add your access key first.'); return; }
      run.disabled = true; run.innerHTML = '<span class="spinner"></span> Searching… (about 20–40 seconds)';
      try {
        const p = jfPaperFromReview(R);
        const r = await apiPostForm(JF_PATH, Object.assign({}, p, { private: (R.meta || {}).private_mode ? 'true' : '', filters: JSON.stringify(store.get('jfFilters', {}) || {}) }));
        store.set('jf:' + id, r); root.outerHTML = viewJournalFitTab(R, id); wireJournalFitTab(R, id, demo);
      } catch (x) { run.disabled = false; run.textContent = 'Find best-fit journals'; toast(x.message || 'Search failed'); }
    });
  }

  // ---------- Writing from scratch (separate from the review tabs) ----------
  const W = window.Q1Write;
  const PL = window.Q1Plan;
  const WRITE_PATH = CFG.writePath || '/q1-write-section';
  const DATA_PATH = CFG.dataPath || '/q1-data-analysis';
  const STYLES = [['apa7', 'APA 7'], ['harvard', 'Harvard'], ['vancouver', 'Vancouver'], ['chicago', 'Chicago (author-date)'], ['ieee', 'IEEE'], ['mla', 'MLA 9']];
  const MODIFICATIONS = [['argumentative', 'Argumentative'], ['discussion', 'Discussion-based'], ['analytical', 'Analytical'], ['theory', 'Theory-based (aligning theory)']];
  // Paragraphs are separated by a blank line.
  const paraList = t => String(t || '').split(/\n\s*\n/).map(x => x.trim()).filter(Boolean);
  const STATE_TAG = {
    drafted: ['ok', 'drafted'], ready: ['', 'ready to write'], needs_input: ['warn', 'needs input'], locked: ['', 'locked'], missing: ['', 'unknown']
  };

  // The modification-type choice and the actions for a paragraph or a whole section.
  const modSelect = () => `<select data-mtype style="font-size:13px"><option value="">Modification type…</option>${MODIFICATIONS.map(m => `<option value="${m[0]}">${m[1]}</option>`).join('')}</select>`;
  const actionButtons = (sid, idx, first) => `<button class="btn btn-sm" type="button" data-revise="connect" data-sec-id="${esc(sid)}" data-idx="${idx}"${first ? ' disabled title="The first paragraph has no previous paragraph to connect to"' : ''}>Modify to suit previous paragraph</button>
      <button class="btn btn-sm" type="button" data-discuss-toggle="${esc(sid)}:${idx}">Modify by AI discussion</button>
      <button class="btn btn-sm" type="button" data-revise="cite" data-sec-id="${esc(sid)}" data-idx="${idx}">Add content and literature</button>`;
  const discussBox = (sid, idx) => `<div data-discuss-box="${esc(sid)}:${idx}" hidden style="margin-top:6px"><textarea rows="2" data-instr="${esc(sid)}:${idx}" placeholder="What should change? e.g. argue that the cost barrier is overstated" style="width:100%"></textarea><button class="btn btn-sm" type="button" data-revise="discuss" data-sec-id="${esc(sid)}" data-idx="${idx}" style="margin-top:4px">Run the change</button></div>`;
  // The outline of a section: one paragraph per content point, with its planned words.
  function outlineHtml(sid, points, words) {
    const items = PL.outlineOf(points, words);
    if (!items.length) return '';
    return `<div style="font-size:14px;margin:6px 0 8px"><b>Outline</b> <i class="muted">(one paragraph per point)</i><ol style="margin:4px 0 0 18px">${items.map(o => `<li>${esc(o.point)} <span class="muted">· ${o.words} words</span></li>`).join('')}</ol></div>`;
  }
  // A "+" between paragraphs: insert a paragraph typed by hand, or written by AI from a point.
  const insertBar = (sid, j) => `<div style="margin:4px 0"><button class="btn btn-ghost btn-sm" type="button" title="Insert a paragraph here" data-insert-toggle="${esc(sid)}:${j}">+</button>
      <div data-insert-box="${esc(sid)}:${j}" hidden style="margin-top:6px"><textarea rows="2" data-insert-text="${esc(sid)}:${j}" placeholder="The point for the new paragraph, or the paragraph itself" style="width:100%"></textarea>
      <div style="display:flex;gap:6px;margin-top:4px"><button class="btn btn-sm" type="button" data-insert-ai="${esc(sid)}:${j}">Write with AI from this point</button><button class="btn btn-sm" type="button" data-insert-own="${esc(sid)}:${j}">Insert as typed</button></div></div></div>`;
  function renderParas(sid, text) {
    const paras = paraList(text);
    return insertBar(sid, 0) + paras.map((p, j) => `
      <div class="para" style="border-left:3px solid #d9d2c3;padding-left:10px;margin:10px 0">
        <textarea rows="4" data-para="${esc(sid)}" data-idx="${j}" style="width:100%">${esc(p)}</textarea>
        <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-top:6px">${modSelect()} ${actionButtons(sid, j, j === 0)}</div>
        ${discussBox(sid, j)}
      </div>${insertBar(sid, j + 1)}`).join('');
  }
  // Same actions on the whole section, for changes that span paragraphs.
  function sectionTools(sid) {
    return `<div style="border-top:1px dashed #d9d2c3;padding-top:8px;margin-top:8px">
      <div style="font-size:13px;margin-bottom:6px"><b>Whole section</b></div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center">${modSelect()}
        <button class="btn btn-sm" type="button" data-discuss-toggle="${esc(sid)}:all">Modify by AI discussion</button>
        <button class="btn btn-sm" type="button" data-revise="cite" data-sec-id="${esc(sid)}" data-idx="all">Add content and literature</button></div>
      ${discussBox(sid, 'all')}</div>`;
  }

  // The analysis results: the sentences ready for Results, with the reliabilities and fit shown.
  function renderDataResults(r) {
    if (!r || !r.sentences || !r.sentences.length) return '';
    return `<div style="margin-top:12px;border-top:1px solid #e3dccb;padding-top:10px">
      <b>Results (check each sentence before you use it)</b>
      <ul style="font-size:14px;line-height:1.5">${r.sentences.map(x => `<li>${esc(x)}</li>`).join('')}</ul>
      <button class="btn btn-sm" type="button" id="daInsert">Insert these results into Results</button></div>`;
  }

  function renderWriting() {
    const base = { type: 'empirical:q1', style: 'apa7', title: '', topic: '', question: '', aims: '', notes: '', results: '', target: 6000, budgets: {}, points: {} };
    const proj = Object.assign({}, base, store.get('wr:project', {}) || {});
    const drafts = store.get('wr:drafts', {}) || {};
    const da = store.get('wr:analysis', {}) || {};
    const type = W.REPORT_TYPES[proj.type] ? proj.type : 'empirical:q1';
    const sections = W.REPORT_TYPES[type].sections;
    const outline = PL.buildOutline(type, proj.target, proj.budgets || {});
    const defaults = PL.buildOutline(type, proj.target, {});
    const words = id => (outline.sections.find(x => x.id === id) || { words: 0 }).words;
    const statusOf = id => PL.sectionStatus(type, id, proj, drafts, proj.points || {});
    const field = (name, label, value, hint, rows) => `<label class="field"><span>${label}${hint ? ` <i>${hint}</i>` : ''}</span>${rows ? `<textarea name="${name}" rows="${rows}">${esc(value)}</textarea>` : `<input type="text" name="${name}" value="${esc(value)}">`}</label>`;
    const typeOptions = Object.keys(W.REPORT_TYPES).map(k => `<option value="${k}"${k === type ? ' selected' : ''}>${esc(W.REPORT_TYPES[k].label)}</option>`).join('');
    const styleOptions = STYLES.map(o => `<option value="${o[0]}"${o[0] === proj.style ? ' selected' : ''}>${o[1]}</option>`).join('');
    const body = sections.filter(s => s.id !== 'references');
    const allRefs = [];
    Object.values(drafts).forEach(d => (d.references || []).forEach(r => { if (!allRefs.some(x => x.key === r.key)) allRefs.push(r); }));

    app.innerHTML = `
      <section class="card">
        <div class="card-head" style="margin-bottom:6px"><h1 style="margin:0">Writing from scratch</h1><small>separate from review results</small></div>
        <p class="muted" style="margin-top:0">Write a new paper, proposal, chapter or book from your own topic. Each section unlocks when the sections it depends on are written and it has its content points and the data it needs. Sources are searched and cited the same way as the literature review.</p>
        ${settings().key ? '' : '<div class="keywarn">Add your access key in <a href="#" id="wrKey">Settings</a> first.</div>'}
        <form id="wrForm" novalidate>
          <div class="grid-2">
            <label class="field"><span>Report type</span><select name="type">${typeOptions}</select></label>
            <label class="field"><span>Citation style</span><select name="style">${styleOptions}</select></label>
            <label class="field"><span>Total length (words)</span><input type="number" name="target" min="300" max="60000" step="100" value="${esc(proj.target)}"></label>
          </div>
          ${field('title', 'Working title', proj.title)}
          ${field('topic', 'Topic and context', proj.topic, 'required', 3)}
          ${field('question', 'Research question', proj.question, 'required', 2)}
          ${field('aims', 'Aims or objectives', proj.aims, 'optional', 2)}
          ${field('notes', 'Data, method and other notes', proj.notes, 'needed for Methodology: sample, design, tools, dates', 3)}
          ${field('results', 'Results or data', proj.results, 'needed for Findings and Data analysis: figures, tables, key findings', 4)}
          <button class="btn btn-primary" type="submit">Save project details</button>
          <span class="muted" id="wrSaved" style="margin-left:8px;font-size:14px"></span>
        </form>
      </section>

      <section class="card" style="margin-top:16px">
        <div class="card-head" style="margin-bottom:8px"><h2 style="margin:0">Outline and word budgets</h2><small>${esc(W.REPORT_TYPES[type].label)}</small></div>
        <p class="muted" style="font-size:14px;margin-top:0">The total is split across the sections by their weight. Change any budget, then save. Budgets for abstracts and other fixed parts stay as they are.</p>
        <form id="wrOutline">
          <div style="display:grid;grid-template-columns:1fr 110px 1fr;gap:6px 12px;align-items:center;font-size:14px">
            <b>Section</b><b>Words</b><b>Waits for</b>
            ${outline.sections.map(s => `
              <span>${esc(s.title)}${s.fixed ? ' <i class="muted">(fixed)</i>' : ''}</span>
              <input type="number" name="b_${esc(s.id)}" min="0" step="10" value="${s.words}" ${s.fixed ? 'disabled' : ''}>
              <span class="muted">${s.dependsOn.length ? s.dependsOn.map(d => esc((sections.find(x => x.id === d) || { title: d }).title)).join(', ') : 'nothing'}</span>`).join('')}
          </div>
          <p style="font-size:14px;margin:12px 0 6px"><b>Total: ${outline.total.toLocaleString('en-IN')} words</b> for a target of ${Number(proj.target).toLocaleString('en-IN')} ${outline.withinTolerance ? '<span class="tag ok">on target</span>' : '<span class="tag warn">more than 10% away from the target</span>'}</p>
          <button class="btn btn-sm" type="submit">Save budgets</button>
          <span class="muted" id="wrOutlineSaved" style="margin-left:8px;font-size:14px"></span>
        </form>
      </section>

      <section class="card" style="margin-top:16px">
        <div class="card-head" style="margin-bottom:8px"><h2 style="margin:0">Data analysis</h2><small>upload a dataset, run the analyses, then insert the results into Results</small></div>
        <p class="muted" style="font-size:14px;margin-top:0">The dataset (CSV, XLSX or SAV) is analysed on the server and is not stored. Only the results are kept in this browser.</p>
        <label class="field"><span>Dataset</span><input type="file" id="daFile" accept=".csv,.xlsx,.xls,.sav"></label>
        <label class="field"><span>Constructs <i>one per line: Name: item1, item2, item3</i></span><textarea id="daConstructs" rows="4" placeholder="Service quality: SQ1, SQ2, SQ3&#10;Satisfaction: SAT1, SAT2, SAT3">${esc(da.constructs || '')}</textarea></label>
        <label class="field"><span>Paths <i>one per line: From -> To</i></span><textarea id="daPaths" rows="2" placeholder="Service quality -> Satisfaction">${esc(da.paths || '')}</textarea></label>
        <div class="grid two">
          <label class="field"><span>Method</span><select id="daMethod"><option value="PLS"${da.method !== 'CB' ? ' selected' : ''}>PLS-SEM</option><option value="CB"${da.method === 'CB' ? ' selected' : ''}>CB-SEM (CFA)</option></select></label>
          <label class="field"><span>Bootstrap resamples</span><input type="number" id="daBoot" min="0" max="1000" value="${esc(da.boot || 200)}"></label>
        </div>
        <label class="field"><span>Variables to describe <i>comma-separated column names</i></span><input type="text" id="daDescribe" value="${esc(da.describe || '')}"></label>
        <div class="grid two">
          <label class="field"><span>Regression outcome <i>optional</i></span><input type="text" id="daY" value="${esc(da.y || '')}"></label>
          <label class="field"><span>Regression predictors <i>comma-separated</i></span><input type="text" id="daX" value="${esc(da.x || '')}"></label>
        </div>
        <button class="btn btn-primary" type="button" id="daRun">Run analysis</button>
        <div id="daStatus" class="muted" style="font-size:14px;margin-top:8px" aria-live="polite"></div>
        <div id="daOut">${renderDataResults(da.results)}</div>
      </section>

      <section class="card" style="margin-top:16px">
        <div class="card-head" style="margin-bottom:8px"><h2 style="margin:0">Sections</h2><button class="btn btn-ghost btn-sm" id="wrAll" type="button">Write every ready section</button></div>
        <p class="muted" style="font-size:14px;margin-top:0">A section can be written only when it is ready: its content points are filled in, the data it needs is saved, and the sections it waits for are written.</p>
        <div id="wrStatus" class="muted" style="font-size:14px;margin-bottom:10px" aria-live="polite"></div>
        ${body.map((s, i) => {
          const st = statusOf(s.id);
          const d = drafts[s.id] || {};
          const [cls, label] = STATE_TAG[st.state] || STATE_TAG.missing;
          const counted = d.text ? PL.lengthCheck(d.text, words(s.id)) : null;
          const waits = st.blockedBy.length ? `<p class="muted" style="font-size:14px;margin:4px 0">Waits for: ${st.blockedBy.map(esc).join(', ')}</p>` : '';
          const needs = st.missing.length && st.state === 'needs_input' ? `<p style="font-size:14px;margin:4px 0;color:#9a4b00">Still needed: ${st.missing.map(esc).join('; ')}</p>` : '';
          return `
          <article class="finding" data-sec="${esc(s.id)}" style="margin-bottom:12px">
            <div class="finding-top"><span class="id">${i + 1}</span><b>${esc(s.title)}</b><span class="tag ${cls}">${label}</span><span class="muted" style="font-size:13px">${words(s.id)} words planned</span></div>
            <p class="muted" style="font-size:14px;margin:4px 0 8px">${esc(s.brief)}</p>
            ${waits}${needs}
            <button class="btn btn-ghost btn-sm" type="button" data-hint-toggle="${esc(s.id)}" aria-expanded="false">+ Hint for this section</button>
            <div data-hint-box="${esc(s.id)}" hidden style="margin:8px 0">
              <label class="field"><span>Hint <i>a topic or angle; the literature and the text are framed around it, e.g. “causes of bone marrow disease”</i></span><textarea rows="2" data-hint="${esc(s.id)}">${esc((proj.hints || {})[s.id] || '')}</textarea></label>
            </div>
            <label class="field"><span>Content points for this section <i>one per line</i></span><textarea rows="3" data-points="${esc(s.id)}">${esc((proj.points || {})[s.id] || '')}</textarea></label>
            ${outlineHtml(s.id, (proj.points || {})[s.id] || '', words(s.id))}
            <button class="btn btn-sm" type="button" data-write="${esc(s.id)}" ${st.state === 'ready' || st.state === 'drafted' ? '' : 'disabled'}>${d.text ? 'Write again' : 'Write this section'}</button>
            ${counted ? `<span class="muted" style="font-size:13px;margin-left:8px">${counted.count} of ${counted.words} words ${counted.ok ? '' : '(outside 10%)'}</span>` : ''}
            <div data-out="${esc(s.id)}">${d.text ? renderParas(s.id, d.text) : ''}</div>
            ${d.text ? sectionTools(s.id) : ''}
          </article>`;
        }).join('')}
        ${sections.some(s => s.id === 'references') ? `
          <article class="finding" style="margin-bottom:12px">
            <div class="finding-top"><b>References</b><span class="tag">${allRefs.length ? 'built from the drafts' : 'after the drafts'}</span></div>
            <p class="muted" style="font-size:14px;margin:4px 0">Built from the sources cited in the written sections.</p>
            ${allRefs.length ? `<ol style="font-size:14px;line-height:1.5">${allRefs.map(r => `<li>${esc(r.text)}</li>`).join('')}</ol>` : ''}
          </article>` : ''}
      </section>`;

    $('#wrForm').addEventListener('submit', e => {
      e.preventDefault();
      const f = new FormData(e.target);
      const prev = store.get('wr:project', {}) || {};
      const next = Object.assign({}, prev, {
        type: f.get('type'), style: f.get('style'), target: Math.max(300, Number(f.get('target')) || 6000),
        title: f.get('title') || '', topic: f.get('topic') || '', question: f.get('question') || '', aims: f.get('aims') || '', notes: f.get('notes') || '', results: f.get('results') || ''
      });
      store.set('wr:project', next);
      $('#wrSaved').textContent = 'Saved in this browser.';
      renderWriting();
    });
    const wrKey = $('#wrKey'); if (wrKey) wrKey.addEventListener('click', e => { e.preventDefault(); openSettings(); });

    $('#wrOutline').addEventListener('submit', e => {
      e.preventDefault();
      const f = new FormData(e.target);
      const cur = store.get('wr:project', proj) || proj;
      const budgets = {};
      outline.sections.forEach(s => {
        if (s.fixed) return;
        const v = Number(f.get('b_' + s.id));
        if (!Number.isFinite(v)) return;
        const dflt = (defaults.sections.find(x => x.id === s.id) || {}).words;
        if (v !== dflt) budgets[s.id] = Math.max(0, Math.round(v));
      });
      store.set('wr:project', Object.assign({}, cur, { budgets }));
      $('#wrOutlineSaved').textContent = 'Budgets saved.';
      renderWriting();
    });

    // Data analysis: the settings are saved as they change, and the dataset is sent to the server only when you run it.
    const saveDa = patch => { store.set('wr:analysis', Object.assign({}, store.get('wr:analysis', {}) || {}, patch)); };
    [['daConstructs', 'constructs'], ['daPaths', 'paths'], ['daBoot', 'boot'], ['daDescribe', 'describe'], ['daY', 'y'], ['daX', 'x']].forEach(([id, key]) => {
      const el = $('#' + id); if (el) el.addEventListener('change', () => saveDa({ [key]: el.value }));
    });
    const daMethodEl = $('#daMethod'); if (daMethodEl) daMethodEl.addEventListener('change', () => saveDa({ method: daMethodEl.value }));

    const daStatus = t => { const el = $('#daStatus'); if (el) el.textContent = t; };
    const parseConstructs = text => String(text || '').split('\n').map(l => l.trim()).filter(Boolean).map(l => {
      const i = l.indexOf(':');
      return { name: (i < 0 ? l : l.slice(0, i)).trim(), items: (i < 0 ? [] : l.slice(i + 1).split(',')).map(x => x.trim()).filter(Boolean) };
    }).filter(c => c.name && c.items.length);
    const parsePaths = text => String(text || '').split('\n').map(l => l.trim()).filter(Boolean).map(l => {
      const [from, to] = l.split('->').map(x => (x || '').trim());
      return { from, to };
    }).filter(p => p.from && p.to);
    const csvList = t => String(t || '').split(',').map(x => x.trim()).filter(Boolean);

    const daRun = $('#daRun');
    if (daRun) daRun.addEventListener('click', async () => {
      const file = $('#daFile').files && $('#daFile').files[0];
      if (!file) { daStatus('Choose a dataset first.'); return; }
      if (!settings().key) { daStatus('Add your access key in Settings first.'); return; }
      const constructs = parseConstructs($('#daConstructs').value);
      const paths = parsePaths($('#daPaths').value);
      const y = $('#daY').value.trim(), x = csvList($('#daX').value);
      const spec = {
        method: $('#daMethod').value,
        bootstrap: Math.max(0, Math.min(1000, Number($('#daBoot').value) || 200)),
        constructs, paths,
        describe: csvList($('#daDescribe').value),
        correlations: csvList($('#daDescribe').value).length >= 2 ? csvList($('#daDescribe').value) : undefined,
        regression: y && x.length ? { y, x } : undefined
      };
      if (!constructs.length && !spec.describe.length && !spec.regression) { daStatus('Add constructs, variables to describe, or a regression.'); return; }
      const fd = new FormData();
      fd.append('key', settings().key);
      fd.append('file', file, file.name);
      fd.append('spec', JSON.stringify(spec));
      daStatus('Running the analysis on the server… this can take a minute with bootstrapping.');
      daRun.disabled = true;
      try {
        const d = await apiJson(await fetch(apiUrl(DATA_PATH), { method: 'POST', body: fd }));
        saveDa({ constructs: $('#daConstructs').value, paths: $('#daPaths').value, boot: $('#daBoot').value, describe: $('#daDescribe').value, y, x: $('#daX').value, method: spec.method, results: d });
        $('#daOut').innerHTML = renderDataResults(d);
        bindInsert();
        daStatus(d.sentences && d.sentences.length ? 'Analysis finished.' : 'The analysis returned no results. Check the constructs and variable names.');
      } catch (e) {
        daStatus(/\(404\)/.test(e.message) ? 'Not connected yet: the data analysis step is not set up on the server.' : 'Could not run the analysis: ' + e.message);
      } finally { daRun.disabled = false; }
    });

    function bindInsert() {
      const btn = $('#daInsert');
      if (!btn) return;
      btn.addEventListener('click', () => {
        const res = (store.get('wr:analysis', {}) || {}).results || {};
        const cur = store.get('wr:project', proj) || proj;
        const add = (res.sentences || []).join('\n');
        store.set('wr:project', Object.assign({}, cur, { results: [cur.results || '', add].filter(Boolean).join('\n') }));
        renderWriting();
        daStatus('Results added. Check them in the Results box above.');
      });
    }
    bindInsert();

    app.querySelectorAll('textarea[data-points]').forEach(t => t.addEventListener('change', () => {
      const cur = store.get('wr:project', proj) || proj;
      const points = Object.assign({}, cur.points || {}, { [t.dataset.points]: t.value });
      store.set('wr:project', Object.assign({}, cur, { points }));
      renderWriting();
    }));

    const setStatus = t => { const el = $('#wrStatus'); if (el) el.textContent = t; };

    // Writes one section. It is refused unless the section is ready, so the gating holds even if the page is stale.
    const writeOne = async (id, btn) => {
      const cur = store.get('wr:project', proj) || proj;
      const d0 = store.get('wr:drafts', {}) || {};
      const st = PL.sectionStatus(type, id, cur, d0, cur.points || {});
      const title = (sections.find(x => x.id === id) || { title: id }).title;
      if (st.state !== 'ready' && st.state !== 'drafted') { setStatus(`“${title}” is not ready: ${st.blockedBy.length ? 'waiting for ' + st.blockedBy.join(', ') : st.missing.join('; ')}.`); return false; }
      const outNow = PL.buildOutline(type, cur.target, cur.budgets || {});
      const planned = (outNow.sections.find(x => x.id === id) || { words: 0 }).words;
      const idx = sections.findIndex(s => s.id === id);
      const prior = sections.slice(0, idx).filter(s => d0[s.id] && d0[s.id].text).map(s => ({ title: s.title, text: d0[s.id].text }));
      const project = { title: cur.title, topic: cur.topic, question: cur.question, aims: cur.aims, notes: cur.notes, results: cur.results };
      const items = PL.outlineOf((cur.points || {})[id] || '', planned);
      if (btn) btn.disabled = true;
      try {
        const paras = [], labels = {}, refs = [];
        for (let i = 0; i < items.length; i++) {
          setStatus(`Writing “${title}”: paragraph ${i + 1} of ${items.length} (${items[i].words} words)… this can take up to a minute each.`);
          const body = { action: 'paragraph', type, section: id, point: items[i].point, words: items[i].words, position: i + 1, total: items.length, priorParagraphs: paras.join('\n\n'), hint: (cur.hints || {})[id] || '', style: cur.style, project: JSON.stringify(project), prior: JSON.stringify(prior) };
          const d = await apiPostForm(WRITE_PATH, body);
          if (!d.ok) throw new Error(d.reason || 'A paragraph could not be written.');
          paras.push((d.text || '').trim());
          Object.assign(labels, d.labels || {});
          (d.references || []).forEach(r => { if (!refs.some(o => o.text === r.text)) refs.push(r); });
          const all = store.get('wr:drafts', {}) || {};
          all[id] = { text: paras.join('\n\n'), labels, references: refs, words: planned, at: new Date().toISOString() };
          store.set('wr:drafts', all);
        }
        setStatus(`“${title}” written: ${items.length} paragraphs, about ${PL.countWords(paras.join(' '))} words against ${planned} planned. Check each paragraph and use the + between them to add more.`);
        return true;
      } catch (e) {
        setStatus(/\(404\)/.test(e.message) ? 'Not connected yet: the section writer is not set up on the server.' : `Could not write “${title}”: ${e.message}`);
        return false;
      } finally { if (btn) btn.disabled = false; }
    };

    app.querySelectorAll('button[data-write]').forEach(b => b.addEventListener('click', async () => {
      if (!settings().key) { setStatus('Add your access key in Settings first.'); return; }
      const ok = await writeOne(b.dataset.write, b);
      if (ok) renderWriting();
    }));

    // Writes ready sections one after another. Each finished section can unlock the next.
    $('#wrAll').addEventListener('click', async e => {
      if (!settings().key) { setStatus('Add your access key in Settings first.'); return; }
      e.target.disabled = true;
      for (let guard = 0; guard < 20; guard++) {
        const cur = store.get('wr:project', proj) || proj, d0 = store.get('wr:drafts', {}) || {};
        const next = sections.find(s => s.id !== 'references' && PL.sectionStatus(type, s.id, cur, d0, cur.points || {}).state === 'ready');
        if (!next) break;
        const ok = await writeOne(next.id, null);
        if (!ok) break;
      }
      e.target.disabled = false;
      renderWriting();
    });

    // Hint: opens the section's hint field and saves what is typed.
    app.querySelectorAll('button[data-hint-toggle]').forEach(b => b.addEventListener('click', () => {
      const box = app.querySelector(`[data-hint-box="${b.dataset.hintToggle}"]`);
      const open = box.hidden; box.hidden = !open; b.setAttribute('aria-expanded', String(open));
    }));
    app.querySelectorAll('textarea[data-hint]').forEach(t => t.addEventListener('change', () => {
      const cur = store.get('wr:project', proj) || proj;
      store.set('wr:project', Object.assign({}, cur, { hints: Object.assign({}, cur.hints || {}, { [t.dataset.hint]: t.value }) }));
    }));

    // The "+" between paragraphs: type a paragraph, or write one from a point, and insert it there.
    const insertAt = (sid, j, text) => {
      const all = store.get('wr:drafts', {}) || {};
      const paras = paraList((all[sid] || {}).text || '');
      paras.splice(j, 0, text.trim());
      all[sid] = Object.assign({}, all[sid] || {}, { text: paras.join('\n\n'), at: new Date().toISOString() });
      store.set('wr:drafts', all);
      renderWriting();
    };
    app.querySelectorAll('button[data-insert-toggle]').forEach(b => b.addEventListener('click', () => {
      const box = app.querySelector(`[data-insert-box="${b.dataset.insertToggle}"]`);
      box.hidden = !box.hidden;
    }));
    app.querySelectorAll('button[data-insert-own]').forEach(b => b.addEventListener('click', () => {
      const [sid, j] = b.dataset.insertOwn.split(':');
      const text = app.querySelector(`[data-insert-text="${b.dataset.insertOwn}"]`).value;
      if (!text.trim()) { setStatus('Type the paragraph first.'); return; }
      insertAt(sid, Number(j), text);
    }));
    app.querySelectorAll('button[data-insert-ai]').forEach(b => b.addEventListener('click', async () => {
      const [sid, j] = b.dataset.insertAi.split(':');
      const point = app.querySelector(`[data-insert-text="${b.dataset.insertAi}"]`).value.trim();
      if (!point) { setStatus('Type the point for the new paragraph first.'); return; }
      if (!settings().key) { setStatus('Add your access key in Settings first.'); return; }
      const cur = store.get('wr:project', proj) || proj;
      const all0 = store.get('wr:drafts', {}) || {};
      const paras = paraList((all0[sid] || {}).text || '');
      const at = Number(j);
      const budget = PL.paragraphBudgets(words(sid), paras.length + 1)[0];
      const title = (sections.find(x => x.id === sid) || { title: sid }).title;
      const project = { title: cur.title, topic: cur.topic, question: cur.question, aims: cur.aims, notes: cur.notes, results: cur.results };
      setStatus(`Writing a new paragraph for “${title}”… this can take up to a minute.`);
      try {
        const d = await apiPostForm(WRITE_PATH, { action: 'paragraph', type, section: sid, point, words: budget, position: at + 1, total: paras.length + 1, priorParagraphs: paras.slice(0, at).join('\n\n'), hint: (cur.hints || {})[sid] || '', style: cur.style, project: JSON.stringify(project), prior: '[]' });
        if (!d.ok) throw new Error(d.reason || 'The paragraph could not be written.');
        const all = store.get('wr:drafts', {}) || {};
        const old = all[sid] || {};
        const refs = (old.references || []).concat((d.references || []).filter(r => !(old.references || []).some(o => o.text === r.text)));
        all[sid] = Object.assign({}, old, { references: refs, labels: Object.assign({}, old.labels || {}, d.labels || {}) });
        store.set('wr:drafts', all);
        insertAt(sid, at, d.text || '');
        setStatus(`New paragraph added to “${title}”.`);
      } catch (e) {
        setStatus(/\(404\)/.test(e.message) ? 'Not connected yet: the section writer is not set up on the server.' : `Could not write the paragraph: ${e.message}`);
      }
    }));

    // Paragraph edits by hand: the draft is rebuilt from its paragraphs.
    app.querySelectorAll('textarea[data-para]').forEach(t => t.addEventListener('change', () => {
      const sid = t.dataset.para, idx = Number(t.dataset.idx);
      const all = store.get('wr:drafts', {}) || {};
      const paras = paraList((all[sid] || {}).text || '');
      paras[idx] = t.value.trim();
      all[sid] = Object.assign({}, all[sid] || {}, { text: paras.filter(Boolean).join('\n\n'), at: new Date().toISOString() });
      store.set('wr:drafts', all);
      renderWriting();
    }));

    app.querySelectorAll('button[data-discuss-toggle]').forEach(b => b.addEventListener('click', () => {
      const box = app.querySelector(`[data-discuss-box="${b.dataset.discussToggle}"]`);
      box.hidden = !box.hidden;
    }));

    // Revision: rewrites one paragraph (or the whole section) with the chosen mode and modification type.
    const runRevise = async (sid, idx, mode, instruction, scope) => {
      if (!settings().key) { setStatus('Add your access key in Settings first.'); return; }
      const block = scope || app;
      const mtype = block.querySelector('[data-mtype]') ? block.querySelector('[data-mtype]').value : '';
      if (!mtype) { setStatus('Choose a modification type first.'); return; }
      const cur = store.get('wr:project', proj) || proj;
      const d0 = store.get('wr:drafts', {}) || {};
      const draft = (d0[sid] || {}).text || '';
      const paras = paraList(draft);
      const whole = idx === 'all';
      const paragraph = whole ? draft : paras[Number(idx)];
      if (!paragraph) { setStatus('That paragraph is empty.'); return; }
      const title = (sections.find(x => x.id === sid) || { title: sid }).title;
      const idxSec = sections.findIndex(x => x.id === sid);
      const prior = sections.slice(0, idxSec).filter(x => d0[x.id] && d0[x.id].text).map(x => ({ title: x.title, text: d0[x.id].text }));
      const project = { title: cur.title, topic: cur.topic, question: cur.question, aims: cur.aims, notes: cur.notes, results: cur.results };
      const body = { action: 'revise', type, section: sid, mode, modification: mtype, paragraph, previous: whole || Number(idx) === 0 ? '' : paras[Number(idx) - 1], instruction: instruction || '', style: cur.style, project: JSON.stringify(project), prior: JSON.stringify(prior), hint: (cur.hints || {})[sid] || '', words: PL.countWords(paragraph) };
      setStatus(`Revising a paragraph of “${title}”… this can take up to a minute.`);
      try {
        const d = await apiPostForm(WRITE_PATH, body);
        if (!d.ok) throw new Error(d.reason || 'The paragraph could not be revised.');
        const all = store.get('wr:drafts', {}) || {};
        const old = all[sid] || {};
        const text = whole ? d.text : paras.map((x, j) => (j === Number(idx) ? d.text : x)).join('\n\n');
        const refs = (old.references || []).concat((d.references || []).filter(r => !(old.references || []).some(o => o.text === r.text)));
        all[sid] = Object.assign({}, old, { text, labels: Object.assign({}, old.labels || {}, d.labels || {}), references: refs, at: new Date().toISOString() });
        store.set('wr:drafts', all);
        setStatus(`Revised a paragraph of “${title}”${d.warning ? '. Check: ' + d.warning : '.'}`);
        renderWriting();
      } catch (e) {
        setStatus(/\(404\)/.test(e.message) ? 'Not connected yet: the revision step is not set up on the server.' : `Could not revise: ${e.message}`);
      }
    };
    app.querySelectorAll('button[data-revise]').forEach(b => b.addEventListener('click', () => {
      const block = b.closest('.para') || b.closest('[data-sec]') || app;
      const mode = b.dataset.revise;
      const sid = b.dataset.secId, idx = b.dataset.idx;
      if (mode === 'discuss') {
        const instr = app.querySelector(`[data-instr="${sid}:${idx}"]`);
        if (!instr || !instr.value.trim()) { setStatus('Write what should change first.'); return; }
        return runRevise(sid, idx, 'discuss', instr.value.trim(), block);
      }
      runRevise(sid, idx, mode, '', block);
    }));
  }


  // ---------- Transform: rewrite an article into another format, with chosen new literature ----------
  const TR_KEY = 'tr:draft';
  const TR_SELECT = 'id,doi,title,publication_year,authorships,primary_location,type,cited_by_count,abstract_inverted_index,is_retracted';
  const workLine = w => { const au = (w.authorships || [])[0]; const who = au && au.author ? au.author.display_name : 'Unknown author'; return `${w.title || 'Untitled'} (${who}, ${w.publication_year || 'n.d.'})`; };

  // Literature sources for Transform. OpenAlex filters by work type; government and research bodies are kept only if they are on the trusted list.
  const TR_SRC_LABELS = { articles: 'Articles', reports: 'Reports', gov: 'Official / govt sites', other: 'Repositories' };
  const TR_STYLES = [['apa7', 'APA 7'], ['harvard', 'Harvard'], ['vancouver', 'Vancouver'], ['chicago', 'Chicago (author-date)'], ['ieee', 'IEEE'], ['mla', 'MLA 9']];
  const TR_NUMBERED = ['vancouver', 'ieee'];
  // Bibliography order: alphabetical for author-date styles, order of first citation for numbered styles.
  const sortRefs = (list, style) => TR_NUMBERED.includes(style) ? list.slice() : list.slice().sort((a, b) => String(a).localeCompare(String(b), undefined, { sensitivity: 'base' }));
  const trRefStyle = job => (job && job.style) || (store.get('wr:project', {}) || {}).style || 'apa7';
  // In-text citation for a {{cite:KEY}} marker, in the chosen style. Unknown keys are matched by author and year.
  const trCiteText = (key, refMap, style, nums) => {
    const values = Object.values(refMap);
    const byAuthorYear = k => {
      const y = (String(k).match(/\b(19|20)\d{2}\b/) || [])[0];
      const plain = x => String(x).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z]/g, '');
      const name = plain(String(k).split(',')[0]);
      if (!y || name.length < 3) return null;
      return values.find(t => String(t).includes(y) && plain(t).includes(name)) || null;
    };
    const text = refMap[key] || byAuthorYear(key);
    if (!text) return '';
    if (TR_NUMBERED.includes(style)) { if (!nums.has(key)) nums.set(key, nums.size + 1); return '[' + nums.get(key) + ']'; }
    const m = String(text).match(/^(.*?)\s*\((\d{4}|n\.d\.)[a-z]?\)/);
    const year = m ? m[2] : ((String(text).match(/\d{4}/) || [''])[0]);
    const surname = m && m[1].trim() ? m[1].split(',')[0].trim() : String(text).replace(/^\(?\d{4}\)?\.?\s*/, '').split(/[.:]/)[0].trim().split(/\s+/).slice(0, 4).join(' ');
    return '(' + surname + (year ? ', ' + year : '') + ')';
  };
  // Keeps a section to its own chapter: cuts at the first heading that starts another chapter or subsection.
  const trTrimForeign = (text, secId) => {
    const own = (String(secId || '').match(/chapter_(\d+)/) || [])[1] || null;
    const lines = String(text || '').split('\n');
    const cut = lines.findIndex(l => {
      if (!/^#{1,3}\s/.test(l.trim())) return false;
      const t = l.trim().replace(/^#+\s*/, '');
      const num = (t.match(/^chapter\s+(\d+)/i) || t.match(/^(\d+)\.\d/) || [])[1];
      return !!num && num !== own;
    });
    return (cut < 0 ? lines : lines.slice(0, cut)).join('\n').trim();
  };
  // Keywords: each one is searched separately. Scope 'global' is the whole article; otherwise it is a section id.
  const kwBox = (scope, list) => `<div style="margin:8px 0"><div style="display:flex;flex-wrap:wrap;gap:4px">${list.map((k, i) => `<span style="border:1px solid #d8d2c4;border-radius:12px;padding:2px 8px;font-size:13px">${esc(k)} <button type="button" data-kw-remove="${esc(scope)}|${i}" style="border:0;background:none;cursor:pointer" aria-label="Remove keyword">×</button></span>`).join('')}</div><div style="display:flex;gap:6px;margin-top:4px"><input type="text" data-kw-input="${esc(scope)}" placeholder="Keyword, e.g. visa policy (commas for several)" style="flex:1"><button class="btn btn-sm" type="button" data-kw-include="${esc(scope)}">Add keyword</button>${list.length ? `<button class="btn btn-sm btn-ghost" type="button" data-kw-clear="${esc(scope)}">Clear all keywords</button>` : ''}</div></div>`;
  const TR_APPROACHES = { informative: 'Informative', analytical: 'Analytical', argumentative: 'Argumentative', descriptive: 'Descriptive', detailed: 'Detailed' };
  const TR_SRC_FILTERS = { articles: 'type:journal-article', reports: 'type:report', gov: 'type:report', other: 'type:book|dissertation|preprint' };
  const TR_TRUSTED = ['un tourism', 'unwto', 'world tourism organization', 'oecd', 'world health organization', 'who', 'world bank', 'international monetary fund', 'united nations', 'ministry of tourism', 'ministry of health and family welfare', 'niti aayog', 'invest india', 'ministry of external affairs', 'department of commerce', 'world travel & tourism council', 'wttc', 'iata', 'ficci', 'confederation of indian industry', 'cii'];
  // Drops titles that are only a section name or too short to be a real work (e.g. "Introduction", "Predgovor").
  function usableTitle(title) {
    const t = String(title || '').trim();
    return t.split(/\s+/).length >= 4 && !/^(introduction|preface|foreword|predgovor|contents|index|editorial|prologue|epilogue)$/i.test(t.replace(/[.:]+$/, ''));
  }
  // Rebuilds an OpenAlex abstract (stored as word positions) into plain text. Other sources have no abstract here.
  function abstractOf(w) {
    const inv = w && w.abstract_inverted_index;
    if (!inv || typeof inv !== 'object') return '';
    const words = [];
    Object.keys(inv).forEach(word => (inv[word] || []).forEach(p => { words[p] = word; }));
    return words.filter(Boolean).join(' ');
  }
  // Identity of a work in the literature lists, used for include, exclude and "already used" checks.
  function workKey(w) { return w.id || String(w.title || '').toLowerCase(); }
  // Citation keys used in a text ({{cite:KEY}} markers), lower-cased to compare with the sources sent.
  // A source can be cited only if its first author has a real name (not missing, not a title, not "Unknown").
  function usableAuthor(w) {
    const a = ((w.authorships || [])[0] || {}).author || {};
    const name = String(a.display_name || '').trim();
    if (!name || /unknown/i.test(name) || name.startsWith('[') || name.length < 3) return false;
    return /[A-Za-zÀ-ž]{2,}/.test(name) && !/^[^A-Za-zÀ-ž]*$/.test(name);
  }
  // The most citation markers in one sentence: several at the end of one sentence means the writer bunched them.
  function maxCitesInSentence(text) {
    return Math.max(0, ...String(text || '').split(/(?<=[.!?])\s+/).map(x => (x.match(/\{\{cite:/g) || []).length));
  }
  function citeKeysIn(text) { return new Set((String(text || '').match(/\{\{cite:([^}]+)\}\}/g) || []).map(m => nkey(m.slice(7, -2)))); }
  // How many of the sources sent to the writer are cited in the text (matched by DOI).
  function citedCoverage(text, works) {
    const cited = citeKeysIn(text);
    const list = (works || []).filter(w => workCiteKeys(w).length);
    return { covered: list.filter(w => workCiteKeys(w).some(k => cited.has(k))).length, total: list.length };
  }
  // The key a source is cited by in the text: its DOI, or its id.
  // One key form for comparing citation keys: lower case, without the DOI web prefix.
  function nkey(k) { return String(k || '').trim().toLowerCase().replace(/^https?:\/\/(dx\.)?doi\.org\//, '').replace(/^doi:/, ''); }
  // The keys a source can be cited by: its DOI, its id, or its title key (the form used when there is no DOI).
  // The key the server uses for a source's reference: its DOI, or 'ty:' plus the title when there is no DOI.
  function sourceKeyFor(w) { return w && w.doi ? nkey(w.doi) : nkey('ty:' + String(w && w.title || '').slice(0, 60)); }
  function workCiteKeys(w) { return [w.doi, w.id, 'ty:' + String(w.title || '').slice(0, 60)].map(nkey).filter(k => k && k !== 'ty:'); }
  // A reference whose first author is a single letter, empty or "Unknown" cannot be cited properly.
  function badRefName(text) { const s = String(text || '').trim().split(',')[0].replace(/[^A-Za-zÀ-ž]/g, ''); return s.length < 3 || /unknown/i.test(s); }
  // Removes the text written from the given sources (keys compared with nkey). A paragraph that cites only those sources is dropped;
  // in other paragraphs only their citation markers are removed. References for those sources are removed too.
  function pruneBySources(text, references, removed) {
    const marker = /\{\{cite:([^}]+)\}\}/g;
    const kept = [];
    String(text || '').split(/\n{2,}/).forEach(p => {
      const keys = [...p.matchAll(marker)].map(m => nkey(m[1]));
      if (keys.length && keys.every(k => removed.has(k))) return;
      kept.push(keys.some(k => removed.has(k)) ? p.replace(marker, (m, k) => (removed.has(nkey(k)) ? '' : m)).replace(/ {2,}/g, ' ').replace(/ ([.,;:])/g, '$1') : p);
    });
    return { text: kept.join('\n\n'), references: (references || []).filter(r => !removed.has(nkey(r.key))) };
  }
  function isTrustedWork(w) {
    const names = [(w.primary_location && w.primary_location.source && w.primary_location.source.display_name) || ''];
    (w.authorships || []).forEach(a => (a.institutions || []).forEach(i => names.push(i.display_name || '')));
    const hay = names.join(' | ').toLowerCase();
    return TR_TRUSTED.some(t => hay.includes(t));
  }
  // Crossref (journal articles) and Europe PMC (biomedical and health repositories), reshaped like OpenAlex works so the writer can read them.
  async function crossrefSearch(query, year) {
    const filter = ['type:journal-article', year ? `from-pub-date:${year}-01-01` : ''].filter(Boolean).join(',');
    const d = await (await getWithRetry('https://api.crossref.org/works?' + new URLSearchParams({ query, rows: '8', filter }).toString())).json();
    return ((d.message && d.message.items) || []).map(it => ({
      id: 'doi:' + (it.DOI || it.URL || it.title), doi: it.DOI ? 'https://doi.org/' + it.DOI : null,
      title: (it.title || [''])[0], publication_year: ((((it.issued || {})['date-parts'] || [[]])[0]) || [])[0] || null,
      authorships: (it.author || []).map(a => ({ author: { display_name: [a.given, a.family].filter(Boolean).join(' ') }, institutions: [] })),
      primary_location: { source: { display_name: (it['container-title'] || [''])[0] } },
      type: 'journal-article', cited_by_count: it['is-referenced-by-count'] || 0, abstract_inverted_index: null, is_retracted: false
    })).filter(w => usableTitle(w.title));
  }
  async function europePmcSearch(query, year) {
    const q = year ? `${query} AND PUB_YEAR:[${year} TO 2100]` : query;
    const d = await (await getWithRetry('https://www.ebi.ac.uk/europepmc/webservices/rest/search?' + new URLSearchParams({ query: q, format: 'json', pageSize: '8', resultType: 'core' }).toString())).json();
    return ((d.resultList && d.resultList.result) || []).map(r => ({
      id: 'epmc:' + (r.doi || r.pmid || r.id || r.title), doi: r.doi ? 'https://doi.org/' + r.doi : null,
      title: r.title || '', publication_year: Number(r.pubYear) || null,
      authorships: String(r.authorString || '').split(',').map(s => s.trim()).filter(Boolean).map(n => ({ author: { display_name: n }, institutions: [] })),
      primary_location: { source: { display_name: r.journalTitle || 'Europe PMC' } },
      type: 'article', cited_by_count: r.citedByCount || 0, abstract_inverted_index: null, is_retracted: false
    })).filter(w => usableTitle(w.title));
  }
  // Busy (429) or unavailable (503) responses are retried with a longer wait each time. Other errors are reported with their status.
  const pause = ms => new Promise(r => setTimeout(r, ms));
  async function getWithRetry(url) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await fetch(url);
      if (res.ok) return res;
      if (res.status !== 429 && res.status !== 503) {
        // The service's own reason is included, so the cause can be seen.
        const why = (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 200);
        throw new Error('HTTP ' + res.status + (why ? ': ' + why : ''));
      }
      await pause(4000 * (attempt + 1));
    }
    throw new Error('busy');
  }
  // After OpenAlex is found busy, skip it for a while so the other keywords do not each wait for it again.
  let oaBusyUntil = 0;
  async function findLiterature(query, srcTypes, year) {
    const seen = new Set(), out = [];
    let oaBusy = false, fbFailed = false, lastErr = '';
    const fallback = async fn => { try { return await fn(); } catch (e) { fbFailed = true; lastErr = e.message || String(e); return []; } };
    for (const t of srcTypes) {
      const filter = [TR_SRC_FILTERS[t], year ? `from_publication_date:${year}-01-01` : ''].filter(Boolean).join(',');
      const params = new URLSearchParams({ search: query, 'per-page': '15', select: 'id,doi,title,publication_year,authorships,primary_location,type,cited_by_count,abstract_inverted_index,is_retracted', filter });
      if (settings().oaKey) params.set('api_key', settings().oaKey);
      let res = [];
      let oaFailed = false;
      if (Date.now() < oaBusyUntil) oaFailed = true;
      else try {
        await pause(1200); // space the requests so the service does not throttle the search
        const d = await (await getWithRetry('https://api.openalex.org/works?' + params.toString())).json();
        res = (d.results || []).filter(w => !w.is_retracted && usableTitle(w.title));
        if (t === 'gov') res = res.filter(isTrustedWork);
      } catch (err) {
        oaFailed = true; lastErr = 'OpenAlex ' + (err.message || err);
        // Only busy responses pause OpenAlex for 2 minutes; other errors are shown as they are.
        if (/busy|HTTP 429|HTTP 503/.test(err.message || '')) oaBusyUntil = Date.now() + 120000;
      }
      if (oaFailed) oaBusy = true;
      if (t === 'articles' || (oaFailed && t === 'reports')) res = res.concat(await fallback(() => crossrefSearch(query, year)));
      if (t === 'other') res = res.concat(await fallback(() => europePmcSearch(query, year)));
      res.slice(0, 12).forEach(w => { if (!seen.has(w.id)) { seen.add(w.id); out.push(w); } });
    }
    if (!out.length && oaBusy) throw new Error((fbFailed
      ? 'The literature services are busy right now. Wait a minute, then search again.'
      : 'OpenAlex is busy, and the free sources found nothing for these words. Try different keywords, or search again in a minute.') + (lastErr ? ' Last error: ' + lastErr + '.' : ''));
    return out;
  }
  const mergeRefs = (a = [], b = []) => { const out = [...a]; b.forEach(r => { if (!out.some(q => q.text === r.text)) out.push(r); }); return out; };

  // Reads an uploaded article (.txt, .docx, .pdf) into plain text. Libraries load on first use.
  const TR_LIBS = {
    mammoth: 'https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.6.0/mammoth.browser.min.js',
    pdfjs: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js',
    pdfworker: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js'
  };
  function loadScriptOnce(url) {
    return new Promise((resolve, reject) => {
      if (document.querySelector('script[src="' + url + '"]')) return resolve();
      const s = document.createElement('script');
      s.src = url; s.onload = resolve;
      s.onerror = () => reject(new Error('Could not load a reader library. Check your connection and try again.'));
      document.head.appendChild(s);
    });
  }
  async function extractArticleText(file) {
    const name = file.name.toLowerCase();
    if (name.endsWith('.txt')) return file.text();
    if (name.endsWith('.docx')) {
      await loadScriptOnce(TR_LIBS.mammoth);
      const r = await window.mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
      return r.value.trim();
    }
    if (name.endsWith('.pdf')) {
      await loadScriptOnce(TR_LIBS.pdfjs);
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = TR_LIBS.pdfworker;
      const doc = await window.pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
      let text = '';
      for (let p = 1; p <= doc.numPages; p++) {
        const page = await doc.getPage(p);
        const content = await page.getTextContent();
        text += content.items.map(i => i.str).join(' ') + '\n\n';
      }
      return text.trim();
    }
    if (name.endsWith('.doc')) throw new Error('Old .doc files cannot be read here. Open the file in Word, use Save As and choose .docx, then upload that.');
    throw new Error('Unsupported file. Upload a .docx, .pdf or .txt file.');
  }

  // ---------- Word output: markdown from the writer turned into styled HTML, styled per target format ----------
  const FORMAT_STYLE = {
    // Books: chapters start on a new page, 1.5 line spacing.
    book: {
      body: 'font-family:"Times New Roman",serif;font-size:12pt;line-height:1.5',
      h1: 'text-align:center;font-size:18pt;font-weight:bold;margin:0 0 18pt;page-break-before:always',
      h2: 'font-size:14pt;font-weight:bold;margin:18pt 0 6pt',
      h3: 'font-size:12pt;font-weight:bold;font-style:italic;margin:12pt 0 4pt',
      p: 'text-align:justify;margin:0 0 10pt;text-indent:0.5in'
    },
    // Journal articles, reviews, case studies and theses: APA-style layout, double spaced.
    article: {
      body: 'font-family:"Times New Roman",serif;font-size:12pt;line-height:2',
      h1: 'text-align:center;font-size:14pt;font-weight:bold;margin:0 0 12pt',
      h2: 'font-size:12pt;font-weight:bold;margin:12pt 0 0;text-align:left',
      h3: 'font-size:12pt;font-weight:bold;font-style:italic;margin:0;text-align:left',
      p: 'text-align:left;margin:0;text-indent:0.5in'
    }
  };
  function mdInline(s) {
    return esc(s).replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/\*([^*\n]+)\*/g, '<i>$1</i>');
  }
  function mdToHtml(text, style) {
    const out = [];
    let inList = false;
    const L = String(text || '').split('\n');
    for (let k = 0; k < L.length; k++) {
      const line = L[k].trim();
      if (!line) { if (inList) { out.push('</ul>'); inList = false; } continue; }
      // Markdown table: a header row with "|", a separator row, then data rows.
      if (line.includes('|') && k + 1 < L.length && /^\|?\s*:?-{2,}[\s|:-]*$/.test(L[k + 1].trim())) {
        if (inList) { out.push('</ul>'); inList = false; }
        const rows = [];
        let j = k;
        while (j < L.length && L[j].trim().includes('|')) { rows.push(L[j].trim()); j++; }
        const cells = r => r.replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
        const head = cells(rows[0]);
        const body = rows.slice(2).map(cells);
        const cellStyle = 'border:1px solid #000;padding:3pt 5pt;font-size:10pt;line-height:1.15;text-align:left;vertical-align:top';
        out.push(`<table style="border-collapse:collapse;width:100%;margin:6pt 0 12pt">` +
          `<thead><tr>${head.map(c => `<th style="${cellStyle};font-weight:bold">${mdInline(c)}</th>`).join('')}</tr></thead>` +
          `<tbody>${body.map(r => `<tr>${r.map(c => `<td style="${cellStyle}">${mdInline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
        k = j - 1;
        continue;
      }
      // Table caption, e.g. "Table 9: Major source countries" (kept above the table).
      if (/^(\*\*)?table\s+\d+/i.test(line)) {
        if (inList) { out.push('</ul>'); inList = false; }
        out.push(`<p style="font-weight:bold;text-indent:0;margin:12pt 0 4pt;text-align:left">${mdInline(line)}</p>`);
        continue;
      }
      const h = line.match(/^(#{1,3})\s+(.*)$/);
      if (h) {
        if (inList) { out.push('</ul>'); inList = false; }
        const lvl = h[1].length;
        out.push(`<h${lvl} style="${style['h' + lvl]}">${mdInline(h[2].replace(/^\*+|\*+$/g, ''))}</h${lvl}>`);
        continue;
      }
      const li = line.match(/^[-*]\s+(.*)$/);
      if (li) { if (!inList) { out.push('<ul>'); inList = true; } out.push(`<li>${mdInline(li[1])}</li>`); continue; }
      if (inList) { out.push('</ul>'); inList = false; }
      out.push(`<p style="${style.p}">${mdInline(line)}</p>`);
    }
    if (inList) out.push('</ul>');
    return out.join('\n');
  }
  function buildWordHtml(cur, secs) {
    const type = (window.Q1Write && window.Q1Write.REPORT_TYPES[cur.type || 'empirical:q1']) || { label: 'Document', family: 'empirical' };
    const style = type.family === 'book' ? FORMAT_STYLE.book : FORMAT_STYLE.article;
    const title = String(cur.title || '').trim() || type.label;
    const refs = [];
    // In-text citations: each {{cite:KEY}} becomes (Author, Year), or [n] in numbered styles, from the saved references.
    const refStyle = trRefStyle(cur);
    const refByKey = {};
    secs.forEach(s => ((cur.sections || {})[s.id] || {}).references && (cur.sections[s.id].references).forEach(r => { if (r && r.key && r.text && !refByKey[nkey(r.key)]) refByKey[nkey(r.key)] = r.text; }));
    const citeNums = new Map();
    const citeOf = key => trCiteText(nkey(key), refByKey, refStyle, citeNums);
    // The reference list holds only the sources the text cites, so it matches the in-text citations.
    const citedAll = new Set();
    secs.forEach(s => citeKeysIn(((cur.sections || {})[s.id] || {}).text).forEach(k => citedAll.add(k)));
    const body = secs.filter(s => (cur.sections || {})[s.id] && (cur.sections || {})[s.id].text).map(s => {
      const sec = cur.sections[s.id];
      (sec.references || []).forEach(r => { if (!refs.includes(r.text) && (!r.key || citedAll.has(nkey(r.key)))) refs.push(r.text); });
      const firstLine = String(sec.text).trim().split('\n')[0] || '';
      const hasHeading = /^#{1,3}\s/.test(firstLine);
      const lead = hasHeading ? '' : (type.family === 'book'
        ? `<h1 style="${style.h1}">${esc(s.title)}</h1>`
        : `<h2 style="${style.h2}">${esc(s.title)}</h2>`);
      return lead + mdToHtml(String(sec.text).replace(/\{\{cite:([^}]+)\}\}/g, (_, k) => citeOf(k.trim())), style);
    }).join('\n');
    const titlePage = `<p style="text-align:center;font-size:20pt;font-weight:bold;margin-top:120pt">${esc(title)}</p><p style="text-align:center;margin-top:12pt">${esc(type.label)}</p>`;
    const refsHtml = `<h1 style="${style.h2}">References</h1>` + (refs.length
      ? sortRefs(refs, trRefStyle(cur)).map(r => `<p style="margin:0 0 6pt 0.5in;text-indent:-0.5in">${mdInline(r)}</p>`).join('')
      : '<p style="margin:0">No references were recorded for this draft. Tick sources in Step 2 and run Transform again.</p>');
    return `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word"><head><meta charset="utf-8"><title>${esc(title)}</title><style>body{${style.body}}</style></head><body>${titlePage}${body}${refsHtml}</body></html>`;
  }

  function renderTransform() {
    const W2 = window.Q1Write, PL2 = window.Q1Plan;
    // Clean-up: works already included or used are removed from the search list, so it shows only new works.
    {
      const saved = store.get(TR_KEY, {}) || {};
      const gone = new Set([...(saved.included || []).map(workKey), ...(saved.usedKeys || [])]);
      const kept = (saved.works || []).filter(w => !gone.has(workKey(w)));
      if (kept.length !== (saved.works || []).length) store.set(TR_KEY, Object.assign({}, saved, { works: kept, picked: [] }));
    }
    const job = store.get(TR_KEY, {}) || {};
    const type = W2.REPORT_TYPES[job.type] ? job.type : 'empirical:q1';
    const picked = Array.isArray(job.picked) ? job.picked : (job.works || []).map((_, i) => i);
    const typeOptions = Object.keys(W2.REPORT_TYPES).map(k => `<option value="${k}"${k === type ? ' selected' : ''}>${esc(W2.REPORT_TYPES[k].label)}</option>`).join('');
    const works = job.works || [];
    const worksHtml = works.length
      ? works.map((w, i) => `<label style="display:block;font-size:14px;margin:4px 0"><input type="checkbox" data-pick="${i}"${picked.includes(i) ? ' checked' : ''}> ${esc(workLine(w))}</label>`).join('')
      : '<p class="muted" style="font-size:14px">No literature searched yet. Enter a topic above and search.</p>';
    const outline = PL2.buildOutline(type, job.words || 6000, job.budgets || {});
    const secs = W2.REPORT_TYPES[type].sections.filter(s => s.id !== 'references');
    const done = job.sections || {};
    const srcTypes = Array.isArray(job.srcTypes) ? job.srcTypes : ['articles', 'reports', 'gov'];
    const foundAll = job.found || {};
    const foundPicks = job.foundPicks || {};
    const verdictTag = (secId, w) => {
      const v = ((job.verdicts || {})[secId] || {})[workKey(w)];
      if (!v) return '';
      return v.relevant ? ' <span class="tag ok">Relevant</span>' : ` <span class="tag warn">Not relevant</span> <span class="muted" style="font-size:12px">${esc(v.reason)}</span>`;
    };
    const foundHtml = secId => {
      const list = foundAll[secId] || [];
      if (!list.length) return '';
      const picks = foundPicks[secId] || [];
      const used = new Set(job.usedKeys || []);
      // Relevant sources are listed first, then the rest; each keeps its own index, so the saved picks still match.
      const isRel = i => ((((job.verdicts || {})[secId]) || {})[workKey(list[i])] || {}).relevant === true;
      const order = list.map((_, i) => i).sort((a, b) => (isRel(b) ? 1 : 0) - (isRel(a) ? 1 : 0) || a - b);
      return `<div style="margin:8px 0;border-left:3px solid #d8d2c4;padding-left:10px">${order.map(i => {
        const w = list[i];
        // A source already used by a finished update is shown as used, not as waiting to be included.
        // Works already used in an update are not listed here; they appear in the Updated list.
        if (used.has(w.id || String(w.title || '').toLowerCase())) return '';
        return `<label style="display:block;font-size:14px;margin:3px 0"><input type="checkbox" data-tr-fpick="${esc(secId)}:${i}"${picks.includes(i) ? ' checked' : ''}> ${esc(workLine(w))}${verdictTag(secId, w)}</label>`;
      }).join('')}</div>`;
    };
    // Shows, for one section, which works Update will use: the included ones, else the ticked ones.
    const secInclLine = secId => {
      const inc = ((job.secIncluded || {})[secId]) || [];
      const pk = foundPicks[secId] || [];
      if (inc.length) return `<div style="font-size:13px;color:#2d6a3e;margin:6px 0"><b>Included for this section: ${inc.length} work${inc.length > 1 ? 's' : ''}.</b> Update will use these.<details style="margin-top:4px"><summary>Show included works</summary>${inc.map(w => `<div>${esc(workLine(w))}</div>`).join('')}</details></div>`;
      if (pk.length) return `<div style="font-size:13px;margin:6px 0">${pk.length} ticked but not included yet. Click “Include selected for this section” to confirm. Until then, Update uses the ticked works.</div>`;
      return '<div class="muted" style="font-size:13px;margin:6px 0">No works included for this section. Tick works, then click Include.</div>';
    };
    const globalInclLine = (job.included || []).length
      ? `<div style="font-size:13px;color:#2d6a3e;margin:6px 0"><b>Included for Transform and updates: ${(job.included || []).length} works.</b> Sections without their own included works use these.<details style="margin-top:4px"><summary>Show all ${(job.included || []).length} included works</summary><div style="max-height:320px;overflow:auto;margin-top:4px">${(job.included || []).map((w, i) => `<div style="color:#333">${i + 1}. ${esc(workLine(w))}</div>`).join('')}</div></details></div>`
      : '<div class="muted" style="font-size:13px;margin:6px 0">None included yet. Tick works, then click Include selected literature.</div>';
    // Top panel, same layout as each section: Included (to be updated) and Updated lists, shown under Search and above the results.
    const listAllW = ws => ws.length
      ? ws.map((w, i) => `<div style="font-size:14px;margin:3px 0">${i + 1}. ${esc(workLine(w))}</div>`).join('')
      : '<div class="muted" style="font-size:13px">None yet.</div>';
    // Updated only for sources cited in some section's current text; earlier runs whose text is gone are not Updated.
    const citedAnywhere = new Set();
    Object.values(job.sections || {}).forEach(sec => citeKeysIn(String((sec || {}).text || '')).forEach(k => citedAnywhere.add(k)));
    const updatedAllW = (() => { const seen = new Set(); return Object.values(job.secUsedWorks || {}).flat().filter(w => { const k = w.id || String(w.title || '').toLowerCase(); if (seen.has(k)) return false; seen.add(k); return workCiteKeys(w).some(k2 => citedAnywhere.has(k2)); }); })();
    // One combined list: works to be updated, then works already used, each tagged.
    const combinedList = (inc, usedW) => {
      const rows = [...inc.map(w => ({ w, tag: "Included" })), ...usedW.map(w => ({ w, tag: "Updated" }))];
      const body = rows.length
        ? rows.map((r, i) => `<div style="font-size:14px;margin:3px 0">${i + 1}. ${esc(workLine(r.w))} <span style="font-size:12px;border-radius:10px;padding:1px 7px;background:${r.tag === "Updated" ? "#dcefe0" : "#eef0f7"}">${r.tag}</span></div>`).join("")
        : '<div class="muted" style="font-size:13px">None yet.</div>';
      return `<div style="margin-top:10px;font-size:14px"><b>Included/Updated List (${rows.length})</b>${body}</div>`;
    };
    const globalButtons = works.length ? `<button class="btn btn-sm" type="button" id="trSelAll" style="margin-top:8px">Select all</button><button class="btn btn-sm" type="button" id="trSelNone" style="margin-top:8px;margin-left:6px">Clear</button><button class="btn btn-sm" type="button" id="trInclude" style="margin-top:8px;margin-left:6px">Include selected literature (${picked.length} ticked)</button><button class="btn btn-sm" type="button" id="trExclude" style="margin-top:8px;margin-left:6px">Exclude selected literature (${picked.length} ticked)</button>` : '';
    const globalLists = combinedList(job.included || [], updatedAllW);
    // ---- paragraph-level view: each paragraph is its own box with its own controls ----
    const blocksOf = t => String(t || '').split(/\n\s*\n/).map(x => x.trim()).filter(Boolean);
    const isHeadBlock = b => /^#{1,3}\s/.test(b);
    const wordsIn = t => String(t || '').trim().split(/\s+/).filter(Boolean).length;
    // Preview of a paragraph: tables as tables, citations in the chosen style (the box keeps the raw text for editing).
    const pageRefMap = {};
    secs.forEach(s => ((done[s.id] || {}).references || []).forEach(r => { if (r && r.key && r.text && !pageRefMap[r.key]) pageRefMap[r.key] = r.text; }));
    const previewBlock = b => {
      const nums = new Map();
      const withCites = b.replace(/\{\{cite:([^}]+)\}\}/g, (_, k) => trCiteText(k.trim(), pageRefMap, trRefStyle(job), nums));
      return mdToHtml(withCites, { p: 'margin:0 0 6px;font-size:14px', h1: 'font-size:15px;font-weight:600;margin:8px 0', h2: 'font-size:14px;font-weight:600;margin:8px 0', h3: 'font-size:14px;font-weight:600;margin:6px 0' });
    };
    const blocksHtml = (secId, text) => blocksOf(text).map((b, i, arr) => {
      if (isHeadBlock(b)) return `<div style="font-weight:600;margin:12px 0 4px">${esc(b.replace(/^#+\s*/, ''))}</div>`;
      const canSuit = i > 0 && !isHeadBlock(arr[i - 1]);
      const key = esc(secId) + '|' + i;
      return `<div style="border:1px solid #e2dccd;border-radius:8px;padding:8px;margin:6px 0">
          <textarea rows="4" data-tr-p="${key}" style="width:100%">${esc(b)}</textarea>
          ${/\|\s*:?-{2,}/.test(b) || /\{\{cite:/.test(b) ? `<div style="border-top:1px dashed #d8d2c4;margin-top:6px;padding-top:6px"><div class="muted" style="font-size:12px">Preview</div>${previewBlock(b)}</div>` : ''}
          <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:6px">
            ${canSuit ? `<button class="btn btn-sm" type="button" data-tr-suit="${key}">Suit previous paragraph</button>` : ''}
            <button class="btn btn-sm" type="button" data-tr-pmod="${key}">Modify with AI</button>
          </div>
          <input type="text" data-tr-pinstr="${key}" placeholder="Instruction for Modify with AI" style="width:100%;margin-top:6px">
        </div>
        <button class="btn btn-sm" type="button" data-tr-plus="${key}" style="margin:0 0 8px">+ Add paragraph below</button>`;
    }).join('');
    const paraState = secId => {
      const cur = store.get(TR_KEY, {}) || {};
      const text = ((cur.sections || {})[secId] || {}).text || '';
      return { cur, blocks: blocksOf(text) };
    };
    const saveBlocks = (secId, blocks) => {
      const cur = store.get(TR_KEY, {}) || {};
      const sections = Object.assign({}, cur.sections || {});
      sections[secId] = Object.assign({}, sections[secId] || {}, { text: blocks.join('\n\n') });
      saveJob({ sections });
    };
    const paraRevise = async (secId, i, mode, instruction) => {
      const { cur, blocks } = paraState(secId);
      const previous = i > 0 && !isHeadBlock(blocks[i - 1]) ? blocks[i - 1] : '';
      const d = await apiPostForm(WRITE_PATH, { action: 'revise', type: cur.type || 'empirical:q1', section: secId, mode, modification: cur.modType, paragraph: blocks[i], previous, instruction: instruction || '', style: trRefStyle(cur), project: JSON.stringify({ title: cur.title || '' }), prior: '[]', hint: '', words: wordsIn(blocks[i]) });
      if (!d.ok) throw new Error(d.reason || 'The paragraph could not be revised.');
      blocks[i] = d.text || blocks[i];
      saveBlocks(secId, blocks);
    };
    const paraAction = async (key, mode, instruction) => {
      const [secId, i] = key.split('|');
      const cur = store.get(TR_KEY, {}) || {};
      if (!settings().key) { noteFor(secId, 'Add your access key in Settings first.'); return; }
      if (!cur.modType) { noteFor(secId, 'Choose a modification type in Step 3 first.'); return; }
      if (mode === 'discuss' && !instruction) { noteFor(secId, 'Write the instruction for the AI first.'); return; }
      try {
        noteFor(secId, 'Revising the paragraph…');
        await paraRevise(secId, Number(i), mode, instruction);
        renderTransform();
        noteFor(secId, 'Paragraph updated.');
      } catch (e) { noteFor(secId, e.message); }
    };

    // One layout for every section: Search, the results to tick, the actions, then the Included and Updated lists.
    // For one section: which sent sources the text cites, the sentence each supports, and which sent sources are not cited.
    const citationsHtml = secId => {
      const text = String(((job.sections || {})[secId] || {}).text || '');
      const sent = (job.secUsedWorks || {})[secId] || [];
      if (!text.trim() || !sent.length) return '';
      const cited = citeKeysIn(text);
      const keyOf = w => String(w.doi || '').replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').toLowerCase() || String(w.id || '').replace(/^doi:/, '').toLowerCase();
      const sentences = text.split(/(?<=[.!?])\s+/);
      const sentenceFor = k => (sentences.find(x => x.toLowerCase().includes('{{cite:' + k + '}}')) || '').replace(/\{\{cite:[^}]+\}\}/g, '').trim();
      const rows = sent.map(w => ({ w, k: keyOf(w) }));
      const yes = rows.filter(r => r.k && cited.has(r.k));
      const no = rows.filter(r => !(r.k && cited.has(r.k)));
      return `<details style="margin:8px 0;font-size:14px"><summary><b>Citations in this section: ${yes.length} of ${sent.length} sent sources</b></summary>
        <ol style="margin:6px 0 8px 18px">${yes.map(r => `<li><b>${esc(r.w.title)}</b>${r.w.primary_location && r.w.primary_location.source && r.w.primary_location.source.display_name ? ' <span class="muted">' + esc(r.w.primary_location.source.display_name) + '</span>' : ''}<br><span class="muted">Text: “${esc(sentenceFor(r.k).slice(0, 300))}”</span></li>`).join('') || '<li class="muted">None of the sent sources is cited yet.</li>'}</ol>
        <div><b>Sent but not cited (${no.length})</b></div>
        <ul style="margin:4px 0 0 18px">${no.map(r => `<li class="muted">${esc(r.w.title)}</li>`).join('') || '<li class="muted">All sent sources are cited.</li>'}</ul></details>`;
    };
    const litPanel = s => {
      const hasList = ((job.found || {})[s.id] || []).length > 0;
      const inc = (job.secIncluded || {})[s.id] || [];
      // Updated means the source is cited in the section's text now. Sources from earlier runs whose text is gone are not shown as Updated.
      const secText = String(((job.sections || {})[s.id] || {}).text || '');
      const citedInText = citeKeysIn(secText);
      const usedW = ((job.secUsedWorks || {})[s.id] || []).filter(w => workCiteKeys(w).some(k => citedInText.has(k)));
      const listOf = ws => ws.length
        ? ws.map((w, i) => `<div style="font-size:14px;margin:3px 0">${i + 1}. ${esc(workLine(w))}</div>`).join('')
        : '<div class="muted" style="font-size:13px">None yet.</div>';
      const btn = 'class="btn btn-sm" type="button"';
      return `
        <div style="margin-top:8px"><button ${btn} data-tr-find="${esc(s.id)}">Search literature</button> <button ${btn} data-tr-fresh="${esc(s.id)}">Search again, show all results</button> <button ${btn} data-tr-clearlist="${esc(s.id)}">Clear included and updated</button>${(job.secPrev || {})[s.id] ? ` <button ${btn} data-tr-restore="${esc(s.id)}">Restore previous version</button>` : ''}</div>
        <div class="muted" data-sec-note="${esc(s.id)}" role="status" aria-live="polite" style="font-size:14px;font-weight:600;min-height:1em;margin:6px 0;padding:6px 8px;border-radius:6px;background:#f4f1e8">${esc((job.secNotes || {})[s.id] || '')}</div>
        ${citationsHtml(s.id)}
        <button hidden data-tr-apply="${esc(s.id)}">Update</button>
        ${hasList ? `<div style="margin-top:6px;display:flex;flex-wrap:wrap;gap:8px">
          <button ${btn} data-tr-selall="${esc(s.id)}">Select all</button>
          <button ${btn} data-tr-selnone="${esc(s.id)}">Clear all</button>
          <button ${btn} data-tr-incupd="${esc(s.id)}">Include &amp; update</button>
          <button ${btn} data-tr-exclude="${esc(s.id)}">Exclude</button>
        </div>` : ''}
        <div id="trFound-${esc(s.id)}" style="margin-top:10px">${foundHtml(s.id)}</div>
        ${combinedList(inc, usedW)}`;
    };
    const sectionHtml = secs.map(s => {
      const text = (done[s.id] || {}).text || '';
      const secPicks = (job.secSrc || {})[s.id] || srcTypes;
      // Each section is a bordered panel with a header: its number, title, word count and status.
      const secIndex = secs.indexOf(s) + 1;
      const secWords = String(text || '').trim() ? String(text).trim().split(/\s+/).length : 0;
      const lastNote = (job.secNotes || {})[s.id] || '';
      const statusTag = !text ? '<span style="background:#eee;color:#555;border-radius:10px;padding:2px 8px;font-size:12px">Not transformed</span>'
        : /^Not updated/.test(lastNote) ? '<span style="background:#fbe3dc;color:#8a2b12;border-radius:10px;padding:2px 8px;font-size:12px">Last update not applied</span>'
        : /^Updated/.test(lastNote) && citeKeysIn(String(text)).size > 0 ? '<span style="background:#dcefe0;color:#1f5a2c;border-radius:10px;padding:2px 8px;font-size:12px">Updated</span>'
        : '<span style="background:#eef0f7;color:#33405f;border-radius:10px;padding:2px 8px;font-size:12px">Transformed</span>';
      return `<article data-sec-panel="${esc(s.id)}" style="margin-bottom:18px;border:1px solid #cfc8b6;border-left:6px solid #7a6a3f;border-radius:8px;background:#fffdf7;padding:10px 14px">
        <div style="display:flex;flex-wrap:wrap;align-items:center;gap:8px;border-bottom:1px solid #e3ddcc;padding-bottom:8px;margin-bottom:8px">
          <span style="font-size:13px;font-weight:700;color:#7a6a3f">Section ${secIndex} of ${secs.length}</span>
          <span style="font-weight:700;font-size:16px">${esc(s.title)}</span>
          <span class="muted" style="font-size:13px">${secWords ? secWords + ' words now' : ''} · ${outline.sections.find(x => x.id === s.id).words} words planned</span>
          <span style="margin-left:auto">${statusTag}</span>
        </div>
        ${text ? blocksHtml(s.id, text) : '<p class="muted" style="font-size:14px">Not transformed yet.</p>'}
        ${text ? `<fieldset style="border:0;padding:0;margin:6px 0"><legend style="font-size:13px;margin-bottom:4px">Update literature from</legend>${Object.keys(TR_SRC_LABELS).map(k => `<label style="margin-right:12px;font-size:13px"><input type="checkbox" data-sec-src="${esc(s.id)}|${k}"${secPicks.includes(k) ? ' checked' : ''}> ${esc(TR_SRC_LABELS[k])}</label>`).join('')}</fieldset>` : ''}
        ${text ? `<div style="font-size:13px;margin-top:6px">Keywords for this section</div>${kwBox(s.id, ((job.secKeywords || {})[s.id]) || [])}` : ''}
        ${text ? litPanel(s) : ''}
        ${text ? `<label class="field" style="margin-top:8px"><span>Modify with AI <i>instruction</i></span>
          <textarea rows="2" data-tr-instr="${esc(s.id)}" placeholder="e.g. make the argument more critical and add a paragraph on policy"></textarea></label>
        <button class="btn btn-sm" type="button" data-tr-modify="${esc(s.id)}">Modify this section</button>` : ''}</article>`;
    }).join('');
    const hasOutput = secs.some(s => (done[s.id] || {}).text);

    // Step 4: check the transformed output against the requirements the user set.
    const reqWords = s => String((done[s.id] || {}).text || '').trim().split(/\s+/).filter(Boolean).length;
    const reqTarget = Math.max(300, Number(job.words) || 6000);
    const reqTotal = secs.reduce((n, s) => n + reqWords(s), 0);
    const reqPlanned = s => outline.sections.find(x => x.id === s.id).words;
    const reqShort = secs.filter(s => reqWords(s) > 0 && reqWords(s) < reqPlanned(s) * 0.85);
    const reqAllText = secs.map(s => (done[s.id] || {}).text || '').join('\n');
    const reqTables = (reqAllText.match(/^\s*\|\s*:?-{3,}/gm) || []).length;
    const reqCites = (reqAllText.match(/\{\{cite:/g) || []).length;
    const reqRefs = new Set(secs.flatMap(s => ((done[s.id] || {}).references || []).map(r => r.text))).size;
    const reqPicked = Array.isArray(job.picked) ? job.picked.length : (job.works || []).length;
    const reqRow = (ok, label, detail) => `<li style="margin:3px 0"><strong style="color:${ok ? 'inherit' : 'var(--warn, #b45309)'}">${ok ? 'OK' : 'Check'}</strong> · ${esc(label)}: ${esc(detail)}</li>`;
    const reqPanel = !hasOutput ? '' : `<div class="card" style="margin:10px 0;padding:10px 12px">
        <div style="font-weight:600;margin-bottom:4px">Step 4 · Check requirements</div>
        <ul style="margin:0;padding-left:18px;font-size:14px">
          ${reqRow(reqTotal >= reqTarget * 0.85 && reqTotal <= reqTarget * 1.15, 'Total length', `${reqTotal} words against a target of ${reqTarget}`)}
          ${reqRow(reqShort.length === 0, 'Sections', reqShort.length ? `${reqShort.length} below 85% of planned length: ${reqShort.map(s => s.title).join(', ')}` : 'all sections at planned length')}
          ${reqRow(reqCites === 0, 'Unresolved citations', reqCites ? `${reqCites} {{cite:}} markers still in the text` : 'none')}
          ${reqRow(reqRefs > 0, 'References', `${reqRefs} in the reference list`)}
          ${reqRow(reqPicked > 0, 'Literature used', reqPicked ? `${reqPicked} works ticked for the update` : 'no works ticked; tick sources in Step 2 and update')}
          ${reqRow(true, 'Tables', `${reqTables} table${reqTables === 1 ? '' : 's'} in the text`)}
        </ul></div>`;

    // Bibliography: every reference the transformed sections cite, once, in the chosen style.
    const refStyleNow = trRefStyle(job);
    // The References list holds only sources the text cites, so it matches the in-text citations.
    const citedNow = new Set();
    secs.forEach(s => citeKeysIn((done[s.id] || {}).text).forEach(k => citedNow.add(k)));
    const allRefs = [];
    secs.forEach(s => ((done[s.id] || {}).references || []).forEach(r => { if (r && r.text && (!r.key || citedNow.has(String(r.key).toLowerCase())) && !allRefs.includes(r.text)) allRefs.push(r.text); }));
    const refsPanel = !allRefs.length ? '' : `<div class="card" style="margin:10px 0;padding:10px 12px">
        <div style="font-weight:600;margin-bottom:4px">References · ${esc((TR_STYLES.find(x => x[0] === refStyleNow) || [0, refStyleNow])[1])}</div>
        <p class="muted" style="font-size:13px;margin:0 0 8px">References keep the style they were formatted in. To reformat them in a new style, run Transform now, which rewrites every section.</p>
        <ol style="list-style:none;padding:0;margin:0;font-size:14px">${sortRefs(allRefs, refStyleNow).map(r => `<li style="margin:0 0 6px 0.5in;text-indent:-0.5in">${mdInline(String(r).replace(/&amp;/g, '&'))}</li>`).join('')}</ol></div>`;

    app.innerHTML = `
      <section class="card" style="margin-top:8px">
        <div class="card-head"><h2 style="margin:0">Step 1 · Article</h2><small>Turn an article into another format, and update it with new literature</small></div>
        <p class="muted" style="font-size:14px;margin:4px 0 12px">Paste the article text or choose a .txt file. Word and PDF upload is not connected yet, so paste the text from those files for now.</p>
        <label class="field"><span>Article text</span><textarea id="trSource" rows="8" placeholder="Paste the article here">${esc(job.source || '')}</textarea></label>
        <input type="file" id="trFile" accept=".txt,.docx,.pdf,.doc" style="margin:6px 0 12px">
        <div class="grid two">
          <label class="field"><span>Transform into</span><select id="trType">${typeOptions}</select></label>
          <label class="field"><span>Total length (words)</span><input type="number" id="trWords" min="300" max="60000" step="100" value="${esc(job.words || 6000)}"></label>
        </div>
      </section>
      <section class="card" style="margin-top:16px">
        <div class="card-head"><h2 style="margin:0">Step 2 · Literature</h2><small>Search, then tick the works to use. They are used in Step 3 and Step 4.</small></div>
        <div class="grid two">
          <label class="field"><span>Topic to search</span><input type="text" id="trQuery" value="${esc(job.query || '')}" placeholder="e.g. medical visa policy and patient mobility"></label>
          <label class="field"><span>Published from <i>year, optional</i></span><input type="number" id="trYear" min="1950" max="2026" value="${esc(job.yearFrom || '')}"></label>
        </div>
        <div><span style="font-size:14px">Keywords <i>each keyword is searched separately</i></span>${kwBox('global', job.keywords || [])}</div>
        <div hidden>
        <button class="btn btn-sm" type="button" id="trSearch">Search new literature</button>
        <div id="trGlobalNote" class="muted" role="status" aria-live="polite" style="font-size:14px;font-weight:600;min-height:1em;margin:6px 0">${esc(job.globalNote || '')}</div>
        ${globalButtons}
        <div id="trWorks" style="margin-top:12px">${worksHtml}</div>
        ${globalLists}
        </div>
      </section>
      <section class="card" style="margin-top:16px">
        <div class="card-head"><h2 style="margin:0">Step 3 · Transform</h2><small>one section at a time, in the target format's order</small></div>
        <label class="field"><span>Modification type <i>required for paragraph changes</i></span><select id="trModType"><option value="">Choose one</option>${['argumentative', 'discussion', 'analytical', 'theory'].map(k => `<option value="${k}"${(job.modType || '') === k ? ' selected' : ''}>${k}</option>`).join('')}</select></label>
        <label class="field"><span>Writing approach <i>used for every transform and update</i></span><select id="trApproach"><option value="">As in the source</option>${Object.keys(TR_APPROACHES).map(k => `<option value="${k}"${(job.approach || '') === k ? ' selected' : ''}>${TR_APPROACHES[k]}</option>`).join('')}</select></label>
        <label class="field"><span>Reference style <i>used for new citations and the bibliography</i></span><select id="trStyle">${TR_STYLES.map(([k, l]) => `<option value="${k}"${trRefStyle(job) === k ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
        <fieldset style="border:0;padding:0;margin:0 0 12px"><legend style="font-size:14px;margin-bottom:6px">Default literature sources <i>for new sections</i></legend>
          ${Object.keys(TR_SRC_LABELS).map(k => `<label style="margin-right:14px;font-size:14px"><input type="checkbox" data-src="${k}"${srcTypes.includes(k) ? ' checked' : ''}> ${esc(TR_SRC_LABELS[k])}</label>`).join('')}
        </fieldset>
        <button class="btn btn-primary" type="button" id="trGo">Transform now</button>
        <button class="btn btn-sm" type="button" id="trUpdateAll" style="margin-left:8px">Update all sections with literature</button>
        <div id="trStatus" class="muted" style="font-size:14px;margin:8px 0" aria-live="polite"></div>
        ${reqPanel}
        ${refsPanel}
        <div style="margin-top:10px">${sectionHtml}</div>
        ${hasOutput ? '<button class="btn" type="button" id="trDown">Download as Word document</button>' : ''}
      </section>`;

    const setStatus = t => { const el = $('#trStatus'); if (el) el.textContent = t; };
    // Messages for one section appear beside its own buttons as well as in the status line.
    const noteFor = (secId, t) => { const el = app.querySelector(`[data-sec-note="${secId}"]`); if (el) el.textContent = t; setStatus(t); };
    // The browser keeps the Transform job in local storage. When that storage is full, the save fails; the page now says so instead of showing results that were not kept.
    const STORAGE_FULL_MSG = 'Not saved: this browser’s storage is full. Remove old saved reviews from this browser, then try again.';
    const saveJob = patch => {
      const ok = store.set(TR_KEY, Object.assign({}, store.get(TR_KEY, {}) || {}, patch));
      if (!ok) setStatus(STORAGE_FULL_MSG);
      return ok;
    };
    // A source used in an update is recorded as used, removed from the search list and the included list, and never used again.
    const markUsed = (works, secId) => {
      const latest = store.get(TR_KEY, {}) || {};
      const keys = new Set(works.map(workKey));
      const prevW = ((latest.secUsedWorks || {})[secId]) || [];
      const seenU = new Set(prevW.map(workKey));
      const addW = works.filter(w => !seenU.has(workKey(w)));
      const written = new Set([...(((latest.secWritten || {})[secId]) || []), ...works.flatMap(workCiteKeys)]);
      saveJob({
        secWritten: Object.assign({}, latest.secWritten || {}, { [secId]: [...written] }),
        usedKeys: [...new Set([...(latest.usedKeys || []), ...keys])],
        works: (latest.works || []).filter(w => !keys.has(workKey(w))),
        found: Object.assign({}, latest.found || {}, { [secId]: ((latest.found || {})[secId] || []).filter(w => !keys.has(workKey(w))) }),
        included: (latest.included || []).filter(w => !keys.has(workKey(w))),
        secUsedWorks: Object.assign({}, latest.secUsedWorks || {}, { [secId]: [...prevW, ...addW] })
      });
    };

    $('#trSource').addEventListener('change', e => saveJob({ source: e.target.value }));
    $('#trFile').addEventListener('change', async e => {
      const f = e.target.files && e.target.files[0]; if (!f) return;
      try {
        const text = await extractArticleText(f);
        $('#trSource').value = text; saveJob({ source: text });
      } catch (err) { alert(err.message); e.target.value = ''; }
    });
    $('#trType').addEventListener('change', e => { saveJob({ type: e.target.value, sections: {} }); renderTransform(); });
    $('#trWords').addEventListener('change', e => saveJob({ words: Math.max(300, Number(e.target.value) || 6000) }));
    $('#trQuery').addEventListener('change', e => saveJob({ query: e.target.value }));
    $('#trYear').addEventListener('change', e => saveJob({ yearFrom: e.target.value }));

    // Literature: searched in the browser (OpenAlex is open to browsers); the works you tick are sent with the transform.
    $('#trSearch').addEventListener('click', async () => {
      const note = t => { const el = $('#trGlobalNote'); if (el) el.textContent = t; setStatus(t); };
      const cur = store.get(TR_KEY, {}) || {};
      const topic = $('#trQuery').value.trim();
      const queries = (cur.keywords || []).length ? cur.keywords : (topic ? [topic] : []);
      if (!queries.length) { note('Type a topic or add keywords first.'); return; }
      const types = srcChosen();
      if (!types.length) { note('Tick at least one source type first.'); return; }
      const year = $('#trYear').value.trim();
      note('Searching new literature…');
      try {
        let results = [];
        for (const q of queries) results = results.concat(await findLiterature(q, types, year));
        const seen = new Set();
        results = results.filter(w => { const k = w.id || normText(w.title); if (seen.has(k)) return false; seen.add(k); return true; });
        const articleText = normText(cur.source || '');
        results = results.filter(w => { const t = normText(w.title); return !(t.length >= 20 && articleText.includes(t)); });
        const termsG = queries.map(q => normText(q)).filter(t => t.length >= 4);
        const hitsG = termsG.map(t => new RegExp("(^|[^a-z0-9])" + t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "($|[^a-z0-9])"));
        results = results.filter(w => usableTitle(w.title) && (!hitsG.length || hitsG.some(re => re.test(normText(w.title || "")) || re.test(normText(abstractOf(w))))));
        // Excluded works are not brought back by a new search.
        // Only new works appear: not excluded, not already included, and not already used in an update.
        // Every work shown in an earlier search is remembered, so a repeat search shows only works not seen before.
        const exSet = new Set(cur.excluded || []), usedSet = new Set(cur.usedKeys || []), seenSet = new Set(cur.seenKeys || []);
        const hidEx = results.filter(w => exSet.has(workKey(w))).length;
        const hidUsed = results.filter(w => !exSet.has(workKey(w)) && usedSet.has(workKey(w))).length;
        const hidSeen = results.filter(w => !exSet.has(workKey(w)) && !usedSet.has(workKey(w)) && seenSet.has(workKey(w))).length;
        const seenNow = new Set([...(cur.seenKeys || []), ...(cur.excluded || []), ...(cur.usedKeys || []), ...(cur.included || []).map(workKey)]);
        const fresh = results.filter(w => !seenNow.has(workKey(w)));
        saveJob({ query: topic, yearFrom: year, works: fresh, picked: [], seenKeys: [...new Set([...(cur.seenKeys || []), ...fresh.map(workKey)])] });
        renderTransform();
        if (fresh.length) note(`${fresh.length} new works found. Works shown before are not shown again. Tick the ones to include, then click Include selected literature.`);
        else if (!results.length) note('The search ran, but the sources returned no works that match these keywords. Try other keywords.');
        else note(`The search found ${results.length} matching works, but none are new: ${hidEx} are excluded, ${hidUsed} were already used in an update, ${hidSeen} were shown before. Clear excluded works to see them again, or try other keywords.`);
      } catch (e) { note('The literature search could not be reached. Try again.'); }
    });
    const trSelAll = $('#trSelAll');
    if (trSelAll) trSelAll.addEventListener('click', () => { const c = store.get(TR_KEY, {}) || {}; saveJob({ picked: (c.works || []).map((_, i) => i) }); renderTransform(); });
    const trSelNone = $('#trSelNone');
    if (trSelNone) trSelNone.addEventListener('click', () => { saveJob({ picked: [] }); renderTransform(); });
    const trExcl = $('#trExclude');
    if (trExcl) trExcl.addEventListener('click', () => {
      const cur = store.get(TR_KEY, {}) || {};
      const pk = Array.isArray(cur.picked) ? cur.picked : [];
      if (!pk.length) { setStatus('Tick at least one work first, then click Exclude.'); return; }
      const drop = (cur.works || []).filter((_, i) => pk.includes(i));
      const excluded = [...new Set([...(cur.excluded || []), ...drop.map(workKey)])];
      // Excluded works leave the list, the included selection, and future searches.
      saveJob({ works: (cur.works || []).filter((_, i) => !pk.includes(i)), picked: [], excluded, included: (cur.included || []).filter(w => !excluded.includes(workKey(w))) });
      renderTransform();
      setStatus(`Excluded ${drop.length} works. They will not come back in future searches.`);
    });
    const trInc = $('#trInclude');
    if (trInc) trInc.addEventListener('click', () => {
      const cur = store.get(TR_KEY, {}) || {};
      const pk = Array.isArray(cur.picked) ? cur.picked : [];
      if (!pk.length) { setStatus('Tick at least one work first, then click Include.'); return; }
      // Included works move out of the search list into the included list.
      const moved = (cur.works || []).filter((_, i) => pk.includes(i));
      const seenInc = new Set((cur.included || []).map(workKey));
      const added = moved.filter(w => !seenInc.has(workKey(w)));
      saveJob({
        included: [...(cur.included || []), ...added],
        works: (cur.works || []).filter((_, i) => !pk.includes(i)),
        picked: []
      });
      renderTransform();
      setStatus(`Included ${added.length} works for Transform and updates.`);
    });
    app.querySelectorAll('input[data-pick]').forEach(c => c.addEventListener('change', () => {
      const cur = store.get(TR_KEY, {}) || {};
      const i = Number(c.dataset.pick);
      const set = new Set(Array.isArray(cur.picked) ? cur.picked : (cur.works || []).map((_, k) => k));
      c.checked ? set.add(i) : set.delete(i);
      saveJob({ picked: [...set].sort((a, b) => a - b) });
    }));

    // Transform: sections go one at a time so each sees the earlier ones; each is saved as it finishes.
    $('#trGo').addEventListener('click', async () => {
      const cur = store.get(TR_KEY, {}) || {};
      if (!settings().key) { setStatus('Add your access key in Settings first.'); return; }
      if (!cur.source || !String(cur.source).trim()) { setStatus('Paste or choose the article text first.'); return; }
      const t = cur.type || 'empirical:q1';
      const target = Math.max(300, Number(cur.words) || 6000);
      const outlineNow = PL2.buildOutline(t, target, cur.budgets || {});
      const chosen = (cur.works || []).filter((_, i) => (Array.isArray(cur.picked) ? cur.picked : (cur.works || []).map((_, k) => k)).includes(i));
      const hasKeywords = (cur.keywords || []).length || Object.values(cur.secKeywords || {}).some(x => x && x.length);
      if (!String(cur.query || '').trim() && !hasKeywords && !confirm('No topic is typed in Step 2, so no new literature will be searched. Continue without new literature?')) {
        setStatus('Type a topic in Step 2, then transform again.');
        return;
      }
      if (!srcChosen().length && !confirm('No literature sources are ticked, so the transform will use only the article. Continue without literature?')) {
        setStatus('Tick sources in Step 2, then transform again.');
        return;
      }
      const style = trRefStyle(cur);
      const sectionsList = W2.REPORT_TYPES[t].sections.filter(s => s.id !== 'references');
      const out = Object.assign({}, cur.sections || {});
      const prior = [];
      for (const s of sectionsList) {
        setStatus(`Transforming “${s.title}”… this can take up to a minute.`);
        try {
          // One section can need several calls: the model often stops short, so keep asking for the missing words.
          const planned = outlineNow.sections.find(x => x.id === s.id).words;
          const wordCount = x => String(x || '').trim().split(/\s+/).filter(Boolean).length;
          let text = '', refs = [];
          // Each section uses its own sources: the works picked for it, or a search of its own topic.
          let secWorks = [];
          const secFound = (cur.found || {})[s.id] || [];
          const secPick = (cur.foundPicks || {})[s.id] || [];
          if (((cur.secIncluded || {})[s.id] || []).length) secWorks = cur.secIncluded[s.id];
          else if (secFound.length && secPick.length) secWorks = secFound.filter((_, k) => secPick.includes(k));
          else if ((cur.included || []).length) secWorks = cur.included;
          else {
            try { setStatus(`Finding literature for “${s.title}”…`); secWorks = (await findFor(s)).slice(0, 6); }
            catch (e) { secWorks = []; }
          }
          for (let attempt = 0; attempt < 6; attempt++) {
            const have = wordCount(text);
            if (attempt > 0 && have >= planned * 0.85) break;
            const need = attempt === 0 ? planned : Math.max(300, planned - have);
            setStatus(`Transforming “${s.title}”: ${have} of ${planned} words so far…`);
            const params = { action: 'transform', type: t, section: s.id, words: need, source: cur.source, works: JSON.stringify(secWorks), style, project: JSON.stringify({ title: cur.title || '' }), prior: JSON.stringify(prior), existing: text, approach: cur.approach || '' };
            const d = await apiPostForm(WRITE_PATH, params);
            if (!d.ok) { if (!text) throw new Error(d.reason || 'The section could not be transformed.'); break; }
            if (!String(d.text || '').trim()) break;
            text = attempt === 0 ? d.text : text + '\n\n' + d.text;
            (d.references || []).forEach(r => { if (!refs.some(q => q.text === r.text)) refs.push(r); });
            out[s.id] = { text: trTrimForeign(text, s.id), references: refs };
            saveJob({ sections: out });
          }
          prior.push({ title: s.title, text });
        } catch (e) {
          setStatus(`Stopped at “${s.title}”: ${e.message}`);
          renderTransform();
          return;
        }
      }
      setStatus('Transform finished. Check each section, then download.');
      renderTransform();
    });

    app.querySelectorAll('textarea[data-tr-edit]').forEach(t => t.addEventListener('change', () => {
      const cur = store.get(TR_KEY, {}) || {};
      const sections = Object.assign({}, cur.sections || {});
      sections[t.dataset.trEdit] = Object.assign({}, sections[t.dataset.trEdit] || {}, { text: t.value });
      saveJob({ sections });
    }));

    // ---- literature and modification controls on each transformed section ----
    const srcChosen = () => [...app.querySelectorAll('input[data-src]')].filter(c => c.checked).map(c => c.dataset.src);
    app.querySelectorAll('input[data-src]').forEach(c => c.addEventListener('change', () => saveJob({ srcTypes: srcChosen() })));
    app.querySelectorAll('input[data-sec-src]').forEach(c => c.addEventListener('change', () => {
      const sid = c.dataset.secSrc.split('|')[0];
      const types = [...app.querySelectorAll(`input[data-sec-src^="${sid}|"]`)].filter(x => x.checked).map(x => x.dataset.secSrc.split('|')[1]);
      const cur = store.get(TR_KEY, {}) || {};
      saveJob({ secSrc: Object.assign({}, cur.secSrc || {}, { [sid]: types }) });
    }));
    const stSel = $('#trStyle');
    if (stSel) stSel.addEventListener('change', () => saveJob({ style: stSel.value }));
    const apSel = $('#trApproach');
    if (apSel) apSel.addEventListener('change', () => saveJob({ approach: apSel.value }));
    const queryFor = sec => {
      const topic = String((store.get(TR_KEY, {}) || {}).query || '').trim();
      if (!topic) return '';
      const heading = sec.title.replace(/^(chapter\s*\d+\.?|\d+(\.\d+)*\.?)\s*/i, '').trim();
      return [topic, heading].filter(Boolean).join(' ');
    };
    // Works whose title already appears in the article are its own citations, so they are left out.
    const normText = x => String(x || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
    const UPDATE_NOTE = 'Integrate the selected new sources where they strengthen the section, and cite each with its key. Keep the whole section: do not shorten it or drop any part. Write only this section: do not write or repeat any other chapter or heading.';
    let lastFind = null;   // counts from the last search, shown to the user
    const findFor = async (sec, progress) => {
      const types = ((store.get(TR_KEY, {}) || {}).secSrc || {})[sec.id] || srcChosen();
      if (!types.length) throw new Error('Choose at least one literature source for this section.');
      const cur2 = store.get(TR_KEY, {}) || {};
      const kws = ((cur2.secKeywords || {})[sec.id] || []).length ? cur2.secKeywords[sec.id] : (cur2.keywords || []);
      const year = cur2.yearFrom || '';
      let found = [];
      if (kws.length) {
        for (let k = 0; k < kws.length; k++) {
          if (progress) progress(`Searching “${kws[k]}” (${k + 1} of ${kws.length} keywords)…`);
          found = found.concat(await findLiterature(kws[k], types, year));
        }
      }
      else {
        const q = queryFor(sec);
        if (!q) throw new Error('Type a topic or keywords in Step 2 first, so the search finds new literature.');
        found = await findLiterature(q, types, year);
      }
      const seenWorks = new Set();
      found = found.filter(w => { const k = w.id || normText(w.title); if (seenWorks.has(k)) return false; seenWorks.add(k); return true; });
      const articleText = normText(cur2.source || '');
      // Validation: keep a work only if its title or abstract mentions one of the section's keywords (or topic terms),
      // and drop front-matter titles. Crossref and Europe PMC results skip the title check inside findLiterature, so it runs here for all sources.
      const terms = (kws.length ? kws : [queryFor(sec) || '']).map(k => normText(k)).filter(t => t.length >= 4);
      const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const hitRes = terms.map(t => new RegExp('(^|[^a-z0-9])' + escRe(t) + '($|[^a-z0-9])'));
      const relevant = w => {
        if (!hitRes.length) return true;
        const title = normText(w.title || ''), abs = normText(abstractOf(w));
        return hitRes.some(re => re.test(title) || re.test(abs));
      };
      const kept = found.filter(w => usableTitle(w.title) && relevant(w) && !(normText(w.title).length >= 20 && articleText.includes(normText(w.title))));
      lastFind = { raw: found.length, kept: kept.length };
      // Works excluded globally or for this section are not brought back.
      const exSec = new Set([...(cur2.excluded || []), ...((cur2.secExcluded || {})[sec.id] || []), ...(cur2.usedKeys || []), ...(cur2.included || []).map(workKey)]);
      return kept.filter(w => !exSec.has(workKey(w)));
    };
    // Literature update: revise the section, then keep asking for the missing words (as the transform does)
    // until it reaches its planned length. The section is kept as it was if the result is still too short.
    const reviseBusy = {};
    const reviseSection = async (sec, instruction, works) => {
      if (reviseBusy[sec.id]) throw new Error('An update for this section is already running. Wait for it to finish.');
      reviseBusy[sec.id] = true;
      try { return await reviseSectionRun(sec, instruction, works); } finally { reviseBusy[sec.id] = false; }
    };
    const reviseSectionRun = async (sec, instruction, works) => {
      const cur = store.get(TR_KEY, {}) || {};
      const sections = Object.assign({}, cur.sections || {});
      // The saved text is used as it is. Trimming it at other chapters' headings dropped the earlier phases' paragraphs on every run.
      const existing = (sections[sec.id] || {}).text || '';
      const wordCount = x => String(x || '').trim().split(/\s+/).filter(Boolean).length;
      const before = wordCount(existing);
      const t = cur.type || 'empirical:q1';
      const note = instruction || 'Revise the section to use the new sources listed, keeping its content and structure.';
      const base = { action: 'transform', type: t, section: sec.id, source: cur.source || existing, works: JSON.stringify(works || []), style: trRefStyle(cur), project: JSON.stringify({ title: cur.title || '' }), prior: '[]', approach: cur.approach || '' };
      // Progress shows beside this section's buttons, not only in the status line at the top of the panel.
      const say = t => { const el = app.querySelector(`[data-sec-note="${sec.id}"]`); if (el) el.textContent = t; setStatus(t); };
      say('Updating this section with the selected sources. This can take a minute…');
      // No word limit on updates: the writer's revision is accepted as it comes, and each update can be run again.
      // One writer call per selected source: each call must add a new paragraph for that source, so every source gets its own text.
      // The section is passed through in turn; a call that adds no text is tried once more.
      let d = null, cov = { covered: 0, total: 0 };
      let text = existing, added = 0, sent = 0, refs = [], missed = [];
      const newParas = [];
      let stoppedAt = null;
      const cites = (w) => { const keys = workCiteKeys(w); return keys.length ? keys[0] : ''; };
      // One short paragraph per set of up to SET_SIZE sources. The writer returns only that paragraph,
      // and it is added at the end of the section, so the rest of the text cannot be shortened.
      const SET_SIZE = 10;
      for (let k = 0; k < works.length; k += SET_SIZE) {
        const chunk = works.slice(k, k + SET_SIZE);
        say(`Writing a paragraph for sources ${k + 1} to ${Math.min(k + SET_SIZE, works.length)} of ${works.length}…`);
        const d1 = await apiPostForm(WRITE_PATH, Object.assign({}, base, { action: 'addset', works: JSON.stringify(chunk), existing: text.slice(-3000), outline: text.split('\n').filter(l => /^#{1,6}\s/.test(l.trim())).map(l => l.trim()).join('\n').slice(0, 2000), instruction: note }));
        if (!d1.ok) throw new Error(d1.reason || 'The section could not be revised.');
        // The writer cites by label (S1, S2 ...). Each label becomes this app's key for that source, so the check below matches.
        // A citation cut off by the writer (a line break or an ellipsis inside the tag) is a failed draft: mark it, so the paragraph is not kept.
        const brokenCite = /\{\{\s*cite:[^}]*[\n\r…]/i.test(String(d1.text || ''));
        const labelled = String(d1.text || '').replace(/\{\{\s*cite:\s*([^}]+)\}\}/gi, (m, list) => {
          // The writer may cite several labels in one tag, e.g. {{cite:S1, S2}}; map each label to its source and emit one tag per source.
          const keys = String(list).split(',').map(x => x.trim()).map(x => { const mm = x.match(/^S(\d+)$/i); const w = mm ? chunk[Number(mm[1]) - 1] : null; return w ? sourceKeyFor(w) : null; });
          if (keys.some(k => !k)) return m;
          return keys.map(k => '{{cite:' + k + '}}').join(' ');
        });
        const para = trTrimForeign(labelled, sec.id).replace(/^#+\s.*$/gm, '').trim();
        sent += chunk.length;
        if (d1.references) refs = mergeRefs(refs, d1.references);
        // A set whose paragraph does not cite any of its sources is a failed attempt. Stop here, so no more sources are paid for.
        const citesHere = para ? citeKeysIn(para) : new Set();
        const citedHere = chunk.filter(w => workCiteKeys(w).some(k => citesHere.has(k))).length;
        const okHere = para && !brokenCite && wordCount(para) >= 15 && citedHere > 0;
        if (okHere) { text = text.trim() + '\n\n' + para; newParas.push(para); }
        else missed.push(...chunk);
        if (!okHere || citedHere < chunk.length) {
          stoppedAt = { from: k + 1, to: Math.min(k + SET_SIZE, works.length) };
          break;
        }
      }
      if (stoppedAt && !newParas.length) throw new Error(`The writer did not cite sources ${stoppedAt.from} to ${stoppedAt.to}, so the update stopped there and no more sources were sent. The section was kept as it was.`);
      if (text.trim() === String(existing).trim() || wordCount(text) <= before) throw new Error('The writer added no new paragraph from the selected sources, so the section was kept as it was.');
      added = wordCount(text) - before;
      cov = citedCoverage(text, works);
      cov.missed = missed.length;
      d = { references: refs, ok: true, sources: sent };
      cov.sources = d.sources;
      cov.added = added;
      // Read the saved draft again before saving: the writer call can take a minute, and other sections may have changed meanwhile.
      const latest = store.get(TR_KEY, {}) || {};
      const sectionsNow = Object.assign({}, latest.sections || {});
      const prevSection = sectionsNow[sec.id] || null;
      // Another update may have saved while this one ran; its paragraphs are kept, and these are added after them.
      const savedNow = (prevSection || {}).text || '';
      const finalText = newParas.length ? savedNow.trim() + '\n\n' + newParas.join('\n\n') : text;
      sectionsNow[sec.id] = { text: finalText, references: mergeRefs((prevSection || {}).references, d.references || []) };
      if (!saveJob({ sections: sectionsNow, secPrev: prevSection ? Object.assign({}, latest.secPrev || {}, { [sec.id]: prevSection }) : (latest.secPrev || {}) })) throw new Error(STORAGE_FULL_MSG);
      return cov;
    };
    app.querySelectorAll('[data-tr-restore]').forEach(b => b.addEventListener('click', () => {
      const id = b.dataset.trRestore; const cur = store.get(TR_KEY, {}) || {};
      const prev = (cur.secPrev || {})[id]; if (!prev) return;
      const sections = Object.assign({}, cur.sections || {});
      const current = sections[id] || null;
      sections[id] = { text: prev.text || '', references: prev.references || [] };
      // The version being replaced is kept, so Restore can be clicked again to go back to it.
      saveJob({ sections, secPrev: Object.assign({}, cur.secPrev || {}, current ? { [id]: current } : {}) });
      renderTransform();
      noteFor(id, 'Previous version restored. Click Restore previous version again to go back to the newer one.');
    }));
    // Relevance check: the writer judges each new work against this section before it is ticked.
    const verifySection = async (sec, works, say) => {
      const cur = store.get(TR_KEY, {}) || {};
      const kws = ((cur.secKeywords || {})[sec.id] || []).length ? cur.secKeywords[sec.id] : (cur.keywords || []);
      const out = {};
      for (let i = 0; i < works.length; i += 40) {
        const chunk = works.slice(i, i + 40);
        say(`Checking the relevance of ${works.length} works to this section (${i + 1} to ${i + chunk.length})…`);
        const items = chunk.map(w => ({ key: workKey(w), title: w.title || '', abstract: String(abstractOf(w) || '').slice(0, 600) }));
        const d = await apiPostForm(WRITE_PATH, { action: 'verify', type: cur.type || 'empirical:q1', section: sec.id, project: JSON.stringify({ title: cur.title || '' }), keywords: kws.join(', '), items: JSON.stringify(items) });
        if (!d.ok) throw new Error(d.reason || 'The relevance check failed.');
        (d.verdicts || []).forEach(v => { out[v.key] = { relevant: v.relevant === true, reason: String(v.reason || '') }; });
      }
      return out;
    };
    // Clears this section's memory of works shown before, then searches again, so every result is shown. Excluded and used works stay hidden.
    app.querySelectorAll('[data-tr-fresh]').forEach(b => b.addEventListener('click', () => {
      const id = b.dataset.trFresh; const cur = store.get(TR_KEY, {}) || {};
      saveJob({ secSeen: Object.assign({}, cur.secSeen || {}, { [id]: [] }) });
      const f = app.querySelector(`[data-tr-find="${id}"]`); if (f) f.click();
    }));
    app.querySelectorAll('[data-tr-find]').forEach(b => b.addEventListener('click', async () => {
      const sec = secs.find(x => x.id === b.dataset.trFind);
      try {
        // Progress shows beside this section's buttons, and the page scrolls to it.
        const say = t => { noteFor(sec.id, t); };
        say(`Searching literature for “${sec.title}”. This can take a minute…`);
        const noteEl = app.querySelector(`[data-sec-note="${sec.id}"]`);
        if (noteEl && noteEl.scrollIntoView) noteEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
        const found = await findFor(sec, say);
        const cur = store.get(TR_KEY, {}) || {};
        // Per section: the list shows only works this section has not shown before, so a repeat search does not bring back old works.
        const seenBefore = new Set((cur.secSeen || {})[sec.id] || []);
        const fresh = found.filter(w => !seenBefore.has(workKey(w)));
        const seenAll = new Set([...seenBefore, ...found.map(workKey)]);
        let verdicts = {}, verifyErr = '';
        if (fresh.length) {
          try { verdicts = await verifySection(sec, fresh, say); } catch (e) { verifyErr = e.message || 'The relevance check failed.'; }
        }
        // Only relevant works are ticked. If the check failed, none is ticked and each work says it was not checked.
        if (verifyErr) fresh.forEach(w => { verdicts[workKey(w)] = { relevant: false, reason: 'Not checked' }; });
        fresh.forEach(w => { if (!usableAuthor(w)) verdicts[workKey(w)] = { relevant: false, reason: 'No usable author name, so it cannot be cited' }; });
        const relIdx = fresh.map((w, i) => i).filter(i => (verdicts[workKey(fresh[i])] || {}).relevant === true);
        const all = Object.assign({}, cur.found || {}), picks = Object.assign({}, cur.foundPicks || {});
        all[sec.id] = fresh; picks[sec.id] = relIdx;
        if (!saveJob({ found: all, foundPicks: picks, verdicts: Object.assign({}, cur.verdicts || {}, { [sec.id]: verdicts }), secSeen: Object.assign({}, cur.secSeen || {}, { [sec.id]: [...seenAll] }) })) { noteFor(sec.id, STORAGE_FULL_MSG); return; }
        renderTransform();
        const st = lastFind || { raw: found.length, kept: found.length };
        if (!fresh.length) noteFor(sec.id, `No new works for this section (${st.raw} results checked; the ones already shown are hidden). Try different keywords.`);
        else if (verifyErr) noteFor(sec.id, `${fresh.length} new works, but the relevance check failed (${verifyErr}). None is ticked; tick the ones to use.`);
        else noteFor(sec.id, `${fresh.length} new works: ${relIdx.length} relevant (ticked), ${fresh.length - relIdx.length} not relevant (unticked, reason shown). Click Update when ready.`);
      } catch (e) { noteFor(sec.id, e.message || 'The literature search failed.'); }
    }));
    app.querySelectorAll('input[data-tr-fpick]').forEach(c => c.addEventListener('change', () => {
      const [sid, idx] = c.dataset.trFpick.split(':');
      const cur = store.get(TR_KEY, {}) || {};
      const set = new Set((cur.foundPicks || {})[sid] || []);
      c.checked ? set.add(Number(idx)) : set.delete(Number(idx));
      const fp = Object.assign({}, cur.foundPicks || {}); fp[sid] = [...set].sort((a, b) => a - b);
      saveJob({ foundPicks: fp });
    }));
    // Clears this section's Included and Updated lists and its search memory.
    // Optionally, the text written from those sources is removed too: a paragraph that cites only those sources is dropped,
    // and their citation markers and references are removed from paragraphs that also cite other sources.
    app.querySelectorAll('[data-tr-clearlist]').forEach(b => b.addEventListener('click', () => {
      const id = b.dataset.trClearlist;
      if (!confirm('Clear the Included and Updated lists for this section?')) return;
      const cur = store.get(TR_KEY, {}) || {};
      const works = [...((cur.secUsedWorks || {})[id] || []), ...((cur.secIncluded || {})[id] || [])];
      // Sources cleared earlier (kept in secCleared) are still offered for removal, so the text can be tied to them later.
      const earlier = [...(((cur.secCleared || {})[id]) || []), ...((((cur.secWritten || {})[id]) || []))];
      const removed = new Set([...works.flatMap(workCiteKeys), ...earlier]);
      const clearedKeys = new Set([...removed, ...works.map(workKey), ...earlier]);
      const pick = obj => Object.assign({}, obj || {}, { [id]: [] });
      const patch = {
        secUsedWorks: pick(cur.secUsedWorks), secIncluded: pick(cur.secIncluded), secUsed: pick(cur.secUsed),
        secBatch: Object.assign({}, cur.secBatch || {}, { [id]: { run: 0 } }), secNotes: pick(cur.secNotes), secSeen: pick(cur.secSeen), foundPicks: pick(cur.foundPicks),
        // Cleared sources are fresh again: they leave the used and seen lists, so a new search can find them.
        usedKeys: (cur.usedKeys || []).filter(k => !clearedKeys.has(k)),
        seenKeys: (cur.seenKeys || []).filter(k => !clearedKeys.has(k)),
        // The update takes used works out of the found list. Clear puts the cleared sources back there, as options.
        found: Object.assign({}, cur.found || {}, { [id]: (() => { const have = ((cur.found || {})[id]) || []; const seen = new Set(have.map(workKey)); return have.concat(works.filter(w => !seen.has(workKey(w)))); })() }),
        foundPicks: Object.assign({}, cur.foundPicks || {}, { [id]: [] }),
        // The shared Included list also holds these sources; a new search skips anything in it, so they leave it too.
        included: (cur.included || []).filter(w => !clearedKeys.has(workKey(w)))
      };
      let msg = 'Included and Updated lists cleared for this section. The text is kept.';
      const sec = (cur.sections || {})[id];
      if (sec && removed.size && confirm('Also remove the text written from these sources? Paragraphs that cite only these sources are removed, and their citations are taken out of the others. Cancel keeps the text.')) {
        const { text, references } = pruneBySources(sec.text, sec.references, removed);
        patch.secPrev = Object.assign({}, cur.secPrev || {}, { [id]: sec });
        patch.sections = Object.assign({}, cur.sections || {}, { [id]: { text, references } });
        patch.secCleared = Object.assign({}, cur.secCleared || {}, { [id]: [] });
        msg = 'Included and Updated lists cleared, and the text written from these sources removed. Use Search again, show all results to see its works again.';
      } else if (sec && removed.size) {
        // Text kept: remember these sources so a later clear can still remove their text.
        patch.secCleared = Object.assign({}, cur.secCleared || {}, { [id]: [...removed] });
      }
      saveJob(patch);
      renderTransform();
      noteFor(id, msg);
    }));
    app.querySelectorAll('[data-tr-selall]').forEach(b => b.addEventListener('click', () => {
      const sid = b.dataset.trSelall;
      const c = store.get(TR_KEY, {}) || {};
      const list = (c.found || {})[sid] || [];
      const vd = (c.verdicts || {})[sid] || {};
      const idx = list.map((_, i) => i).filter(i => !vd[workKey(list[i])] || vd[workKey(list[i])].relevant);
      saveJob({ foundPicks: Object.assign({}, c.foundPicks || {}, { [sid]: idx }) });
      renderTransform();
      const skipped = list.length - idx.length;
      if (!list.length) noteFor(sid, 'No works to select. Search literature first.');
      else if (!idx.length) noteFor(sid, `None of the ${list.length} works is relevant to this section, so none was ticked. Tick any you still want.`);
      else noteFor(sid, `Ticked the ${idx.length} relevant works.${skipped ? ` ${skipped} not relevant ${skipped === 1 ? 'work was' : 'works were'} left unticked; tick ${skipped === 1 ? 'it' : 'them'} yourself if you want ${skipped === 1 ? 'it' : 'them'}.` : ''}`);
    }));
    app.querySelectorAll('[data-tr-selnone]').forEach(b => b.addEventListener('click', () => {
      const sid = b.dataset.trSelnone;
      const c = store.get(TR_KEY, {}) || {};
      saveJob({ foundPicks: Object.assign({}, c.foundPicks || {}, { [sid]: [] }) });
      renderTransform();
    }));
    // Include & update: the ticked works become this section's included list, then the section is updated with them.
    app.querySelectorAll('[data-tr-incupd]').forEach(b => b.addEventListener('click', () => {
      const sid = b.dataset.trIncupd;
      const cur = store.get(TR_KEY, {}) || {};
      const list = (cur.found || {})[sid] || [], pk = (cur.foundPicks || {})[sid] || [];
      if (!pk.length) { noteFor(sid, 'Tick the literature you want to include first.'); return; }
      const picked = list.filter((_, i) => pk.includes(i));
      saveJob({ secIncluded: Object.assign({}, cur.secIncluded || {}, { [sid]: picked }) });
      renderTransform();
      const applyBtn = app.querySelector(`button[data-tr-apply="${sid}"]`);
      if (applyBtn) applyBtn.click();
    }));
    app.querySelectorAll('[data-tr-exclude]').forEach(b => b.addEventListener('click', () => {
      const sid = b.dataset.trExclude;
      const cur = store.get(TR_KEY, {}) || {};
      const list = (cur.found || {})[sid] || [], pk = (cur.foundPicks || {})[sid] || [];
      if (!pk.length) { noteFor(sid, 'Tick at least one work for this section first, then click Exclude.'); return; }
      const drop = list.filter((_, i) => pk.includes(i));
      const secEx = Object.assign({}, cur.secExcluded || {}, { [sid]: [...new Set([...((cur.secExcluded || {})[sid] || []), ...drop.map(workKey)])] });
      const keep = list.filter((_, i) => !pk.includes(i));
      const inc = Object.assign({}, cur.secIncluded || {}, { [sid]: ((cur.secIncluded || {})[sid] || []).filter(w => !drop.some(d => workKey(d) === workKey(w))) });
      saveJob({ found: Object.assign({}, cur.found || {}, { [sid]: keep }), foundPicks: Object.assign({}, cur.foundPicks || {}, { [sid]: [] }), secExcluded: secEx, secIncluded: inc });
      renderTransform();
      noteFor(sid, `Excluded ${drop.length} works for this section. They will not come back in future searches for it.`);
    }));
    app.querySelectorAll('[data-tr-include]').forEach(b => b.addEventListener('click', () => {
      const sid = b.dataset.trInclude;
      const cur = store.get(TR_KEY, {}) || {};
      const list = (cur.found || {})[sid] || [], pk = (cur.foundPicks || {})[sid] || [];
      if (!pk.length) { setStatus('Tick at least one work for this section first, then click Include.'); return; }
      const inc = Object.assign({}, cur.secIncluded || {}, { [sid]: list.filter((_, i) => pk.includes(i)) });
      saveJob({ secIncluded: inc });
      renderTransform();
      setStatus(`Included ${inc[sid].length} works for this section. Update will use them.`);
    }));
    app.querySelectorAll('[data-tr-apply]').forEach(b => b.addEventListener('click', async () => {
      const sec = secs.find(x => x.id === b.dataset.trApply);
      const cur = store.get(TR_KEY, {}) || {};
      const found = (cur.found || {})[sec.id] || [], picks = (cur.foundPicks || {})[sec.id] || [];
      const fromIncluded = ((cur.secIncluded || {})[sec.id] || []).length > 0;
      // A source is skipped only when its citation is already in this section's text, not because an earlier run sent it.
      const citedNow = citeKeysIn(((cur.sections || {})[sec.id] || {}).text || '');
      const candidates = fromIncluded ? (cur.secIncluded[sec.id] || []) : found.filter((_, i) => picks.includes(i));
      const skippedCited = candidates.filter(w => workCiteKeys(w).some(k => citedNow.has(k))).length;
      const skippedAuthor = candidates.filter(w => !usableAuthor(w)).length;
      const allWorks = candidates.filter(w => !workCiteKeys(w).some(k => citedNow.has(k)) && usableAuthor(w));
      // One update uses at most 30 sources, so the writer can cite them. The rest stay ticked for the next Update.
      const UPDATE_BATCH = 1000;
      const works = allWorks.slice(0, UPDATE_BATCH);
      let restWorks = allWorks.slice(UPDATE_BATCH);
      let restKeys = new Set(restWorks.map(workKey));
      if (!works.length) { noteFor(sec.id, `Nothing sent to the writer, so no cost was incurred: ${skippedCited} already cited, ${skippedAuthor} with no usable author name. Tick sources that are not yet cited and have an author name.`); return; }
      noteFor(sec.id, `Sending ${works.length} sources to the writer. Skipped: ${skippedCited} already cited, ${skippedAuthor} with no usable author name.`);
      if (b.disabled) return;
      b.disabled = true; b.textContent = 'Updating…';
      // Source choices are locked while the update runs; the list is redrawn when it finishes.
      app.querySelectorAll(`input[data-tr-fpick^="${sec.id}:"]`).forEach(c => { c.disabled = true; });
      try {
        noteFor(sec.id, `Updating with ${works.length} ${fromIncluded ? 'included' : 'ticked'} sources. This can take a minute.`);
        const noteEl = app.querySelector(`[data-sec-note="${sec.id}"]`);
        if (noteEl && noteEl.scrollIntoView) noteEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
        const cov = await reviseSection(sec, UPDATE_NOTE, works);
        const after = ((store.get(TR_KEY, {}) || {}).sections || {})[sec.id] || {};
        const words = String(after.text || '').trim().split(/\s+/).filter(Boolean).length;
        const cites = (String(after.text || '').match(/\{\{cite:/g) || []).length;
        // Only sources the new text actually cites are marked Updated; the others stay ticked for the next run.
        const citedNow = citeKeysIn(after.text);
        const usedWorks = works.filter(w => workCiteKeys(w).some(k => citedNow.has(k)));
        const unusedWorks = works.filter(w => !usedWorks.includes(w));
        restKeys = new Set(restWorks.map(workKey));
        const refKeys = new Set((after.references || []).map(r => nkey(r.key)));
        const noRef = [...citedNow].filter(k => !refKeys.has(k)).length;
        const badAuthors = (after.references || []).filter(r => badRefName(r.text)).length;
        const checkText = noRef || badAuthors ? ` Check: ${noRef} citation${noRef === 1 ? '' : 's'} have no reference; ${badAuthors} reference${badAuthors === 1 ? ' has' : 's have'} a broken author name.` : '';
        // Batch count for this section: the run number, and how many batches remain.
        // A missing or malformed counter starts at 0, so the batch number is never NaN.
        const runNo = (Number((((store.get(TR_KEY, {}) || {}).secBatch || {})[sec.id] || {}).run) || 0) + 1;
        const leftBatches = Math.ceil(restWorks.length / UPDATE_BATCH);
        const batchText = restWorks.length
          ? `Batch ${runNo} done (${works.length} sources). ${restWorks.length} sources are still ${fromIncluded ? 'included' : 'ticked'}: ${leftBatches} batch${leftBatches === 1 ? '' : 'es'} left. Click Update for batch ${runNo + 1}.`
          : `Batch ${runNo} done (${works.length} sources). All batches for this section are done.`;
        const msg = `Updated at ${new Date().toLocaleTimeString()}: ${words} words (${cov.added >= 0 ? '+' : ''}${cov.added} in this run), ${cites} citations. Sources sent to the writer: ${cov.sources === undefined ? 'unknown' : cov.sources} of ${works.length}. ${usedWorks.length} of ${works.length} sources in this batch are cited and marked Updated.${unusedWorks.length ? ` ${unusedWorks.length} not cited: left out of the queue and not marked Updated. They can be ticked again in the search list.` : ''} ${batchText}${checkText}`;
        // Used sources are marked as used and un-ticked, so they no longer look like they are waiting.
        const latest = store.get(TR_KEY, {}) || {};
        const batchState = Object.assign({}, latest.secBatch || {}, { [sec.id]: { run: restWorks.length ? runNo : 0 } });
        const usedKeys = usedWorks.map(w => w.id || String(w.title || '').toLowerCase());
        saveJob({
          secBatch: batchState,
          secNotes: Object.assign({}, latest.secNotes || {}, { [sec.id]: msg }),
          secUsed: Object.assign({}, latest.secUsed || {}, { [sec.id]: usedKeys }),
          foundPicks: Object.assign({}, latest.foundPicks || {}, { [sec.id]: [] }),
          secIncluded: Object.assign({}, latest.secIncluded || {}, { [sec.id]: [] })
        });
        markUsed(usedWorks, sec.id);
        // Sources not used in this batch stay ticked (or included) for the next Update.
        const after2 = store.get(TR_KEY, {}) || {};
        if (fromIncluded) saveJob({ secIncluded: Object.assign({}, after2.secIncluded || {}, { [sec.id]: restWorks }) });
        else { const fl = (after2.found || {})[sec.id] || []; saveJob({ foundPicks: Object.assign({}, after2.foundPicks || {}, { [sec.id]: fl.map((_, i) => i).filter(i => restKeys.has(workKey(fl[i]))) }) }); }
        renderTransform();
        noteFor(sec.id, msg);
      } catch (e) {
        // The failure is kept with the section, so it stays visible after the page re-renders.
        const msg = `Not updated at ${new Date().toLocaleTimeString()}: ${e.message}`;
        saveJob({ secNotes: Object.assign({}, (store.get(TR_KEY, {}) || {}).secNotes || {}, { [sec.id]: msg }) });
        renderTransform();
        noteFor(sec.id, msg);
      }
    }));
    app.querySelectorAll('[data-tr-modify]').forEach(b => b.addEventListener('click', async () => {
      const sec = secs.find(x => x.id === b.dataset.trModify);
      const instr = ((app.querySelector(`textarea[data-tr-instr="${sec.id}"]`) || {}).value || '').trim();
      if (!instr) { noteFor(sec.id, 'Write the instruction for this section first.'); return; }
      try {
        setStatus(`Modifying “${sec.title}”…`);
        await reviseSection(sec, instr, []);
        renderTransform();
        noteFor(sec.id, `“${sec.title}” modified.`);
      } catch (e) { noteFor(sec.id, e.message); }
    }));
    // Keywords: Include adds the typed keywords to the article (Step 2) or to one section; × removes one.
    const kwGet = scope => { const c = store.get(TR_KEY, {}) || {}; return scope === 'global' ? (c.keywords || []) : ((c.secKeywords || {})[scope] || []); };
    const kwSet = (scope, list) => { const c = store.get(TR_KEY, {}) || {}; if (scope === 'global') saveJob({ keywords: list }); else saveJob({ secKeywords: Object.assign({}, c.secKeywords || {}, { [scope]: list }) }); renderTransform(); };
    app.querySelectorAll('[data-kw-include]').forEach(b => b.addEventListener('click', () => {
      const scope = b.dataset.kwInclude;
      const typed = String(((app.querySelector(`input[data-kw-input="${scope}"]`) || {}).value) || '').split(',').map(x => x.trim()).filter(Boolean);
      if (!typed.length) { setStatus('Type a keyword first.'); return; }
      kwSet(scope, [...new Set([...kwGet(scope), ...typed])]);
    }));
    app.querySelectorAll('[data-kw-clear]').forEach(b => b.addEventListener('click', () => {
      const scope = b.dataset.kwClear;
      if (!confirm('Remove all keywords here? Searches will then use the global keywords.')) return;
      kwSet(scope, []);
    }));
    app.querySelectorAll('[data-kw-remove]').forEach(b => b.addEventListener('click', () => {
      const [scope, i] = b.dataset.kwRemove.split('|');
      const list = kwGet(scope).slice(); list.splice(Number(i), 1); kwSet(scope, list);
    }));
    const updAll = $('#trUpdateAll');
    if (updAll) updAll.addEventListener('click', async () => {
      if (!settings().key) { setStatus('Add your access key in Settings first.'); return; }
      const start = store.get(TR_KEY, {}) || {};
      const report = [];
      for (const sec of secs) {
        if (!((start.sections || {})[sec.id] || {}).text) continue;
        try {
          setStatus(`Finding literature for “${sec.title}”…`);
          const usedAll = new Set(((store.get(TR_KEY, {}) || {}).usedKeys) || []);
          const incl = (((store.get(TR_KEY, {}) || {}).secIncluded || {})[sec.id] || []).filter(w => !usedAll.has(workKey(w)));
          const works = incl.length ? incl : (await findFor(sec)).slice(0, 5);
          if (!works.length) { report.push(`${sec.title}: no sources found`); continue; }
          setStatus(`Updating “${sec.title}” with ${works.length} sources…`);
          await reviseSection(sec, UPDATE_NOTE, works);
          markUsed(works, sec.id);
          report.push(`${sec.title}: updated`);
        } catch (e) { report.push(`${sec.title}: ${e.message}`); }
      }
      renderTransform();
      setStatus('Update finished. ' + report.join(' · '));
    });

    // ---- paragraph controls ----
    const modSel = $('#trModType');
    if (modSel) modSel.addEventListener('change', () => saveJob({ modType: modSel.value }));
    app.querySelectorAll('textarea[data-tr-p]').forEach(t => t.addEventListener('change', () => {
      const [secId, i] = t.dataset.trP.split('|');
      const { blocks } = paraState(secId);
      if (t.value.trim()) blocks[Number(i)] = t.value.trim();
      saveBlocks(secId, blocks);
    }));
    app.querySelectorAll('[data-tr-suit]').forEach(b => b.addEventListener('click', () => paraAction(b.dataset.trSuit, 'connect', '')));
    app.querySelectorAll('[data-tr-pmod]').forEach(b => b.addEventListener('click', () => {
      const instr = ((app.querySelector(`input[data-tr-pinstr="${b.dataset.trPmod}"]`) || {}).value || '').trim();
      paraAction(b.dataset.trPmod, 'discuss', instr);
    }));
    app.querySelectorAll('[data-tr-plus]').forEach(b => b.addEventListener('click', () => {
      const [secId, i] = b.dataset.trPlus.split('|');
      const { blocks } = paraState(secId);
      blocks.splice(Number(i) + 1, 0, 'New paragraph: write the instruction in the box, then click Modify with AI.');
      saveBlocks(secId, blocks);
      renderTransform();
    }));

    const dl = $('#trDown');
    if (dl) dl.addEventListener('click', () => {
      const cur = store.get(TR_KEY, {}) || {};
      const html = buildWordHtml(cur, secs);
      download('transformed-' + (cur.type || 'document').replace(/[^a-z0-9]+/gi, '-') + '.doc', html, 'application/msword');
    });
  }

  // ---------- router ----------
  function route() {
    stopPolling();
    const h = location.hash.replace(/^#/, '') || '/';
    const parts = h.split('/').filter(Boolean);
    $$('.topnav a').forEach(a => a.classList.toggle('active', a.dataset.nav === (parts[0] || 'home') || (parts[0] === 'review' && a.dataset.nav === 'reviews')));
    window.scrollTo(0, 0);
    if (!parts.length) return renderHome();
    if (parts[0] === 'reviews') return renderReviews();
    if (parts[0] === 'review' && parts[1]) return renderReview(decodeURIComponent(parts[1]));
    if (parts[0] === 'demo') return renderDemo();
    if (parts[0] === 'how') return renderHow();
    if (parts[0] === 'journals') return renderJournals();
    if (parts[0] === 'write') return renderWriting();
    if (parts[0] === 'transform') return renderTransform();
    if (parts[0] === 'dashboard') return renderDashboard();
    if (parts[0] === 'admin') return renderAdmin();
    renderHome();
  }
  window.addEventListener('hashchange', route);

  // ---------- settings dialog ----------
  const dlg = $('#settingsDialog');
  function openSettings(msg) {
    const s = settings();
    $('#setKey').value = s.key; $('#setApi').value = s.api; $('#setOaKey').value = s.oaKey || '';
    $('#settingsStatus').textContent = msg || '';
    if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', '');
  }
  $('#settingsBtn').addEventListener('click', () => openSettings());
  $('#closeSettings').addEventListener('click', () => dlg.close());
  $('#settingsForm').addEventListener('submit', (e) => {
    const key = $('#setKey').value.trim(); const api = $('#setApi').value.trim();
    if (!key) { e.preventDefault(); $('#settingsStatus').textContent = 'Please enter the access key.'; return; }
    store.set('key', key); store.set('api', api && api !== CFG.apiBase ? api : ''); store.set('oaKey', $('#setOaKey').value.trim());
    toast('Settings saved'); setTimeout(() => { refreshMe(); route(); }, 50);
  });
  $('#testKeyBtn').addEventListener('click', async () => {
    const st = $('#settingsStatus'); const key = $('#setKey').value.trim(); const api = ($('#setApi').value.trim() || CFG.apiBase).replace(/\/$/, '');
    st.innerHTML = '<span class="spinner"></span> Testing…';
    try {
      const res = await fetch(api + CFG.statusPath + '?id=connection-test&key=' + encodeURIComponent(key), { cache: 'no-store' });
      const data = await res.json().catch(() => null);
      if (res.ok && data && data.ok) st.innerHTML = '<span class="yes">✓ Connected — access key accepted.</span>';
      else if (res.status === 401) st.innerHTML = '<span class="no">✗ The server rejected this access key.</span>';
      else st.innerHTML = '<span class="no">✗ Unexpected response (' + res.status + '). Is the n8n workflow active?</span>';
    } catch (err) { st.innerHTML = '<span class="no">✗ Could not reach the API: ' + esc(err.message) + '</span>'; }
  });

  // ---------- HOME ----------
  function renderHome() {
    const s = settings();
    app.innerHTML = `
    <section class="hero">
      <div class="hero-copy">
        <div class="eyebrow">Pre-submission review</div>
        <h1>See your manuscript the way a Q1 reviewer will — before you submit.</h1>
        <p class="lead">Upload your paper and a panel of seven independent AI specialist reviewers evaluates it against an adaptive checklist drawn from a library of up to 300 Scopus Q1 criteria. Every finding must quote your manuscript, numbers and references are checked by rule and against Crossref, and an adjudicator removes duplicates and unsupported claims.</p>
        <div class="pill-row">
          <span class="pill"><b>Evidence-first</b> findings quote your text</span>
          <span class="pill"><b>No fake score</b> diagnostic profile instead</span>
          <span class="pill"><b>Human-in-the-loop</b> confirm or reject each finding</span>
        </div>
        <div class="agent-list">
          <div class="agent"><i>A</i><div><b>Theory, gap & contribution</b><span>Fake-gap detection, theory–hypothesis mapping</span></div></div>
          <div class="agent"><i>B</i><div><b>Methodologist</b><span>Sampling, measurement, CMB, causality</span></div></div>
          <div class="agent"><i>C</i><div><b>Statistician</b><span>SEM / PLS-SEM, regression, mediation, effect sizes</span></div></div>
          <div class="agent"><i>D</i><div><b>Literature</b><span>Coverage, recency, citation quality</span></div></div>
          <div class="agent"><i>E</i><div><b>Integrity & reproducibility</b><span>Ethics, declarations, anomalies</span></div></div>
          <div class="agent"><i>F</i><div><b>Reporting & journal fit</b><span>PRISMA, COREQ, STROBE, aims & scope</span></div></div>
          <div class="agent"><i>G</i><div><b>Editor view</b><span>Storyline, desk-rejection risks</span></div></div>
          <div class="agent"><i>+</i><div><b>Verification engines</b><span>Number audit · cross-validation · Crossref</span></div></div>
        </div>
        <p style="margin-top:18px"><a href="#/demo">See a sample report →</a></p>
      </div>

      <form class="card" id="submitForm" novalidate>
        <div class="card-head"><h2>Start a review</h2><small>PDF · DOCX · TXT, up to ${CFG.maxFileMB} MB</small></div>
        ${s.key ? '' : '<div class="keywarn"><span>Add your access key before submitting.</span><button type="button" class="btn btn-sm btn-ghost" id="addKeyBtn">Add key</button></div>'}
        <div class="dropzone" id="dropzone" tabindex="0" role="button" aria-label="Choose manuscript file">
          <div class="dz-icon" aria-hidden="true">📄</div>
          <div class="dz-title">Drop your manuscript here</div>
          <div class="muted" style="font-size:13px">or click to browse</div>
        </div>
        <input type="file" id="fileInput" accept=".pdf,.docx,.txt,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain" hidden>
        <label class="field" style="margin-top:-4px"><span>…or paste a link to the manuscript <i>Google Drive, Dropbox or a direct PDF/DOCX link</i></span><input type="url" name="manuscript_url" id="manuscriptUrl" placeholder="https://drive.google.com/file/d/…" autocomplete="off"></label>
        <div class="grid-2">
          <label class="field"><span>Target journal <i>optional — leave blank if undecided</i></span><input type="text" name="target_journal" id="targetJournal" placeholder="e.g. Tourism Management" autocomplete="off"><span class="muted" id="tjChips" style="font-size:13px;margin-top:6px;display:block"></span></label>
          <label class="field"><span>Paper title <i>optional</i></span><input type="text" name="paper_title" placeholder="Detected automatically"></label>
          <label class="field"><span>Reviewer name <i>optional</i></span><input type="text" name="reviewer_name" id="reviewerName" placeholder="Shown on the report and dashboard" maxlength="120"></label>
          <label class="field"><span>Article type</span>
            <select name="article_type">
              <option>Original research article</option><option>Systematic / scoping review</option><option>Meta-analysis</option>
              <option>Conceptual paper</option><option>Case study</option><option>Research note / short communication</option>
            </select></label>
          <label class="field"><span>Research field</span><input type="text" name="field" value="Tourism & Hospitality"></label>
        </div>
        <p style="margin:-4px 0 12px"><button type="button" class="btn btn-sm btn-ghost" id="tjFind">Find journals for this paper</button> <span class="muted" style="font-size:13px">Best-fit suggestions from the journal finder, with the Scopus, SJR, WoS and ABDC status of each. Optional.</span></p>
        <div class="field" style="margin-bottom:6px"><span>Review type</span></div>
        <div class="modes">
          <div class="mode"><input type="radio" name="review_mode" id="m1" value="QUICK"><label for="m1"><b>Quick</b><span>Core checks only · 15 refs · fastest</span></label></div>
          <div class="mode"><input type="radio" name="review_mode" id="m2" value="FULL_Q1" checked><label for="m2"><b>Full Q1</b><span>Core + extended checks · 40 refs · recommended</span></label></div>
          <div class="mode"><input type="radio" name="review_mode" id="m3" value="FORENSIC"><label for="m3"><b>Forensic</b><span>Every applicable check · 80 refs · deepest</span></label></div>
          <div class="mode"><input type="radio" name="review_mode" id="m4" value="ORIGINALITY"><label for="m4"><b>Originality only</b><span>Copying & AI-writing screen · ~2–4 min · cheapest</span></label></div>
        </div>
        <details class="more" id="revMore">
          <summary>This is a revised version of an earlier review (optional)</summary>
          <label class="field"><span>Earlier review</span><select id="prevSelect"><option value="">— first version —</option></select></label>
          <label class="field"><span>…or earlier review ID</span><input type="text" name="previous_review_id" id="prevId" placeholder="REV-20260926-ABCDE" autocomplete="off"></label>
          <p class="muted" style="font-size:13px;margin:-4px 0 12px">The new report gets a <i>Changes since last version</i> tab showing which findings were fixed, which remain and which are new.</p>
        </details>
        <details class="more" id="dataMore">
          <summary>Raw dataset — reproduce the statistics (optional)</summary>
          <label class="field"><span>Survey / analysis dataset <i>CSV, XLSX or SAV · up to 25 MB</i></span><input type="file" id="datasetInput" accept=".csv,.xlsx,.xls,.sav,text/csv"></label>
          <p class="muted" style="font-size:13px;margin:-4px 0 12px">If you attach the raw data, a private statistics engine re-runs reliability (alpha, CR, AVE), loadings, HTMT and the structural paths with bootstrapping, and flags any reported value it cannot reproduce. Column names should match the item labels in your tables (e.g. SQ1, SQ2…). The data is analysed in memory and not stored.</p>
        </details>
        <details class="more">
          <summary>Journal guidelines, notes & email (optional)</summary>
          <label class="field"><span>Link to the journal's author guidelines <i>fetched automatically</i></span><input type="url" name="guidelines_url" placeholder="https://www.journals.elsevier.com/…/guide-for-authors" autocomplete="off"></label>
          <label class="field"><span>Aims & scope / author guidelines</span><textarea name="journal_guidelines" placeholder="Paste the journal's aims & scope and key submission requirements for a sharper journal-fit check"></textarea></label>
          <label class="field"><span>Anything the reviewers should know?</span><textarea name="author_notes" placeholder="e.g. This is a revised version; data collection was in 2025"></textarea></label>
          <label class="field"><span>Also email the report to</span><input type="email" name="email" placeholder="you@university.edu"></label>
        </details>
        <details class="more" id="privMore">
          <summary>Privacy &amp; storage (optional)</summary>
          <label class="consent"><input type="checkbox" name="private_mode" value="true" id="privateMode"> <span><b>Private mode</b> — the manuscript is read only by an open model (gpt-oss-120b) on Groq with Zero Data Retention: the text is not stored or used for training. Nothing is sent to Gemini, Claude or the originality phrase search (reference and literature look-ups still run, using titles and keywords only). About as fast as a normal review but a little less thorough; scanned PDFs are not supported.</span></label>
          <label class="consent"><input type="checkbox" name="cleanup" value="true" id="cleanupAfter"> <span><b>Delete working files after the review</b> — the stored copy of the manuscript and the server's run data are removed once the report is ready, to keep space free. The report is kept; you can delete it later from the Dashboard.</span></label>
        </details>
        <label class="consent"><input type="checkbox" id="consent"> <span id="consentText">I am authorised to process this manuscript with third-party AI services (Google Gemini, Anthropic Claude). I will not upload manuscripts I received in confidence as a journal reviewer.</span></label>
        <p class="form-error" id="formError" role="alert"></p>
        <button class="btn btn-primary btn-lg" type="submit" id="submitBtn" style="width:100%">Start Q1 review</button>
      </form>
    </section>`;
    const addKey = $('#addKeyBtn'); if (addKey) addKey.addEventListener('click', () => openSettings());
    wireForm();
  }

  function wireForm() {
    const dz = $('#dropzone'), fi = $('#fileInput'), form = $('#submitForm'), err = $('#formError');
    try {
      const rn = $('#reviewerName'); if (rn) rn.value = store.get('reviewerName', '') || '';
      const ps = $('#prevSelect');
      if (ps) {
        history.all().filter(r => r.status === 'complete').slice(0, 40).forEach(r => { const o = document.createElement('option'); o.value = r.id; o.textContent = (r.title || r.id).slice(0, 70) + ' · ' + r.id; ps.appendChild(o); });
        const pm = $('#privateMode'), ct = $('#consentText'), cu = $('#cleanupAfter');
        const syncPriv = () => { ct.textContent = pm.checked ? 'I am authorised to have this manuscript reviewed on the review server (private mode: no third-party AI service reads it). I will not upload manuscripts I received in confidence as a journal reviewer unless the journal allows it.' : 'I am authorised to process this manuscript with third-party AI services (Google Gemini, Anthropic Claude). I will not upload manuscripts I received in confidence as a journal reviewer.'; };
        pm.checked = !!store.get('privateMode', false); cu.checked = !!store.get('cleanupAfter', false);
        if (pm.checked || cu.checked) $('#privMore').open = true;
        pm.addEventListener('change', syncPriv); syncPriv();
        const pre = store.get('prefillPrev', ''); if (pre) { store.del('prefillPrev'); $('#revMore').open = true; if (![...ps.options].some(o => o.value === pre)) { const o = document.createElement('option'); o.value = pre; o.textContent = pre; ps.appendChild(o); } ps.value = pre; }
      }
    } catch (e) { /* optional prefill */ }
    let file = null;
    const setFile = (f) => {
      if (!f) return;
      const ext = (f.name.split('.').pop() || '').toLowerCase();
      if (!['pdf', 'docx', 'txt'].includes(ext)) { err.textContent = 'Please choose a PDF, DOCX or TXT file.'; return; }
      if (f.size > CFG.maxFileMB * 1024 * 1024) { err.textContent = 'File is larger than ' + CFG.maxFileMB + ' MB.'; return; }
      file = f; err.textContent = '';
      dz.classList.add('has-file');
      dz.innerHTML = `<div class="file-chip"><div class="ext">${esc(ext)}</div><div><div class="dz-title">${esc(f.name)}</div><div class="muted" style="font-size:13px">${(f.size / 1024 / 1024).toFixed(2)} MB · click to change</div></div></div>`;
    };
    dz.addEventListener('click', () => fi.click());
    dz.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fi.click(); } });
    fi.addEventListener('change', () => setFile(fi.files[0]));
    ['dragenter', 'dragover'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.add('drag'); }));
    ['dragleave', 'drop'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.remove('drag'); }));
    dz.addEventListener('drop', e => setFile(e.dataTransfer.files[0]));

    wireTargetJournal(form, err);

    form.addEventListener('submit', async (e) => {
      e.preventDefault(); err.textContent = '';
      const s = settings();
      if (!s.key) { openSettings('An access key is required to submit.'); return; }
      const mUrl = ($('#manuscriptUrl') && $('#manuscriptUrl').value.trim()) || '';
      if (!file && !mUrl) { err.textContent = 'Please choose your manuscript file or paste a link to it.'; return; }
      if (!file && !/^https?:\/\//i.test(mUrl)) { err.textContent = 'The manuscript link must start with http:// or https://'; return; }
      const fd = new FormData(form);
      if (!$('#consent').checked) { err.textContent = 'Please confirm the data-processing statement.'; return; }
      fd.append('access_key', s.key);
      if (file) { fd.append('manuscript', file, file.name); fd.delete('manuscript_url'); }
      const prevSel = ($('#prevSelect') && $('#prevSelect').value) || '';
      if (prevSel && !String(fd.get('previous_review_id') || '').trim()) fd.set('previous_review_id', prevSel);
      store.set('reviewerName', String(fd.get('reviewer_name') || ''));
      store.set('privateMode', !!fd.get('private_mode')); store.set('cleanupAfter', !!fd.get('cleanup'));
      const dsf = ($('#datasetInput') && $('#datasetInput').files[0]) || null;
      if (dsf) {
        const dext = (dsf.name.split('.').pop() || '').toLowerCase();
        if (!['csv', 'xlsx', 'xls', 'sav'].includes(dext)) { err.textContent = 'The dataset must be a CSV, XLSX or SAV file.'; return; }
        if (dsf.size > 25 * 1024 * 1024) { err.textContent = 'The dataset is larger than 25 MB.'; return; }
        fd.append('dataset', dsf, dsf.name);
      }
      const btn = $('#submitBtn'); btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Uploading…';
      try {
        const res = await fetch(s.api.replace(/\/$/, '') + CFG.submitPath, { method: 'POST', body: fd });
        const data = await res.json().catch(() => null);
        if (!res.ok || !data || !data.ok) throw new Error((data && data.error) || ('Submission failed (' + res.status + ')'));
        history.upsert({ id: data.review_id, private_mode: !!fd.get('private_mode'), title: fd.get('paper_title') || (file ? file.name : mUrl.split('?')[0].split('/').pop() || 'Linked manuscript'), journal: fd.get('target_journal'), mode: fd.get('review_mode'), submitted_at: new Date().toISOString(), status: 'queued' });
        toast('Submitted — review ' + data.review_id + ' started');
        location.hash = '#/review/' + encodeURIComponent(data.review_id);
      } catch (ex) {
        err.textContent = ex.message === 'Failed to fetch' ? 'Could not reach the review server. Check your connection or the API URL in Settings.' : ex.message;
        btn.disabled = false; btn.textContent = 'Start Q1 review';
      }
    });
  }


  // ---------- Target journal: live status + link to the journal finder ----------
  let tjTimer = null;
  function wireTargetJournal(form, err) {
    const inp = $('#targetJournal'), out = $('#tjChips'), btn = $('#tjFind');
    if (!inp || !out || !btn) return;
    const pick = store.get('jfUseTarget', '');
    if (pick) { store.del('jfUseTarget'); inp.value = pick; }
    const show = async () => {
      const q = inp.value.trim();
      if (q.length < 3) { out.innerHTML = ''; return; }
      try {
        const r = await apiGetJson(CFG.journalLookupPath || '/q1-journal-lookup', { q });
        if (inp.value.trim() !== q) return; // a newer search has started
        const list = arr(r.matches);
        out.innerHTML = !r.ok ? '' : list.length
          ? `<b>${esc(list[0].title)}</b> ${jfChips(list[0])}${list.length > 1 ? ` <span class="muted">· ${list.length - 1} other match${list.length > 2 ? 'es' : ''}</span>` : ''}`
          : 'Not found in the journal lists. You can still submit; the journal will be used as typed.';
      } catch (x) { out.innerHTML = ''; }
    };
    inp.addEventListener('input', () => { clearTimeout(tjTimer); tjTimer = setTimeout(show, 400); });
    if (pick) show();
    btn.addEventListener('click', () => {
      const title = String((form.paper_title && form.paper_title.value) || '').trim();
      if (title.length < 8) { err.textContent = 'Enter the paper title first, then find journals for it.'; if (form.paper_title) form.paper_title.focus(); return; }
      store.set('jfPrefill', { title, abstract: '', keywords: '', field: String((form.field && form.field.value) || ''), target_journal: inp.value.trim(), max_results: 15 });
      location.hash = '#/journals';
    });
  }

  // ---------- CHANGES SINCE PREVIOUS VERSION ----------
  const CHANGE_LABEL = { resolved: ['Resolved', 'ok'], improved: ['Improved', 'ok'], persisting: ['Still open', 'warn'], worsened: ['Worse', 'bad'], new: ['New', 'bad'], not_rechecked: ['Not re-checked', ''] };
  function viewChanges(V) {
    const c = V.counts || {};
    const sb = V.severity_before || {}, sa = V.severity_after || {};
    const items = arr(V.items);
    const row = i => `<tr><td><span class="tag ${CHANGE_LABEL[i.change] ? CHANGE_LABEL[i.change][1] : ''}">${esc((CHANGE_LABEL[i.change] || [i.change])[0])}</span></td>
      <td class="mono">${esc(i.check_id)}</td><td>${esc(i.section || '')}</td>
      <td>${i.before ? `<span class="sev sev-${esc(i.before.severity)}">${esc(i.before.severity)}</span> ${esc(i.before.finding || '')}` : '<span class="muted">—</span>'}</td>
      <td>${i.after ? `<span class="sev sev-${esc(i.after.severity || 'INFO')}">${esc(i.after.severity || i.after.status)}</span> ${esc(i.after.finding || '')}` : '<span class="muted">not checked this time</span>'}</td></tr>`;
    const sevRow = k => `<tr><td>${esc(k[0].toUpperCase() + k.slice(1))}</td><td>${esc(sb[k] || 0)}</td><td>${esc(sa[k] || 0)}</td><td>${(sa[k] || 0) - (sb[k] || 0) > 0 ? '+' : ''}${(sa[k] || 0) - (sb[k] || 0)}</td></tr>`;
    return `
      <div class="card">
        <div class="card-head"><h2>Changes since version ${esc((V.version || 2) - 1)}</h2><a class="btn btn-ghost btn-sm" href="#/review/${encodeURIComponent(V.previous_review_id)}">Open previous review</a></div>
        <p class="muted" style="margin-top:0">Compared with <span class="mono">${esc(V.previous_review_id)}</span>${V.previous_completed_at ? ' (' + esc(fmtDate(V.previous_completed_at)) + ')' : ''}, check by check. A check counts as resolved when this review evaluated it and found no problem.</p>
        <div class="stats">
          <div class="stat"><div class="n" style="color:var(--ok)">${(c.resolved || 0)}</div><div class="l">Resolved</div></div>
          <div class="stat"><div class="n" style="color:var(--ok)">${(c.improved || 0)}</div><div class="l">Improved</div></div>
          <div class="stat verify"><div class="n">${(c.persisting || 0)}</div><div class="l">Still open</div></div>
          <div class="stat critical"><div class="n">${(c.new || 0) + (c.worsened || 0)}</div><div class="l">New or worse</div></div>
          <div class="stat"><div class="n">${(c.not_rechecked || 0)}</div><div class="l">Not re-checked</div></div>
        </div>
        <div class="table-wrap" style="margin-top:14px"><table><thead><tr><th>Severity</th><th>Before</th><th>Now</th><th>Change</th></tr></thead>
          <tbody>${['critical', 'major', 'minor'].map(sevRow).join('')}</tbody></table></div>
      </div>
      <div class="toolbar" id="chgFilter">${['all', 'new', 'worsened', 'persisting', 'improved', 'resolved', 'not_rechecked'].map((k, i) => `<button class="btn btn-sm ${i ? 'btn-ghost' : 'btn-primary'}" data-f="${k}">${k === 'all' ? 'All' : esc(CHANGE_LABEL[k][0])}</button>`).join('')}</div>
      <div class="table-wrap"><table id="chgTable"><thead><tr><th>Change</th><th>Check</th><th>Section</th><th>Before</th><th>Now</th></tr></thead>
        <tbody>${items.map(i => row(i).replace('<tr>', `<tr data-c="${esc(i.change)}">`)).join('') || '<tr><td colspan="5" class="muted">No check-level differences.</td></tr>'}</tbody></table></div>`;
  }
  document.addEventListener('click', e => {
    const b = e.target.closest && e.target.closest('#chgFilter button'); if (!b) return;
    $$('#chgFilter button').forEach(x => { x.classList.toggle('btn-primary', x === b); x.classList.toggle('btn-ghost', x !== b); });
    $$('#chgTable tbody tr[data-c]').forEach(tr => { tr.hidden = b.dataset.f !== 'all' && tr.dataset.c !== b.dataset.f; });
  });

  // ---------- DASHBOARD ----------
  const setMe = me => { try { store.set('me', me || null); const a = $('#adminNav'); if (a) a.hidden = !(me && me.role === 'admin'); } catch (e) { /* ignore */ } };
  async function refreshMe() { if (!settings().key) return setMe(null); try { const d = await apiGetJson('/q1-review-dashboard', { scope: 'mine' }); setMe(d.me); } catch (e) { /* offline or bad key */ } }
  async function renderDashboard() {
    if (!settings().key) { app.innerHTML = '<div class="card empty">Add your access key in Settings to see your dashboard.</div>'; return; }
    const me0 = store.get('me', null);
    const scope = store.get('dashScope', 'all');
    app.innerHTML = '<div class="card empty"><span class="spinner"></span> Loading dashboard…</div>';
    let d;
    try { d = await apiGetJson('/q1-review-dashboard', { scope }); } catch (e) { app.innerHTML = `<div class="card empty">Could not load the dashboard: ${esc(e.message)}</div>`; return; }
    setMe(d.me);
    const isAdmin = d.me && d.me.role === 'admin';
    const t = d.totals || {};
    const groups = {};
    arr(d.reviews).forEach(r => { (groups[r.manuscript_id] = groups[r.manuscript_id] || []).push(r); });
    const glist = Object.values(groups).map(g => g.sort((a, b) => (b.version || 1) - (a.version || 1)));
    glist.sort((a, b) => String(b[0].submitted_at).localeCompare(String(a[0].submitted_at)));
    const sevMini = sc => sc ? `<span class="sev sev-CRITICAL" title="Critical">${sc.critical || 0}</span> <span class="sev sev-MAJOR" title="Major">${sc.major || 0}</span> <span class="sev sev-MINOR" title="Minor">${sc.minor || 0}</span>` : '';
    const stTag = r => r.status === 'complete' ? `<span class="tag ok">${esc(READINESS[r.readiness] || 'Complete')}</span>` : r.status === 'failed' ? `<span class="tag bad" title="${esc(r.error)}">Failed</span>` : '<span class="tag warn">In progress</span>';
    const row = (r, first) => `<tr>
      <td>${first ? `<b>${esc(r.title || r.review_id)}</b>` : '<span class="muted">↳ earlier version</span>'}<div class="muted" style="font-size:12px">${esc(r.target_journal)} · ${esc(r.mode)}${r.reviewer_name ? ' · ' + esc(r.reviewer_name) : ''}${isAdmin && r.owner ? ' · key: ' + esc(r.owner) : ''}${r.source && r.source !== 'webapp' ? ' · via ' + esc(r.source) : ''}${r.private_mode ? ' · <span class="tag" title="Reviewed by the private model (Groq, zero data retention)">Private</span>' : ''}${r.cleaned_at ? ' · <span class="muted" title="Manuscript copy and run data deleted">files deleted</span>' : (r.cleanup === 'files' ? ' · <span class="muted">files will be deleted</span>' : '')}</div></td>
      <td><span class="tag">v${esc(r.version)}</span></td>
      <td>${stTag(r)}</td><td>${sevMini(r.severity_counts)}</td>
      <td style="white-space:nowrap">${esc(fmtDate(r.submitted_at))}</td>
      <td style="white-space:nowrap"><a class="btn btn-ghost btn-sm" href="#/review/${encodeURIComponent(r.review_id)}">Open</a>
        ${r.manuscript_link ? `<a class="btn btn-ghost btn-sm" target="_blank" rel="noopener" href="${esc(r.manuscript_link)}">File</a>` : ''}
        ${first && r.status === 'complete' ? `<button class="btn btn-ghost btn-sm" data-rereview="${esc(r.review_id)}">Review revision</button>` : ''}
        ${!r.cleaned_at && r.cleanup !== 'files' ? `<button class="btn btn-ghost btn-sm" data-clean="files" data-id="${esc(r.review_id)}" title="Delete the stored manuscript copy and run data; keep the report">Free space</button>` : ''}
        <button class="btn btn-ghost btn-sm" data-clean="all" data-id="${esc(r.review_id)}" title="Delete this review, its report and all files">Delete</button></td></tr>`;
    app.innerHTML = `
      <div class="card-head" style="margin-bottom:10px"><h1 style="margin:0">Dashboard</h1><a class="btn btn-primary" href="#/">New review</a></div>
      <p class="muted" style="margin-top:-4px">Signed in as <b>${esc((d.me && d.me.name) || '—')}</b>${isAdmin ? ' · admin' : ''}. ${isAdmin ? 'Admins see every review; ' : ''}reviews are grouped by manuscript, newest version first.</p>
      ${isAdmin ? `<div class="toolbar"><button class="btn btn-sm ${scope === 'all' ? 'btn-primary' : 'btn-ghost'}" data-scope="all">All reviews</button><button class="btn btn-sm ${scope === 'mine' ? 'btn-primary' : 'btn-ghost'}" data-scope="mine">Only mine</button><a class="btn btn-sm btn-ghost" href="#/admin">Manage access keys</a></div>` : ''}
      <div class="stats" style="grid-template-columns:repeat(4,1fr)">
        <div class="stat"><div class="n">${t.all || 0}</div><div class="l">Reviews</div></div>
        <div class="stat"><div class="n" style="color:var(--ok)">${t.complete || 0}</div><div class="l">Complete</div></div>
        <div class="stat verify"><div class="n">${t.running || 0}</div><div class="l">In progress</div></div>
        <div class="stat critical"><div class="n">${t.failed || 0}</div><div class="l">Failed</div></div>
      </div>
      ${glist.length ? `<div class="table-wrap" style="margin-top:14px"><table><thead><tr><th>Manuscript</th><th>Version</th><th>Status</th><th>Issues</th><th>Submitted</th><th></th></tr></thead>
        <tbody>${glist.map(g => g.map((r, i) => row(r, i === 0)).join('')).join('')}</tbody></table></div>` : '<div class="card empty" style="margin-top:14px">No reviews yet for this key.</div>'}`;
    $$('[data-scope]').forEach(b => b.addEventListener('click', () => { store.set('dashScope', b.dataset.scope); renderDashboard(); }));
    $$('[data-rereview]').forEach(b => b.addEventListener('click', () => { store.set('prefillPrev', b.dataset.rereview); location.hash = '#/'; }));
    $$('[data-clean]').forEach(b => b.addEventListener('click', async () => {
      const all = b.dataset.clean === 'all';
      if (!confirmInline(b, all ? 'This deletes the review, its report and all files for good.' : 'This deletes the manuscript copy and run data; the report stays.')) return;
      b.disabled = true;
      try { const r = await apiPostForm('/q1-review-cleanup', { review_id: b.dataset.id, scope: all ? 'all' : 'files' }); toast(r.message || 'Done');
        if (all) history.remove(b.dataset.id);
        setTimeout(renderDashboard, 1500);
      } catch (e) { toast(e.message); b.disabled = false; }
    }));
  }

  // ---------- ADMIN: access keys ----------
  async function renderAdmin() {
    if (!settings().key) { app.innerHTML = '<div class="card empty">Add your admin access key in Settings first.</div>'; return; }
    app.innerHTML = '<div class="card empty"><span class="spinner"></span> Loading users…</div>';
    let d;
    try { d = await apiPostForm('/q1-review-admin', { action: 'list' }); } catch (e) { app.innerHTML = `<div class="card empty">${esc(e.message)}</div>`; return; }
    const users = arr(d.users);
    app.innerHTML = `
      <div class="card-head" style="margin-bottom:10px"><h1 style="margin:0">Access keys</h1><a class="btn btn-ghost" href="#/dashboard">Dashboard</a></div>
      <p class="muted" style="margin-top:-4px">Give each co-author or student their own key. They only see their own reviews; admins see everything. Keys are stored hashed — a new key is shown once, so copy it before leaving this page.</p>
      <div id="newKeyBox"></div>
      <form class="card" id="addUser" style="margin-bottom:16px">
        <h2 style="margin-top:0">Add a person</h2>
        <div class="grid-2">
          <label class="field"><span>Name <em>required</em></span><input name="name" required maxlength="120"></label>
          <label class="field"><span>Email <i>optional — Drive-inbox reports go here</i></span><input name="email" type="email" maxlength="160"></label>
          <label class="field"><span>Role</span><select name="role"><option value="user">User — own reviews only</option><option value="admin">Admin — all reviews + this page</option><option value="system">System — e.g. Drive inbox</option></select></label>
          <label class="field"><span>Notes <i>optional</i></span><input name="notes" maxlength="400" placeholder="e.g. PhD student, co-author on paper X"></label>
        </div>
        <button class="btn btn-primary" type="submit">Create key</button>
      </form>
      <div class="table-wrap"><table><thead><tr><th>Name</th><th>Role</th><th>Key ends</th><th>Reviews</th><th>Last used</th><th>Status</th><th></th></tr></thead>
      <tbody>${users.map(u => `<tr${u.active ? '' : ' style="opacity:.55"'}><td><b>${esc(u.name)}</b><div class="muted" style="font-size:12px">${esc(u.email)}${u.notes ? ' · ' + esc(u.notes) : ''}</div></td>
        <td>${esc(u.role)}</td><td class="mono">${esc(u.key_hint)}</td><td>${esc(u.reviews)}</td><td>${u.last_used_at ? esc(fmtDate(u.last_used_at)) : '<span class="muted">never</span>'}</td>
        <td>${u.active ? '<span class="tag ok">Active</span>' : '<span class="tag bad">Revoked</span>'}</td>
        <td style="white-space:nowrap">${d.me && d.me.id === u.id ? '<span class="muted">you</span>' : `<button class="btn btn-ghost btn-sm" data-act="reset_key" data-id="${u.id}">New key</button> <button class="btn btn-ghost btn-sm" data-act="set_active" data-active="${u.active ? 'false' : 'true'}" data-id="${u.id}">${u.active ? 'Revoke' : 'Re-activate'}</button>`}</td></tr>`).join('')}</tbody></table></div>`;
    const showKey = (name, key) => {
      $('#newKeyBox').innerHTML = `<div class="card" style="border-color:var(--ok);margin-bottom:16px"><b>New key for ${esc(name)}</b> — copy it now and send it privately; it will not be shown again.
        <div class="toolbar" style="margin:10px 0 0"><input class="mono" id="newKeyVal" readonly value="${esc(key)}" style="flex:1;min-width:260px"><button class="btn btn-primary btn-sm" id="copyKey" type="button">Copy</button></div></div>`;
      $('#copyKey').addEventListener('click', () => navigator.clipboard.writeText(key).then(() => toast('Key copied'), () => { $('#newKeyVal').select(); toast('Press Ctrl+C to copy'); }));
      window.scrollTo(0, 0);
    };
    $('#addUser').addEventListener('submit', async e => {
      e.preventDefault(); const f = new FormData(e.target);
      try { const r = await apiPostForm('/q1-review-admin', { action: 'create', name: f.get('name'), email: f.get('email'), role: f.get('role'), notes: f.get('notes') });
        await renderAdmin(); if (r.new_key) showKey(r.user ? r.user.name : f.get('name'), r.new_key); } catch (err) { toast(err.message); }
    });
    $$('[data-act]').forEach(b => b.addEventListener('click', async () => {
      const act = b.dataset.act;
      if (act === 'reset_key' && !confirmInline(b, 'Old key stops working. Continue?')) return;
      try { const r = await apiPostForm('/q1-review-admin', { action: act, user_id: b.dataset.id, active: b.dataset.active || '' });
        await renderAdmin(); if (r.new_key) showKey(r.user ? r.user.name : 'user', r.new_key); else toast('Saved'); } catch (err) { toast(err.message); }
    }));
  }
  function confirmInline(btn, msg) { if (btn.dataset.armed) return true; btn.dataset.armed = '1'; const t = btn.textContent; btn.textContent = 'Click again to confirm'; toast(msg); setTimeout(() => { delete btn.dataset.armed; btn.textContent = t; }, 4000); return false; }

  // ---------- MY REVIEWS ----------
  function renderReviews() {
    const list = history.all();
    app.innerHTML = `
      <div class="card-head" style="margin-bottom:18px"><h1 style="margin:0">My reviews</h1><a class="btn btn-primary" href="#/">New review</a></div>
      <p class="muted" style="margin-top:-6px">Stored in this browser only. Open a review from another device with its ID.</p>
      <form class="toolbar" id="openForm"><input type="search" id="openId" placeholder="Open by review ID, e.g. REV-20260924-AB12C" aria-label="Review ID"><button class="btn btn-ghost btn-sm" type="submit">Open</button></form>
      ${list.length ? '<div class="review-list">' + list.map(r => `
        <a class="review-row" href="#/review/${encodeURIComponent(r.id)}">
          <div><div class="t">${esc(r.title || r.id)}</div><div class="s">${esc(r.journal || '')} · ${esc(r.mode || '')} · ${esc(fmtDate(r.submitted_at))} · <span class="mono">${esc(r.id)}</span></div></div>
          <div>${statusTag(r.status, r.readiness)}</div>
        </a>`).join('') + '</div>' : '<div class="card empty">No reviews yet. <a href="#/">Start your first review</a> or look at the <a href="#/demo">sample report</a>.</div>'}`;
    $('#openForm').addEventListener('submit', e => { e.preventDefault(); const v = $('#openId').value.trim(); if (v) location.hash = '#/review/' + encodeURIComponent(v); });
  }
  function statusTag(status, readiness) {
    if (status === 'complete') return `<span class="tag ok">${esc(READINESS[readiness] || 'Complete')}</span>`;
    if (status === 'failed') return '<span class="tag bad">Failed</span>';
    return '<span class="tag warn">In progress</span>';
  }

  // ---------- REVIEW (progress → report) ----------
  function renderReview(id) {
    const cached = store.get('result:' + id, null);
    if (cached) { renderReport(cached, { id }); return; }
    if (!settings().key) {
      app.innerHTML = `<div class="card progress-wrap"><h2>Access key needed</h2><p>Add your access key in Settings to load review <span class="mono">${esc(id)}</span>.</p><button class="btn btn-primary" id="k">Open settings</button></div>`;
      $('#k').addEventListener('click', () => openSettings()); return;
    }
    const entry = history.all().find(r => r.id === id) || {};
    const origOnly = entry.mode === 'ORIGINALITY';
    curStages = origOnly ? STAGES_ORIG : STAGES;
    app.innerHTML = `
      <div class="card progress-wrap" id="progressCard">
        <div class="eyebrow">${origOnly ? 'Originality check in progress' : 'Review in progress'}</div>
        <h2 id="pTitle">${esc(entry.title || id)}</h2>
        <p class="muted" style="margin:0">${esc(entry.journal || '')}${entry.journal ? ' · ' : ''}<span class="mono">${esc(id)}</span></p>
        <div class="bar"><div id="pBar" style="width:3%"></div></div>
        <p class="status-msg" id="pMsg">Connecting…</p>
        <ol class="steps" id="pSteps"></ol>
        <p class="progress-note" style="margin-top:18px">${origOnly ? 'An originality check usually takes 2–4 minutes.' : 'A full review usually takes 10–20 minutes.'} You can close this tab — the review keeps running, and it will be in <a href="#/reviews">My reviews</a> when you return.</p>
      </div>`;
    let notFound = 0;
    const tick = async () => {
      try {
        const st = await apiStatus(id, false);
        if (!st.found) {
          notFound++;
          $('#pMsg').textContent = notFound > 15 ? 'This review ID was not found. Check the ID, or the submission may have failed before starting.' : 'Waiting for the review engine to register the submission…';
          drawSteps('received', 3);
        } else {
          history.upsert({ id, title: entry.title || st.paper_title || id, journal: entry.journal || st.target_journal, status: st.status });
          $('#pTitle').textContent = entry.title || st.paper_title || id;
          if (st.status === 'failed') {
            $('#pBar').style.width = '100%'; $('#pBar').style.background = 'var(--critical)';
            $('#pMsg').innerHTML = `<div class="status-failed"><b>The review stopped.</b> ${esc(st.message || '')}<br><small>Check the execution log in n8n, fix the cause, and submit again.</small></div>`;
            drawSteps(st.stage, st.progress, true); return;
          }
          $('#pBar').style.width = Math.max(3, Number(st.progress) || 3) + '%';
          $('#pMsg').textContent = st.message || 'Working…';
          drawSteps(st.stage, st.progress);
          if (st.status === 'complete') {
            $('#pMsg').innerHTML = '<span class="spinner"></span> Loading report…';
            const full = await apiStatus(id, true);
            if (full.result) {
              cacheResult(id, full.result);
              history.upsert({ id, status: 'complete', readiness: (full.result.synthesis || {}).submission_readiness, title: full.result.meta && full.result.meta.title });
              renderReport(full.result, { id }); return;
            }
            $('#pMsg').textContent = full.result_error || 'The review finished but no result was stored.'; return;
          }
        }
      } catch (e) {
        $('#pMsg').textContent = 'Connection problem: ' + e.message + ' — retrying…';
      }
      pollTimer = setTimeout(tick, (CFG.pollSeconds || 12) * 1000);
    };
    drawSteps('received', 3);
    tick();
  }
  function drawSteps(stage, progress, failed) {
    const idx = Math.max(0, curStages.findIndex(s => s[0] === stage));
    const cur = stage === 'error' ? curStages.findIndex(s => s[2] > (progress || 0)) : idx;
    $('#pSteps').innerHTML = curStages.map((s, i) => {
      const cls = i < cur || (s[0] === 'done' && stage === 'done') ? 'done' : (i === cur && !failed ? 'current' : '');
      return `<li class="${cls}"><span class="dot">${cls === 'done' ? '✓' : ''}</span><span>${esc(s[1])}</span></li>`;
    }).join('');
  }

  // ---------- DEMO ----------
  async function renderDemo() {
    app.innerHTML = '<p class="muted"><span class="spinner"></span> Loading sample report…</p>';
    try {
      const res = await fetch('sample-result.json', { cache: 'no-store' });
      const data = await res.json();
      renderReport(data, { demo: true, id: 'sample' });
    } catch (e) { app.innerHTML = '<div class="card">Could not load the sample report.</div>'; }
  }

  // ---------- REPORT ----------
  function renderReport(R, opts) {
    const id = opts.id;
    if ((R.meta || {}).mode === 'ORIGINALITY') return renderOriginalityReport(R, opts);
    const S = R.synthesis || {};
    const M = R.meta || {};
    const sev = R.severity_counts || {};
    const adj = arr(R.adjudicated);
    const findings = arr(R.findings);
    const readiness = S.submission_readiness || 'UNDETERMINED';
    const actionable = adj.filter(a => a.decision !== 'DISMISSED');
    const tabs = [
      ['overview', 'Overview'], ['comments', 'Comments', arr(S.major_comments).length + arr(S.minor_comments).length],
      ['findings', 'Validate findings', actionable.length], ['audits', 'Consistency audits'], ['references', 'References', (R.references && R.references.summary && R.references.summary.checked) || 0],
      ['journals', 'Best-fit journals', R.journal_fit && R.journal_fit.ok ? arr(R.journal_fit.journals).length : undefined], ['roadmap', 'Revision roadmap'], ['litreview', 'Literature review'], ['letter', 'Reviewer letter'], ['checks', 'All checks', findings.length]
    ];
    if (R.integrity) tabs.splice(5, 0, ['originality', 'Originality & AI']);
    tabs.splice(3, 0, ['final', 'Final report']);
    if (R.literature) tabs.splice(tabs.findIndex(t => t[0] === 'references') + 1, 0, ['literature', 'Literature & novelty']);
    if (R.modules) tabs.splice(tabs.findIndex(t => t[0] === 'references'), 0, ['stats', 'Statistics & tables']);
    if (R.inventory && arr(R.inventory.hypotheses).length) tabs.splice(tabs.findIndex(t => t[0] === 'references'), 0, ['evidence', 'Evidence map']);
    const V = R.version || null;
    if (V && V.previous_review_id && V.counts) tabs.splice(1, 0, ['changes', 'Changes since v' + ((V.version || 2) - 1), (V.counts.resolved || 0) + (V.counts.improved || 0)]);
    app.innerHTML = `
      ${opts.demo ? '<div class="draft-banner"><b>Sample report</b> for a fictional manuscript — this is what you receive for your own paper.</div>' : '<div class="draft-banner"><b>AI-assisted draft.</b> Treat every finding as decision support: confirm, modify or reject it in <i>Validate findings</i> before revising.</div>'}
      ${arr(R.pipeline_warnings).length ? `<div class="warnings"><b>Pipeline warnings:</b> ${arr(R.pipeline_warnings).map(esc).join(' · ')}</div>` : ''}
      <div class="report-head">
        <div>
          <div class="eyebrow">Q1 pre-submission review</div>
          <h1>${esc(M.title || id)}</h1>
          <div class="report-meta">
            <span>Target: <b>${esc(M.target_journal || '—')}</b></span><span>${esc(M.article_type || '')}</span>
            <span>Mode: ${esc(M.mode || '')}</span><span>${esc(M.word_count || '?')} words${M.ocr_used ? ' · OCR' : ''}</span>
            <span class="mono">${esc(R.review_id || id)}</span><span>${esc(fmtDate(R.generated_at))}</span>${V && V.version > 1 ? `<span class="tag">Version ${esc(V.version)}</span>` : ''}${M.reviewer_name ? `<span>Reviewer: ${esc(M.reviewer_name)}</span>` : ''}${M.private_mode ? '<span class="tag" title="Reviewed by gpt-oss-120b on Groq with zero data retention; no manuscript text was sent to Gemini or Claude">Private mode</span>' : ''}
          </div>
        </div>
        <div class="report-actions">
          ${R.links && R.links.report_doc ? `<a class="btn btn-ghost btn-sm" target="_blank" rel="noopener" href="${esc(R.links.report_doc)}">Google Doc</a>` : ''}
          ${R.links && R.links.evidence_sheet ? `<a class="btn btn-ghost btn-sm" target="_blank" rel="noopener" href="${esc(R.links.evidence_sheet)}">Evidence sheet</a>` : ''}
          <button class="btn btn-ghost btn-sm" id="exportCsv">Export validations</button>
          <button class="btn btn-ghost btn-sm" id="exportJson">Download JSON</button>
          <button class="btn btn-ghost btn-sm" id="printBtn">Print / PDF</button>
          ${opts.demo ? '' : '<button class="btn btn-ghost btn-sm" id="refreshBtn" title="Reload the result from the server">Refresh</button>'}
        </div>
      </div>
      <nav class="tabs" role="tablist">${tabs.map((t, i) => `<button role="tab" data-tab="${t[0]}" class="${i === 0 ? 'active' : ''}" aria-selected="${i === 0}">${esc(t[1])}${t[2] !== undefined ? `<span class="count">${t[2]}</span>` : ''}</button>`).join('')}</nav>
      <section class="tab-panel" data-panel="overview">${viewOverview(R, S, sev, readiness)}</section>
      ${V && V.previous_review_id && V.counts ? `<section class="tab-panel" data-panel="changes" hidden>${viewChanges(V)}</section>` : ''}
      <section class="tab-panel" data-panel="comments" hidden>${viewComments(S)}</section>
      <section class="tab-panel" data-panel="findings" hidden>${viewFindingsShell(actionable)}</section>
      <section class="tab-panel" data-panel="final" hidden>${viewFinal(!!opts.demo)}</section>
      <section class="tab-panel" data-panel="audits" hidden>${viewAudits(R)}</section>
      <section class="tab-panel" data-panel="references" hidden>${viewReferences(R)}</section>
      ${R.literature ? `<section class="tab-panel" data-panel="literature" hidden>${viewLiterature(R.literature)}</section>` : ''}
      ${R.modules ? `<section class="tab-panel" data-panel="stats" hidden>${viewModules(R.modules, R)}</section>` : ''}
      ${R.inventory && arr(R.inventory.hypotheses).length ? `<section class="tab-panel" data-panel="evidence" hidden>${viewEvidenceMap(R)}</section>` : ''}
      ${R.integrity ? `<section class="tab-panel" data-panel="originality" hidden>${viewOriginality(R.integrity)}</section>` : ''}
      <section class="tab-panel" data-panel="journals" hidden>${viewJournalFitTab(R, id)}</section>
      <section class="tab-panel" data-panel="roadmap" hidden>${viewRoadmap(S, id)}</section>
      <section class="tab-panel" data-panel="litreview" hidden>${viewLitReview(R, S, id)}</section>
      <section class="tab-panel" data-panel="letter" hidden>${viewLetter(S)}</section>
      <section class="tab-panel" data-panel="checks" hidden>${viewChecksShell(findings)}</section>`;

    const litForm = $('#litForm'); if (litForm) litForm.addEventListener('submit', ev => runLitReview(ev, id));
    $$('.tabs button').forEach(b => b.addEventListener('click', () => {
      $$('.tabs button').forEach(x => { x.classList.toggle('active', x === b); x.setAttribute('aria-selected', x === b); });
      $$('.tab-panel').forEach(p => { p.hidden = p.dataset.panel !== b.dataset.tab; });
    }));
    wireFindings(actionable, id, !!opts.demo);
    wireFinal(id, actionable, !!opts.demo);
    wireChecks(findings);
    wireRoadmap(id);
    wireJournalFitTab(R, id, !!opts.demo);
    const letterCopy = $('#copyLetter'); if (letterCopy) letterCopy.addEventListener('click', () => { navigator.clipboard.writeText(S.reviewer_letter || '').then(() => toast('Letter copied'), () => toast('Copy failed')); });
    $('#printBtn').addEventListener('click', () => window.print());
    $('#exportJson').addEventListener('click', () => download((R.review_id || id) + '.json', JSON.stringify(R, null, 2), 'application/json'));
    $('#exportCsv').addEventListener('click', () => exportValidations(actionable, id, R));
    const rf = $('#refreshBtn'); if (rf) rf.addEventListener('click', () => { store.del('result:' + id); renderReview(id); });
  }

  function viewOverview(R, S, sev, readiness) {
    const cls = R.classification || {};
    const dims = arr(S.dimension_ratings);
    return `
      <div class="card">
        <div class="readiness">
          <div class="readiness-badge r-${esc(readiness)}"><div class="lbl">Submission readiness</div><div class="val">${esc(READINESS[readiness] || readiness)}</div></div>
          <div><p style="margin:0">${esc(S.readiness_rationale || '')}</p>${S.journal_fit ? `<p class="muted" style="margin:8px 0 0;font-size:14px"><b>Journal fit — ${esc(S.journal_fit.assessment || '')}:</b> ${esc(S.journal_fit.notes || '')}</p>` : ''}</div>
        </div>
        <div class="stats">
          <div class="stat critical"><div class="n">${sev.critical || 0}</div><div class="l">Critical</div></div>
          <div class="stat major"><div class="n">${sev.major || 0}</div><div class="l">Major</div></div>
          <div class="stat minor"><div class="n">${sev.minor || 0}</div><div class="l">Minor</div></div>
          <div class="stat verify"><div class="n">${sev.needs_verification || 0}</div><div class="l">Need your verification</div></div>
          <div class="stat"><div class="n">${R.checklist_size || '—'}</div><div class="l">Checks applied${R.checklist_total ? ' <span class="muted">of ' + esc(R.checklist_total) + ' in library</span>' : ''}</div></div>
        </div>
      </div>
      <div class="card"><h2>Executive assessment</h2>${String(S.executive_assessment || 'Not available.').split(/\n+/).map(p => `<p>${esc(p)}</p>`).join('')}</div>
      <div class="two-col" style="margin-top:18px">
        <div class="card"><div class="card-head"><h3>Diagnostic profile</h3><small>not a publication score</small></div>
          <div class="dims">${dims.length ? dims.map(d => `
            <div class="dim"><span class="name">${esc(d.dimension)}</span><span class="track"><div class="rt-${esc(d.rating)}" style="width:${RATING_W[d.rating] || 8}%"></div></span><span class="rate rt-${esc(d.rating)}">${esc(d.rating)}</span>
            ${d.evidence ? `<span class="ev">${esc(d.evidence)}</span>` : ''}</div>`).join('') : '<p class="muted">No dimension ratings.</p>'}</div>
        </div>
        <div>
          <div class="card"><h3>Study profile</h3>
            <dl class="kv">
              <dt>Study type</dt><dd>${esc(cls.study_type || '—')}</dd><dt>Design</dt><dd>${esc(cls.design || '—')}</dd>
              <dt>Sampling</dt><dd>${esc(cls.sampling || '—')}</dd><dt>Analysis</dt><dd>${esc(arr(cls.analysis).join(', ') || '—')}</dd>
              <dt>Software</dt><dd>${esc(arr(cls.software).join(', ') || '—')}</dd><dt>Reporting guideline</dt><dd>${esc(R.guideline || '—')}</dd>
              <dt>Sample (stated)</dt><dd>${esc(cls.sample_size_reported || '—')}</dd>
            </dl></div>
          ${arr(S.desk_rejection_risks).length ? `<div class="card"><h3>Desk-rejection risks</h3>${arr(S.desk_rejection_risks).map(r => `<div class="comment"><b>${esc(r.risk)}</b><p class="muted" style="margin:4px 0 0;font-size:14px">${esc(r.why)}</p><div class="action"><b>Fix:</b> ${esc(r.fix)}</div></div>`).join('')}</div>` : ''}
        </div>
      </div>
      <div class="two-col" style="margin-top:18px">
        <div class="card"><h3>Major strengths</h3><ul class="clean">${arr(S.major_strengths).map(x => `<li>${esc(x)}</li>`).join('') || '<li class="muted">—</li>'}</ul></div>
        <div class="card"><h3>Major concerns</h3><ul class="clean">${arr(S.major_concerns).map(x => `<li>${esc(x)}</li>`).join('') || '<li class="muted">—</li>'}</ul></div>
      </div>
      ${arr(S.editor_only_concerns).length ? `<div class="card" style="margin-top:18px"><h3>What an editor may privately worry about</h3><ul class="clean">${arr(S.editor_only_concerns).map(x => `<li>${esc(x)}</li>`).join('')}</ul></div>` : ''}
      ${S.assessments ? `<div class="card" style="margin-top:18px"><h3>Specialist assessments</h3><dl class="kv">${['methodological', 'statistical', 'theoretical', 'contribution', 'reproducibility'].filter(k => S.assessments[k]).map(k => `<dt>${k[0].toUpperCase() + k.slice(1)}</dt><dd>${esc(S.assessments[k])}</dd>`).join('')}</dl></div>` : ''}`;
  }

  function viewComments(S) {
    const major = arr(S.major_comments), minor = arr(S.minor_comments), sections = arr(S.section_comments);
    return `
      <div class="card"><div class="card-head"><h2>Major comments</h2><small>${major.length}</small></div>
        ${major.map(c => `<div class="comment"><h3>${esc(c.no)}. ${esc(c.heading)}</h3><p>${esc(c.comment)}</p>
          ${c.evidence ? `<blockquote class="ev">${esc(c.evidence)}</blockquote>` : ''}
          ${c.author_action ? `<div class="action"><b>Author action:</b> ${esc(c.author_action)}</div>` : ''}
          ${arr(c.finding_ids).length ? `<div class="sources">Findings: ${arr(c.finding_ids).map(esc).join(', ')}</div>` : ''}</div>`).join('') || '<p class="muted">None.</p>'}
      </div>
      <div class="card"><div class="card-head"><h2>Minor comments</h2><small>${minor.length}</small></div>
        ${minor.length ? '<ol class="clean">' + minor.map(c => `<li>${esc(c.comment)}${c.location ? ` <span class="muted">(${esc(c.location)})</span>` : ''}${c.author_action ? `<br><span class="muted"><b>Action:</b> ${esc(c.author_action)}</span>` : ''}</li>`).join('') + '</ol>' : '<p class="muted">None.</p>'}
      </div>
      ${sections.length ? `<div class="card"><h2>Section-by-section</h2>${sections.map(s => `<h3 style="margin-top:14px">${esc(s.section)}</h3><ul class="clean">${arr(s.comments).map(c => `<li>${esc(c)}</li>`).join('')}</ul>`).join('')}</div>` : ''}`;
  }

  // ---- findings validation (human-in-the-loop) ----
  const VAL = [['confirm', 'Confirm'], ['modify', 'Modify'], ['reject', 'Reject'], ['evidence', 'Need evidence']];
  function viewFindingsShell(list) {
    const sections = [...new Set(list.map(a => a.section).filter(Boolean))].sort();
    return `
      <div class="card" style="margin-bottom:16px"><p style="margin:0">Every issue below survived adjudication. Decide what to do with each one — your decisions are saved in this browser and on your review server, and they drive the <b>Final report</b>. <span class="muted" id="valProgress"></span> <span class="muted" id="valSync"></span></p></div>
      <div class="toolbar">
        <select id="fSev" aria-label="Severity"><option value="">All severities</option><option>CRITICAL</option><option>MAJOR</option><option>MINOR</option><option>INFO</option></select>
        <select id="fDec" aria-label="Decision"><option value="">All decisions</option><option>CONFIRMED</option><option>NEEDS_VERIFICATION</option><option>DISPUTED</option></select>
        <select id="fSec" aria-label="Section"><option value="">All sections</option>${sections.map(s => `<option>${esc(s)}</option>`).join('')}</select>
        <select id="fVal" aria-label="Your decision"><option value="">Any validation</option><option value="none">Not yet validated</option>${VAL.map(v => `<option value="${v[0]}">${v[1]}</option>`).join('')}</select>
        <input type="search" id="fQ" placeholder="Search findings…" aria-label="Search">
      </div>
      <div id="findingList"></div>`;
  }
  function wireFindings(list, id, demo) {
    const vals = store.get('val:' + id, {});
    const online = !demo && !!settings().key;
    let syncTimer = null;
    const syncNote = t => { const el = $('#valSync'); if (el) el.textContent = t; };
    const push = () => {
      clearTimeout(syncTimer);
      if (!online || !Object.keys(vals).length) return;
      syncNote('Saving…');
      syncTimer = setTimeout(() => {
        apiPostForm(P.validate, { review_id: id, payload: JSON.stringify(vals), reviewer: store.get('reviewer', '') })
          .then(() => syncNote('Saved to server.'))
          .catch(e => syncNote('Not saved to server (' + e.message + ') — kept in this browser.'));
      }, 1200);
    };
    const draw = () => {
      const sv = $('#fSev').value, dv = $('#fDec').value, sc = $('#fSec').value, vv = $('#fVal').value, q = $('#fQ').value.toLowerCase();
      const shown = list.filter(a => (!sv || a.severity === sv) && (!dv || a.decision === dv) && (!sc || a.section === sc)
        && (!vv || (vv === 'none' ? !(vals[a.id] && vals[a.id].v) : vals[a.id] && vals[a.id].v === vv))
        && (!q || JSON.stringify(a).toLowerCase().includes(q)));
      $('#findingList').innerHTML = shown.map(a => {
        const v = vals[a.id] || {};
        return `<article class="finding ${v.v ? 'v-' + v.v : ''}" data-id="${esc(a.id)}">
          <div class="finding-top"><span class="id">${esc(a.id)}</span><span class="sev sev-${esc(a.severity)}">${esc(a.severity)}</span>
            <span class="tag ${a.decision === 'CONFIRMED' ? 'ok' : 'warn'}">${esc(a.decision)}</span>${a.section ? `<span class="tag">${esc(a.section)}</span>` : ''}
            ${a.priority ? `<span class="tag">${esc(String(a.priority).replace(/_/g, ' '))}</span>` : ''}
            ${a.evidence_verified ? '<span class="tag ok" title="Quote matched in manuscript">✓ evidence verified</span>' : '<span class="tag bad">no verified quote</span>'}</div>
          <h3>${esc(a.title)}</h3><p>${esc(a.finding)}</p>
          ${arr(a.evidence).map(e => `<blockquote class="ev"><span class="loc">${esc(e.location || '')}</span>${esc(e.quote)}</blockquote>`).join('')}
          ${a.author_action ? `<div class="comment" style="padding:0;border:0"><div class="action"><b>Suggested action:</b> ${esc(a.author_action)}</div></div>` : ''}
          ${a.rationale ? `<p class="sources">Adjudication: ${esc(a.rationale)}</p>` : ''}
          <div class="sources">Raised by: ${arr(a.sources).map(s => esc(s.reviewer + ' (' + s.check_id + ')')).join('; ') || '—'}</div>
          <div class="validate" role="group" aria-label="Your decision">
            ${VAL.map(x => `<button type="button" class="${x[0]}" data-v="${x[0]}" aria-pressed="${v.v === x[0]}">${x[1]}</button>`).join('')}
            <textarea placeholder="Your note (optional)" data-note>${esc(v.note || '')}</textarea>
          </div></article>`;
      }).join('') || '<div class="card empty">No findings match these filters.</div>';
      const done = list.filter(a => vals[a.id] && vals[a.id].v).length;
      $('#valProgress').textContent = `${done} of ${list.length} validated.`;
    };
    ['#fSev', '#fDec', '#fSec', '#fVal'].forEach(s => $(s).addEventListener('change', draw));
    $('#fQ').addEventListener('input', draw);
    $('#findingList').addEventListener('click', e => {
      const b = e.target.closest('button[data-v]'); if (!b) return;
      const fid = b.closest('.finding').dataset.id; const cur = vals[fid] || {};
      cur.v = cur.v === b.dataset.v ? '' : b.dataset.v; cur.at = new Date().toISOString(); vals[fid] = cur;
      store.set('val:' + id, vals); draw(); push();
    });
    $('#findingList').addEventListener('change', e => {
      if (!e.target.matches('[data-note]')) return;
      const fid = e.target.closest('.finding').dataset.id; vals[fid] = Object.assign(vals[fid] || {}, { note: e.target.value, at: new Date().toISOString() });
      store.set('val:' + id, vals); push();
    });
    draw();
    if (online) {
      apiGetJson(P.validations, { id }).then(d => {
        const sv = (d && d.validations) || {};
        let changed = false;
        Object.keys(sv).forEach(k => {
          const a = sv[k], b = vals[k];
          if (!b || (a.at && (!b.at || a.at > b.at))) { vals[k] = { v: a.v || '', note: a.note || '', at: a.at || '' }; changed = true; }
        });
        if (changed) { store.set('val:' + id, vals); draw(); }
        const localNewer = Object.keys(vals).some(k => !sv[k] || (vals[k].at || '') > (sv[k].at || ''));
        if (localNewer) push(); else syncNote(Object.keys(sv).length ? 'Synced with server.' : '');
      }).catch(() => syncNote('Server sync unavailable — decisions kept in this browser.'));
    }
  }

  // ---- final human-validated report ----
  function viewFinal(demo) {
    return `
      <div class="card"><h2>Final human-validated report</h2>
        <p>When you have worked through <b>Validate findings</b>, generate the final documents. Rejected findings are removed, modified findings follow your note, and “Need evidence” findings become questions to the authors. Findings you have not validated stay in and are marked as not validated.</p>
        <p class="muted" style="font-size:14px">You get a Final Reviewer Report, a confidential Editor Report and an Author Revision Roadmap (each as DOCX and PDF), the Evidence Matrix (XLSX) and an audit file. The documents are saved in the review engine’s Google Drive, so the download links work when you are signed in to that Google account. It takes about 2–4 minutes.</p>
        ${demo ? '<p class="muted"><i>Available for your own reviews, not for the sample.</i></p>' : `
        <div class="final-form">
          <label class="field"><span>Validated by <i>optional, printed on the report</i></span><input type="text" id="finReviewer" maxlength="120" placeholder="Your name"></label>
          <button class="btn btn-primary" id="finBtn" type="button">Generate final report</button>
        </div>
        <p id="finProgress" class="muted" style="margin:10px 0 0"></p>`}
      </div>
      <div id="finOut"></div>`;
  }
  function finalLinks(L) {
    const row = (name, desc, o, fmts) => o ? `<div class="final-doc"><div><b>${esc(name)}</b><span class="muted">${esc(desc)}</span></div><div class="final-btns">${fmts.map(f => o[f[0]] ? `<a class="btn btn-ghost btn-sm" target="_blank" rel="noopener" href="${esc(o[f[0]])}">${esc(f[1])}</a>` : '').join('')}</div></div>` : '';
    const docF = [['docx', 'DOCX'], ['pdf', 'PDF'], ['view', 'Open in Google Docs']];
    return `<div class="card final-docs"><h2>Your final documents</h2>
      ${row('Final Reviewer Report', 'Human-validated comments, evidence matrix and reviewer letter', L.report, docF)}
      ${row('Editor Report', 'Confidential summary, key risks and integrity notes', L.editor, docF)}
      ${row('Revision Roadmap', 'Prioritised checklist for the authors', L.roadmap, docF)}
      ${row('Evidence Matrix', 'Every finding with the AI decision and your decision', L.matrix, [['xlsx', 'XLSX'], ['view', 'Open in Google Sheets']])}
      <div class="final-doc"><div><b>Audit file</b><span class="muted">Your decisions, the final text and any warnings (JSON)</span></div><div class="final-btns"><button class="btn btn-ghost btn-sm" id="finAudit" type="button">Download JSON</button></div></div>
    </div>`;
  }
  function wireFinal(id, list, demo) {
    if (demo || !$('#finBtn')) return;
    const btn = $('#finBtn'), prog = $('#finProgress'), out = $('#finOut'), who = $('#finReviewer');
    who.value = store.get('reviewer', '');
    who.addEventListener('change', () => store.set('reviewer', who.value.trim()));
    let timer = null, started = Date.now();
    const counts = () => { const v = store.get('val:' + id, {}); return list.filter(a => v[a.id] && v[a.id].v).length + ' of ' + list.length + ' findings validated'; };
    const show = d => {
      if (!d || !d.found) { btn.disabled = false; prog.textContent = counts() + '.'; return ''; }
      const age = Date.now() - new Date(d.updated_at || 0).getTime();
      if (d.status === 'running' && age < 20 * 60 * 1000) { btn.disabled = true; prog.innerHTML = '<span class="spinner"></span> ' + esc(d.message || 'Working…'); return 'running'; }
      btn.disabled = false; btn.textContent = 'Regenerate final report';
      const lbl = d.status === 'complete' ? 'Last generated ' : 'Last attempt did not finish ';
      prog.textContent = lbl + fmtDate(d.updated_at) + (d.message && d.status !== 'running' ? ' — ' + d.message : '') + '. ' + counts() + '.';
      out.innerHTML = d.status === 'complete' && d.links ? finalLinks(d.links) : '';
      const au = $('#finAudit');
      if (au) au.addEventListener('click', () => apiGetJson(P.final, { id, include: 'audit' })
        .then(x => download(id + '-final-audit.json', JSON.stringify(x.audit || {}, null, 2), 'application/json')).catch(e => toast(e.message)));
      return d.status;
    };
    const poll = () => {
      clearTimeout(timer);
      if (!document.body.contains(btn)) return;
      apiGetJson(P.final, { id }).then(d => {
        if (show(d) === 'running' && Date.now() - started < 20 * 60 * 1000) timer = setTimeout(poll, 8000);
      }).catch(e => { prog.textContent = e.message; btn.disabled = false; });
    };
    btn.addEventListener('click', () => {
      const reviewer = who.value.trim(); store.set('reviewer', reviewer);
      btn.disabled = true; out.innerHTML = ''; prog.innerHTML = '<span class="spinner"></span> Saving your decisions…';
      const vals = store.get('val:' + id, {});
      const save = Object.keys(vals).length ? apiPostForm(P.validate, { review_id: id, payload: JSON.stringify(vals), reviewer }).catch(() => null) : Promise.resolve();
      save.then(() => apiPostForm(P.finalize, { review_id: id, reviewer }))
        .then(() => { started = Date.now(); prog.innerHTML = '<span class="spinner"></span> Building the final report from your validated findings…'; timer = setTimeout(poll, 5000); })
        .catch(e => { prog.textContent = e.message; btn.disabled = false; });
    });
    if (settings().key) poll(); else prog.textContent = 'Add your access key in Settings to generate the final report.';
  }
  function exportValidations(list, id, R) {
    const vals = store.get('val:' + id, {});
    const head = ['id', 'severity', 'decision', 'section', 'title', 'finding', 'evidence', 'suggested_action', 'your_decision', 'your_note'];
    const rows = list.map(a => [a.id, a.severity, a.decision, a.section, a.title, a.finding, arr(a.evidence).map(e => (e.location || '') + ' ' + e.quote).join(' | '), a.author_action, (vals[a.id] || {}).v || '', (vals[a.id] || {}).note || '']);
    download((R.review_id || id) + '-validated-findings.csv', [head, ...rows].map(r => r.map(csvCell).join(',')).join('\n'), 'text/csv');
  }

  function yn(v) { const s = String(v || ''); const c = /^yes/i.test(s) ? 'yes' : /^no/i.test(s) ? 'no' : /partial/i.test(s) ? 'partial' : ''; return `<span class="${c}">${esc(s || '—')}</span>`; }
  function table(head, rows) { return rows.length ? `<div class="table-wrap"><table><thead><tr>${head.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>` : '<p class="muted">Nothing reported.</p>'; }
  function viewAudits(R) {
    const cv = R.crossval || {}; const pr = R.presence || {};
    const tac = cv.title_abstract_conclusion || {};
    return `
      <div class="card"><h2>Objective / research-question trace</h2><p class="muted">Does each objective travel through method → result → discussion → conclusion?</p>
        ${table(['ID', 'Objective', 'Method', 'Result', 'Discussed', 'Concluded', 'Issue'], arr(cv.objective_trace).map(o => [esc(o.id), esc(o.objective), yn(o.method), yn(o.result), yn(o.discussed), yn(o.concluded), esc(o.issue)]))}</div>
      <div class="card"><h2>Hypothesis ↔ result audit</h2>
        ${table(['H', 'Predicted', 'Reported', 'p', 'Authors say', 'Audit says', 'Mismatch', 'Note'], arr(cv.hypothesis_audit).map(h => [esc(h.id), esc(h.predicted), esc(h.reported_statistic), esc(h.p_value), yn(h.author_claims_supported), yn(h.audit_supported), h.mismatch ? '<span class="no">Yes</span>' : '<span class="muted">No</span>', esc(h.note)]))}</div>
      <div class="card"><h2>Number consistency</h2>
        ${table(['Entity', 'Values found', 'Consistent', 'Explanation', 'Severity'], arr(cv.number_consistency).map(n => [esc(n.entity), esc(arr(n.values_found).map(v => v.value + (v.location ? ' ' + v.location : '')).join('; ')), n.consistent ? '<span class="yes">Yes</span>' : '<span class="no">No</span>', esc(n.explanation), n.severity ? `<span class="sev sev-${esc(n.severity)}">${esc(n.severity)}</span>` : '']))}</div>
      <div class="two-col" style="margin-top:18px">
        <div class="card"><h3>Table ↔ text mismatches</h3>${table(['Table', 'Table value', 'Text value', 'Location'], arr(cv.table_text_mismatches).map(t => [esc(t.table), esc(t.table_value), esc(t.text_value), esc(t.location)]))}</div>
        <div class="card"><h3>Contradictions between sections</h3>${arr(cv.contradictions).length ? arr(cv.contradictions).map(c => `<div class="comment"><span class="sev sev-${esc(c.severity)}">${esc(c.severity)}</span> ${esc(c.description)}<div class="sources">${esc(arr(c.locations).join(', '))}</div></div>`).join('') : '<p class="muted">None found.</p>'}</div>
      </div>
      <div class="card" style="margin-top:18px"><h2>Causal language vs. study design</h2>
        ${table(['Quote', 'Location', 'Why it overreaches', 'Suggested rewrite'], arr(cv.causal_overclaims).map(c => [`<i>${esc(c.quote)}</i>`, esc(c.location), esc(c.design_limitation), esc(c.suggested_rewrite)]))}</div>
      <div class="two-col" style="margin-top:18px">
        <div class="card"><h3>Title · abstract · conclusion alignment</h3><p>${tac.consistent === false ? '<span class="no">Inconsistent</span>' : tac.consistent ? '<span class="yes">Consistent</span>' : '—'}</p><ul class="clean">${arr(tac.issues).filter(Boolean).map(i => `<li>${esc(i)}</li>`).join('')}</ul>
          <h3 style="margin-top:14px">Conceptual model alignment</h3><p>${cv.model_alignment && cv.model_alignment.consistent === false ? '<span class="no">Inconsistent</span>' : cv.model_alignment && cv.model_alignment.consistent ? '<span class="yes">Consistent</span>' : '—'}</p><ul class="clean">${arr(cv.model_alignment && cv.model_alignment.issues).filter(Boolean).map(i => `<li>${esc(i)}</li>`).join('')}</ul></div>
        <div class="card"><h3>Reporting presence checks</h3><p class="muted" style="font-size:13px">Rule-based scan of the manuscript text.</p>
          <div class="table-wrap"><table><tbody>${Object.keys(pr).map(k => `<tr><td>${esc(k.replace(/_/g, ' '))}</td><td>${pr[k] ? '<span class="yes">Found</span>' : '<span class="no">Not found</span>'}</td></tr>`).join('')}</tbody></table></div></div>
      </div>`;
  }

  function viewReferences(R) {
    const ref = R.references || {}; const s = ref.summary || {}; const results = arr(ref.results);
    const tone = st => st === 'VERIFIED' ? 'ok' : st === 'RETRACTED' ? 'bad' : st === 'LOOKUP_FAILED' ? '' : 'warn';
    const recency = s.recency || {};
    return `
      <div class="card">
        <div class="stats">
          <div class="stat"><div class="n">${s.checked || 0}</div><div class="l">Checked of ${s.total_in_manuscript || 0}</div></div>
          <div class="stat"><div class="n" style="color:var(--ok)">${s.verified || 0}</div><div class="l">Verified</div></div>
          <div class="stat verify"><div class="n">${(s.mismatches || 0) + (s.not_found || 0)}</div><div class="l">Mismatch / not found</div></div>
          <div class="stat critical"><div class="n">${s.retracted || 0}</div><div class="l">Retracted</div></div>
          <div class="stat"><div class="n">${s.dois_missing_but_available || 0}</div><div class="l">Missing DOIs</div></div>
        </div>
        ${recency.median_year ? `<p class="muted" style="margin:10px 0 0">Recency: ${esc(recency.share_last_5_years)} from the last 5 years · ${esc(recency.share_older_than_15_years)} older than 15 years · median year ${esc(recency.median_year)}.</p>` : ''}
        ${arr(s.possible_prior_publication).length ? `<div class="warnings" style="margin:14px 0 0"><b>Title-similarity check:</b> ${arr(s.possible_prior_publication).map(w => esc(w.title + ' (' + w.year + ') doi:' + w.doi)).join('; ')} — if this is your own preprint, disclose it in the cover letter.</div>` : ''}
      </div>
      <div class="card"><div class="toolbar"><select id="refFilter"><option value="problems">Problems only</option><option value="all">All checked references</option></select></div>
        <div id="refTable"></div></div>`
      + `<script type="application/json" id="refData">${esc(JSON.stringify(results.map(r => Object.assign({}, r, { tone: tone(r.status) }))))}</script>`;
  }

  // ---- literature, novelty & citation accuracy (OpenAlex) ----
  // ---- evidence map (Phase E): theory -> hypothesis -> measures -> result -> conclusion; objectives; claim -> evidence -> source ----
  function buildEvidenceGraph(R) {
    const inv = R.inventory || {}, cv = R.crossval || {}, M = R.modules || {}, LT = R.literature || {};
    const low = s => String(s || '').toLowerCase();
    const words = s => low(s).replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(w => w.length > 3 && !['hospital', 'with', 'from', 'that', 'this', 'their', 'positively', 'negatively', 'influences', 'relationship', 'between', 'mediates', 'moderates'].includes(w));
    const theories = arr(inv.theories), hyps = arr(inv.hypotheses), constructs = arr(inv.constructs);
    const audit = arr(cv.hypothesis_audit), contra = arr(cv.contradictions), over = arr(cv.causal_overclaims);
    const detF = arr((M.deterministic || {}).findings), align = cv.model_alignment || {};
    const alignIssues = arr(align.issues).map(String);
    const theoryWeak = alignIssues.filter(i => /theor|framework/i.test(i));
    const breaks = [];
    const brk = (where, level, text) => { breaks.push({ where, level, text }); return level; };
    const cStatus = {};
    constructs.forEach(c => {
      const n = low(c.name), hits = detF.filter(f => /^TBL-(AVE|CR|LOADING|HTMT|FL|ALPHA|VIF)/.test(f.check_id || '') && (low(f.finding).includes(n) || low(f.finding).includes(n.replace(/^hospital /, ''))));
      const orphan = alignIssues.filter(i => { if (!/orphan|no path|not connected|omitted/i.test(i)) return false; const pos = constructs.map(x => ({ x, p: low(i).indexOf(low(x.name).replace(/^hospital /, '')) })).filter(o => o.p >= 0).sort((u, v) => u.p - v.p); return pos.length && pos[0].x === c; });
      const lvl = hits.some(f => f.severity === 'MAJOR' || f.severity === 'CRITICAL') ? 'bad' : (hits.length || orphan.length || !c.measurement_source) ? 'warn' : 'ok';
      cStatus[c.name] = { level: lvl, notes: [...hits.map(f => f.finding), ...orphan, !c.measurement_source ? 'No measurement source given.' : ''].filter(Boolean) };
    });
    const rows = hyps.map(h => {
      const hid = String(h.id || '').trim();
      const hw = new Set(words(h.statement));
      const cs = constructs.filter(c => words(c.name).some(w => hw.has(w)));
      const a = audit.find(x => String(x.id || x.hypothesis || '').trim().toUpperCase() === hid.toUpperCase());
      const hRe = new RegExp('\\b' + hid.replace(/[^A-Za-z0-9]/g, '') + '\\b', 'i');
      const statIssues = detF.filter(f => hRe.test(f.finding));
      const cont = contra.filter(c => hRe.test(c.description || '') || arr(c.quotes).some(q => hRe.test(q)));
      // theory -> hypothesis
      let tLink = theories.length ? (theoryWeak.length ? 'warn' : 'ok') : 'bad';
      if (tLink === 'bad') brk(hid, 'bad', hid + ': no theory is named to derive this hypothesis from.');
      else if (tLink === 'warn') brk(hid, 'warn', hid + ': the theory is named but not used to develop the hypothesis (' + theoryWeak[0] + ')');
      // hypothesis -> measures
      let mLink = !cs.length ? 'warn' : cs.some(c => (cStatus[c.name] || {}).level === 'bad') ? 'bad' : cs.some(c => (cStatus[c.name] || {}).level === 'warn') ? 'warn' : 'ok';
      if (!cs.length) brk(hid, 'warn', hid + ': the constructs in this hypothesis could not be matched to measured constructs.');
      else if (mLink === 'bad') brk(hid, 'bad', hid + ': a construct in this hypothesis fails measurement quality (' + cs.filter(c => cStatus[c.name].level === 'bad').map(c => c.name).join(', ') + ').');
      // measures -> result
      let rLink, resultTxt = '', resLevel;
      if (!a) { rLink = 'bad'; resLevel = 'bad'; resultTxt = 'No result reported'; brk(hid, 'bad', hid + ': no test statistic reported for this hypothesis.'); }
      else {
        resultTxt = [a.reported_statistic, a.p_value ? 'p ' + (/^[<>=]/.test(String(a.p_value).trim()) ? '' : '= ') + a.p_value : '', a.ci ? 'CI ' + a.ci : ''].filter(Boolean).join(', ');
        const auditSup = low(a.audit_supported);
        resLevel = statIssues.some(f => f.severity === 'MAJOR' || f.severity === 'CRITICAL') ? 'bad' : auditSup.startsWith('yes') ? 'ok' : auditSup.startsWith('no') ? 'warn' : 'warn';
        rLink = statIssues.length ? 'bad' : 'ok';
        statIssues.forEach(f => brk(hid, 'bad', f.finding));
      }
      // result -> conclusion
      const claimSup = low(a && a.author_claims_supported), auditSup = low(a && a.audit_supported);
      let cLink = 'ok';
      if (a && (a.mismatch || (claimSup.startsWith('yes') && !auditSup.startsWith('yes')))) { cLink = 'bad'; brk(hid, 'bad', hid + ': the paper concludes "supported" but the reported result does not support it' + (a.note ? ' (' + a.note + ')' : '') + '.'); }
      else if (cont.length) { cLink = 'bad'; cont.forEach(c => brk(hid, 'bad', c.description)); }
      const conclusion = a ? (claimSup.startsWith('yes') ? 'Reported as supported' : claimSup.startsWith('no') ? 'Reported as not supported' : 'Author conclusion unclear') : 'Not concluded';
      return { id: hid, statement: h.statement, constructs: cs.map(c => ({ name: c.name, level: (cStatus[c.name] || {}).level || 'ok' })), result: resultTxt, resLevel, conclusion,
        links: [tLink, mLink, rLink, cLink] };
    });
    if (over.length) brk('Design', 'bad', over.length + ' conclusion(s) use causal language that the design cannot support: "' + String(over[0].quote || '').slice(0, 140) + '"');
    const objectives = arr(cv.objective_trace).map(o => ({ id: o.id, text: o.objective, steps: ['method', 'result', 'discussed', 'concluded'].map(k => ({ k, v: String(o[k] || '') })), issue: o.issue || '' }));
    objectives.forEach(o => { const miss = o.steps.filter(s => /^no/i.test(s.v)); if (miss.length) brk(o.id || 'Objective', 'bad', (o.id || 'Objective') + ': not carried through to ' + miss.map(s => s.k).join(', ') + '.'); });
    const claims = [
      ...arr(cv.claim_evidence).map(c => ({ claim: c.claim, evidence: c.evidence, source: 'manuscript results', level: /^yes/i.test(c.supported) ? 'ok' : /^no/i.test(c.supported) ? 'bad' : 'warn', note: c.note || '' })),
      ...arr(LT.citation_checks).map(c => ({ claim: c.claim, evidence: c.explanation, source: (c.citation || '') + ((c.cited_work || {}).title ? ' → ' + c.cited_work.title : ''), level: c.verdict === 'SUPPORTED' ? 'ok' : c.verdict === 'NOT_SUPPORTED' ? 'bad' : 'warn', note: c.verdict === 'CANNOT_VERIFY' ? 'cannot verify from abstract' : '' }))];
    claims.filter(c => c.level === 'bad').forEach(c => brk('Claim', 'bad', 'Claim not supported by its evidence: "' + String(c.claim).slice(0, 140) + '"'));
    return { theories, rows, objectives, claims, breaks, overclaims: over.length, alignIssues };
  }

  function viewEvidenceMap(R) {
    const G = buildEvidenceGraph(R);
    const col = l => l === 'bad' ? 'var(--critical)' : l === 'warn' ? 'var(--warn)' : 'var(--ok)';
    const soft = l => l === 'bad' ? 'var(--critical-soft)' : l === 'warn' ? 'var(--warn-soft)' : 'var(--ok-soft)';
    const node = (title, body, level) => `<div class="em-node" style="border-color:${level ? col(level) : 'var(--line)'};${level && level !== 'ok' ? 'background:' + soft(level) : ''}"><div class="em-t">${title}</div>${body ? `<div class="em-b">${body}</div>` : ''}</div>`;
    const link = l => `<div class="em-link" style="color:${col(l)}" title="${l === 'ok' ? 'link holds' : l === 'warn' ? 'weak link' : 'broken link'}">${l === 'bad' ? '✕' : l === 'warn' ? '⋯' : '→'}</div>`;
    const bad = G.breaks.filter(b => b.level === 'bad'), weak = G.breaks.filter(b => b.level === 'warn');
    const theoryTxt = G.theories.length ? G.theories.map(t => esc(t.name)).join('<br>') : '<span class="no">No theory named</span>';
    const rows = G.rows.map(r => `
      ${node('Theory', theoryTxt, r.links[0] === 'bad' ? 'bad' : '')}${link(r.links[0])}
      ${node(esc(r.id), esc(r.statement))}${link(r.links[1])}
      ${node('Measures', r.constructs.length ? r.constructs.map(c => `<span class="tag ${c.level === 'ok' ? 'ok' : c.level === 'warn' ? 'warn' : 'bad'}" style="margin:2px 2px 0 0">${esc(c.name)}</span>`).join('') : '<span class="muted">not matched</span>', r.constructs.length ? '' : 'warn')}${link(r.links[2])}
      ${node('Result', esc(r.result), r.resLevel)}${link(r.links[3])}
      ${node('Conclusion', esc(r.conclusion), r.links[3] === 'bad' ? 'bad' : '')}`).join('');
    return `
      <div class="card">
        <div class="card-head"><h2>Evidence map</h2><small>theory → hypothesis → measures → result → conclusion</small></div>
        <p class="muted" style="font-size:14px">Each row follows one hypothesis through the paper. <span style="color:var(--ok)">→</span> the link holds, <span style="color:var(--warn)">⋯</span> it is weak, <span style="color:var(--critical)">✕</span> it is broken. Built from the cross-validation, table checks and statistics modules; the problems behind each broken link are already in your findings.</p>
        <div class="stats">
          <div class="stat critical"><div class="n">${bad.length}</div><div class="l">Broken links</div></div>
          <div class="stat verify"><div class="n">${weak.length}</div><div class="l">Weak links</div></div>
          <div class="stat"><div class="n">${G.rows.length}</div><div class="l">Hypotheses traced</div></div>
          <div class="stat"><div class="n">${G.claims.length}</div><div class="l">Claims traced to sources</div></div>
        </div>
        ${G.rows.length ? `<div class="em-scroll"><div class="em-grid">${rows}</div></div>` : '<p class="muted">No hypotheses were found, so the hypothesis chain cannot be drawn.</p>'}
        ${G.overclaims ? `<div class="warnings" style="margin-top:12px"><b>Design → conclusion:</b> ${G.overclaims} conclusion(s) use causal language the study design cannot support (see Consistency audits).</div>` : ''}
      </div>
      ${G.breaks.length ? `<div class="card"><div class="card-head"><h2>Broken and weak links</h2><small>${G.breaks.length}</small></div><ul class="clean">${[...bad, ...weak].map(b => `<li><span class="tag ${b.level === 'bad' ? 'bad' : 'warn'}">${b.level === 'bad' ? 'Broken' : 'Weak'}</span> <b>${esc(b.where)}</b> — ${esc(b.text)}</li>`).join('')}</ul></div>` : ''}
      ${G.objectives.length ? `<div class="card"><div class="card-head"><h2>Objectives followed through the paper</h2></div>${table(['Objective', 'Method', 'Result', 'Discussed', 'Concluded'], G.objectives.map(o => [`<b>${esc(o.id)}</b> ${esc(o.text)}${o.issue ? `<br><span class="muted" style="font-size:13px">${esc(o.issue)}</span>` : ''}`, ...o.steps.map(s => /^yes/i.test(s.v) ? '<span class="yes">✓</span>' : /^no/i.test(s.v) ? '<span class="no">✕</span>' : `<span class="partial">${esc(s.v || '—')}</span>`)]))}</div>` : ''}
      ${G.claims.length ? `<div class="card"><div class="card-head"><h2>Claims → evidence → source</h2></div>${table(['Claim', 'Evidence', 'Source', ''], G.claims.map(c => [esc(c.claim), esc(c.evidence) + (c.note ? `<br><span class="muted" style="font-size:13px">${esc(c.note)}</span>` : ''), esc(c.source), c.level === 'ok' ? '<span class="yes">Holds</span>' : c.level === 'bad' ? '<span class="no">Broken</span>' : '<span class="partial">Weak</span>']))}</div>` : ''}`;
  }

  // ---- statistics & tables (Phase D: table extraction, deterministic recomputation, specialist modules) ----
  function viewModules(M, R) {
    const VD = { SOUND: ['Sound', 'ok'], MINOR_CONCERNS: ['Minor concerns', 'warn'], MAJOR_CONCERNS: ['Major concerns', 'bad'], NOT_APPLICABLE: ['Not applicable', ''], FAILED: ['Did not run', 'bad'], UNCLEAR: ['Unclear', ''] };
    const D = M.deterministic || {}, mods = arr(M.modules), rep = arr(D.reproduced), det = arr(D.findings);
    const sevTag = s => `<span class="tag ${s === 'CRITICAL' || s === 'MAJOR' ? 'bad' : s === 'MINOR' ? 'warn' : ''}">${esc(s)}</span>`;
    const diff = (a, b) => a === null || a === undefined || b === null || b === undefined ? '' : Math.abs(Number(a) - Number(b)) > 0.03 ? ' <span class="no">✕</span>' : ' <span class="yes">✓</span>';
    const modFindings = arr(R.findings).filter(f => /^Specialist Module|^Table Consistency/.test(f.reviewer || '') && f.status !== 'PASS' && f.status !== 'NA');
    return `
      <div class="card">
        <div class="card-head"><h2>Numbers recomputed from your tables</h2><small>arithmetic by code, not by AI</small></div>
        <p class="muted" style="font-size:14px">Every table and reported statistic was transcribed, then checked by code: AVE and composite reliability recomputed from your loadings, t-values against p-values, confidence intervals against "supported", HTMT and Fornell-Larcker, VIF and fit thresholds.</p>
        ${rep.length ? table(['Construct', 'Items', 'AVE reported', 'AVE recomputed', 'CR reported', 'CR recomputed'], rep.map(r => [esc(r.construct), esc(r.items), esc(r.ave_reported ?? '—'), esc(r.ave_recomputed) + diff(r.ave_reported, r.ave_recomputed), esc(r.cr_reported ?? '—'), esc(r.cr_recomputed) + diff(r.cr_reported, r.cr_recomputed)])) : '<p class="muted">No loadings table was found, so AVE and CR could not be recomputed.</p>'}
        <h3>Consistency problems found by code (${det.length})</h3>
        ${det.length ? `<ul class="clean">${det.map(f => `<li>${sevTag(f.severity)} ${esc(f.finding)}${f.evidence_verified ? '' : ' <span class="muted" style="font-size:13px">(value not matched to a quote — check the extraction)</span>'}</li>`).join('')}</ul>` : '<p class="muted">No arithmetic inconsistencies detected in the extracted values.</p>'}
        ${arr(D.notes).length ? `<p class="muted" style="font-size:13px">${D.notes.map(n => esc(n.finding)).join(' · ')}</p>` : ''}
      </div>
      <div class="card">
        <div class="card-head"><h2>Specialist modules</h2><small>${mods.length ? esc(mods.length) + ' run' : 'none run'}</small></div>
        ${mods.length ? mods.map(m => { const v = VD[m.verdict] || [m.verdict, ''];
          return `<div class="comment"><b>${esc(m.name)}</b> <span class="tag ${v[1]}">${esc(v[0])}</span> <span class="muted" style="font-size:13px">${esc((m.counts || {}).fail || 0)} fail · ${esc((m.counts || {}).partial || 0)} partial · ${esc((m.counts || {}).pass || 0)} pass</span>
            ${m.summary ? `<p style="margin:6px 0 0;font-size:14px">${esc(m.summary)}</p>` : ''}${m.error ? `<p class="muted" style="font-size:13px">${esc(m.error)}</p>` : ''}
            ${arr(m.recomputations).length ? table(['Recomputed', 'Reported', 'Recomputed value', 'Consistent'], m.recomputations.map(r => [esc(r.what), esc(r.reported), esc(r.recomputed), r.consistent === false ? '<span class="no">No</span>' : r.consistent === true ? '<span class="yes">Yes</span>' : '—'])) : ''}</div>`; }).join('')
          : '<p class="muted">Specialist modules run in Full Q1 and Forensic modes when the study design calls for them (SEM, regression, mediation, moderation, multigroup, qualitative; reporting-guideline audit in Forensic).</p>'}
        ${modFindings.length ? `<h3>Module and table findings sent to adjudication (${modFindings.length})</h3>${table(['Check', 'Severity', 'Finding'], modFindings.slice(0, 40).map(f => [esc(f.check_id), sevTag(f.severity), esc(f.finding)]))}` : ''}
      </div>
      ${arr(M.tables).length ? `<div class="card"><div class="card-head"><h2>Tables as extracted</h2><small>check these if a number above looks wrong</small></div>${M.tables.map(t => `<h3 style="margin-top:14px">${esc(t.id || 'Table')} <span class="muted" style="font-weight:400;font-size:13px">${esc(t.caption || '')} ${esc(t.location || '')}</span></h3>${table(arr(t.columns).length ? t.columns : arr(arr(t.rows)[0]).map((_, i) => 'Col ' + (i + 1)), arr(t.rows).map(r => arr(r).map(c => esc(c))))}`).join('')}</div>` : ''}
      ${arr(M.errors).length ? `<div class="warnings"><b>Warnings:</b> ${M.errors.map(esc).join(' · ')}</div>` : ''}`;
  }

  function viewLiterature(LT) {
    const nv = LT.novelty || {}, X = LT.xref || {}, cc = LT.citation_check_counts || {}, rp = LT.refs_profile || {};
    const NL = { CLEAR_ADVANCE: ['Clear advance', 'ok'], INCREMENTAL: ['Incremental', 'warn'], LARGELY_OVERLAPPING: ['Largely overlapping', 'bad'], UNCLEAR: ['Unclear', ''], NOT_RUN: ['Not run', ''] };
    const GL = { SUPPORTED: ['Gap supported', 'ok'], PARTLY_SUPPORTED: ['Gap partly supported', 'warn'], NOT_SUPPORTED: ['Gap not supported', 'bad'], CANNOT_TELL: ['Gap: cannot tell', ''] };
    const VL = { SUPPORTED: ['Supported', 'ok'], PARTIALLY_SUPPORTED: ['Partly supported', 'warn'], NOT_SUPPORTED: ['Not supported', 'bad'], CANNOT_VERIFY: ['Cannot verify from abstract', ''] };
    const n = NL[nv.assessment] || [nv.assessment || '—', ''], g = GL[(nv.gap_check || {}).status] || ['Gap: —', ''];
    const work = w => `<b>${esc(w.title)}</b> <span class="muted">(${esc(w.year)}${w.venue ? ', ' + esc(w.venue) : ''}${w.cited_by !== undefined ? ' · cited ' + esc(w.cited_by) + '×' : ''})</span>${w.url ? ` <a href="${esc(w.url)}" target="_blank" rel="noopener">open</a>` : ''}`;
    const checks = arr(LT.citation_checks);
    const order = { NOT_SUPPORTED: 0, PARTIALLY_SUPPORTED: 1, CANNOT_VERIFY: 2, SUPPORTED: 3 };
    return `
      <div class="card">
        <div class="card-head"><h2>Novelty search</h2><small>OpenAlex · titles &amp; abstracts</small></div>
        <p><span class="tag ${n[1]}">${esc(n[0])}</span> <span class="tag ${g[1]}">${esc(g[0])}</span></p>
        ${nv.summary ? `<p>${esc(nv.summary)}</p>` : ''}
        ${(nv.gap_check || {}).note ? `<p class="muted" style="font-size:14px"><b>Stated gap:</b> ${esc(nv.gap_check.note)}</p>` : ''}
        ${arr(nv.closest_prior_work).length ? `<h3>Closest prior work</h3>${nv.closest_prior_work.map(w => `<div class="comment">${work(w)} ${w.cited_in_manuscript ? '<span class="tag ok">cited</span>' : '<span class="tag warn">not cited</span>'}
          <p style="margin:6px 0 0;font-size:14px"><b>Overlap:</b> ${esc(w.overlap)}</p><div class="action"><b>What your paper adds:</b> ${esc(w.difference)}</div></div>`).join('')}` : ''}
        ${arr(nv.missing_key_literature).length ? `<h3>Related works you do not cite</h3><ul class="clean">${nv.missing_key_literature.map(w => `<li>${work(w)}<br><span class="muted" style="font-size:14px">${esc(w.why)}</span></li>`).join('')}</ul>` : ''}
        ${arr(nv.positioning_advice).length ? `<h3>Positioning advice</h3><ul class="clean">${nv.positioning_advice.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
        ${arr(nv.searches).length ? `<p class="sources">Searches: ${nv.searches.map(esc).join(' · ')}</p>` : ''}
      </div>
      <div class="card">
        <div class="card-head"><h2>Citation accuracy</h2><small>judged from the cited work's abstract</small></div>
        <div class="stats">
          <div class="stat"><div class="n">${LT.pairs_checked || 0}</div><div class="l">Claims checked</div></div>
          <div class="stat"><div class="n" style="color:var(--ok)">${cc.SUPPORTED || 0}</div><div class="l">Supported</div></div>
          <div class="stat verify"><div class="n">${cc.PARTIALLY_SUPPORTED || 0}</div><div class="l">Partly supported</div></div>
          <div class="stat critical"><div class="n">${cc.NOT_SUPPORTED || 0}</div><div class="l">Not supported</div></div>
          <div class="stat"><div class="n">${cc.CANNOT_VERIFY || 0}</div><div class="l">Cannot verify</div></div>
        </div>
        ${checks.length ? checks.slice().sort((a, b) => (order[a.verdict] ?? 9) - (order[b.verdict] ?? 9)).map(c => { const v = VL[c.verdict] || [c.verdict, ''];
          return `<div class="comment"><span class="tag ${v[1]}">${esc(v[0])}</span> <span class="muted" style="font-size:13px">${esc(c.citation)} → ${esc((c.cited_work || {}).title)} (${esc((c.cited_work || {}).year)})</span>
            <blockquote class="ev"><span class="loc">${esc(c.location)}</span>${esc(c.claim)}</blockquote>
            <p style="margin:8px 0 0;font-size:14px">${esc(c.explanation)}</p>${c.suggestion && c.verdict !== 'SUPPORTED' ? `<div class="action"><b>Fix:</b> ${esc(c.suggestion)}</div>` : ''}</div>`; }).join('')
          : `<p class="muted">No claim could be paired with a cited work that has an abstract on OpenAlex${LT.pairs_skipped_no_abstract ? ` (${esc(LT.pairs_skipped_no_abstract)} skipped for lack of an abstract)` : ''}.</p>`}
      </div>
      <div class="card">
        <div class="card-head"><h2>In-text citations vs reference list</h2><small>${esc(X.style || '')}</small></div>
        <div class="stats">
          <div class="stat"><div class="n">${X.in_text_citations || 0}</div><div class="l">In-text citations</div></div>
          <div class="stat"><div class="n">${X.unique_references_cited || 0}/${X.references_in_list || 0}</div><div class="l">References cited</div></div>
          <div class="stat critical"><div class="n">${arr(X.missing_from_list).length}</div><div class="l">Missing from list</div></div>
          <div class="stat verify"><div class="n">${arr(X.year_mismatches).length}</div><div class="l">Year mismatches</div></div>
          <div class="stat"><div class="n">${arr(X.uncited_references).length}</div><div class="l">Never cited</div></div>
        </div>
        ${X.reliable === false ? '<p class="muted">Too few citations were recognised for a reliable check.</p>' : ''}
        ${table(['Citation', 'Problem', 'Where'], [
          ...arr(X.missing_from_list).map(x => [esc(x.citation), '<span class="no">not in reference list</span>', `<span class="muted">${esc(x.location)}</span> ${esc(x.sentence)}`]),
          ...arr(X.year_mismatches).map(x => [esc(x.citation), `year differs — list has ${esc(arr(x.reference_years).join('/'))}`, `<span class="muted">${esc(x.location)}</span> ${esc(x.sentence)}`]),
          ...arr(X.uncited_references).map(r => ['Ref #' + esc(r.ref_index), 'never cited in the text', esc(r.reference)])])}
        ${arr(rp.retracted).length ? `<div class="warnings" style="margin-top:14px"><b>Retracted per OpenAlex:</b> ${rp.retracted.map(r => esc(r.title + ' (' + r.year + ')')).join('; ')}</div>` : ''}
        <p class="muted" style="font-size:13px;margin-top:10px">${esc(rp.openalex_matched || 0)} of your references were found on OpenAlex (${esc(rp.with_abstract || 0)} with an abstract)${rp.median_cited_by !== null && rp.median_cited_by !== undefined ? `; median citations per reference ${esc(rp.median_cited_by)}` : ''}.</p>
      </div>
      ${arr(LT.errors).length ? `<div class="warnings"><b>Warnings:</b> ${LT.errors.map(esc).join(' · ')}</div>` : ''}
      <div class="card"><h3>Limits</h3><ul class="clean">${arr(LT.caveats).map(x => `<li class="muted" style="font-size:14px">${esc(x)}</li>`).join('')}</ul></div>`;
  }

  function renderOriginalityReport(R, opts) {
    const id = opts.id, M = R.meta || {}, IG = R.integrity || {};
    app.innerHTML = `
      <div class="draft-banner"><b>Originality-only check.</b> This screens for copied passages and generic, AI-sounding wording. It is not a full review — run Quick, Full Q1 or Forensic for the complete pre-submission assessment.</div>
      ${arr(R.pipeline_warnings).length ? `<div class="warnings"><b>Warnings:</b> ${arr(R.pipeline_warnings).map(esc).join(' · ')}</div>` : ''}
      <div class="report-head">
        <div>
          <div class="eyebrow">Originality & AI-writing screen</div>
          <h1>${esc(M.title || id)}</h1>
          <div class="report-meta">
            ${M.target_journal ? `<span>Target: <b>${esc(M.target_journal)}</b></span>` : ''}<span>${esc(M.word_count || '?')} words${M.ocr_used ? ' · OCR' : ''}</span>
            <span class="mono">${esc(R.review_id || id)}</span><span>${esc(fmtDate(R.generated_at))}</span>
          </div>
        </div>
        <div class="report-actions">
          <a class="btn btn-ghost btn-sm" href="#/">Run a full review</a>
          <button class="btn btn-ghost btn-sm" id="exportJson">Download JSON</button>
          <button class="btn btn-ghost btn-sm" id="printBtn">Print / PDF</button>
          ${opts.demo ? '' : '<button class="btn btn-ghost btn-sm" id="refreshBtn" title="Reload the result from the server">Refresh</button>'}
        </div>
      </div>
      <section class="tab-panel" style="margin-top:18px">${viewOriginality(IG)}</section>`;
    $('#printBtn').addEventListener('click', () => window.print());
    $('#exportJson').addEventListener('click', () => download((R.review_id || id) + '.json', JSON.stringify(R, null, 2), 'application/json'));
    const rf = $('#refreshBtn'); if (rf) rf.addEventListener('click', () => { store.del('result:' + id); renderReview(id); });
  }

  // ---------- ORIGINALITY & AI-WRITING ----------
  function viewOriginality(IG) {
    const fs = IG.free_screen || {}, sr = IG.style_review || {}, cl = IG.copyleaks || {};
    const sim = cl.similarity, ai = cl.ai;
    const pctTone = v => v === null || v === undefined ? '' : v > 25 ? 'critical' : v > 15 ? 'major' : '';
    let h = '';
    if (cl.enabled && sim) {
      h += `<div class="card"><div class="card-head"><h2>Similarity check</h2><small>Copyleaks</small></div>
        ${sim.overall_pct !== null && sim.overall_pct !== undefined ? `<div class="stats">
          <div class="stat ${pctTone(sim.overall_pct)}"><div class="n">${esc(sim.overall_pct)}%</div><div class="l">Overall similarity</div></div>
          <div class="stat"><div class="n">${esc(sim.identical_pct ?? '—')}%</div><div class="l">Identical</div></div>
          <div class="stat"><div class="n">${esc(sim.minor_changes_pct ?? '—')}%</div><div class="l">Minor changes</div></div>
          <div class="stat"><div class="n">${esc(sim.paraphrased_pct ?? '—')}%</div><div class="l">Paraphrased</div></div>
          <div class="stat"><div class="n">${esc(sim.sources_total || 0)}</div><div class="l">Sources</div></div>
        </div>${sim.report_pdf ? `<p style="margin:12px 0 0"><a class="btn btn-ghost btn-sm" target="_blank" rel="noopener" href="${esc(sim.report_pdf)}">Open Copyleaks PDF report</a></p>` : ''}` : `<p class="muted">${esc(sim.message || sim.status)}</p>`}
        ${arr(sim.sources).length ? arr(sim.sources).slice(0, 12).map(s => `<div class="comment"><b>${esc(s.title || s.url || 'Source')}</b> <span class="tag">${esc(s.type)}</span> <span class="tag ${s.pct > 5 ? 'bad' : ''}">${esc(s.pct ?? '?')}% · ${esc(s.matched_words)} words</span>
          ${s.url ? `<div class="sources"><a target="_blank" rel="noopener" href="${esc(s.url)}">${esc(s.url)}</a></div>` : ''}
          ${arr(s.passages).slice(0, 3).map(p => `<blockquote class="ev"><span class="loc">${esc(p.location || '')} · ${esc(p.type)}</span>${esc(p.manuscript_text)}</blockquote>`).join('')}</div>`).join('') : ''}
      </div>`;
      if (ai) h += `<div class="card"><div class="card-head"><h2>AI-writing detector</h2><small>Copyleaks · statistical signal, not proof</small></div>
        ${ai.status === 'error' ? `<p class="muted">${esc(arr(ai.errors).join(' '))}</p>` : `<div class="stats"><div class="stat"><div class="n">${esc(Math.round((ai.ai_share || 0) * 100))}%</div><div class="l">Text classified as AI-like</div></div><div class="stat"><div class="n">${esc(ai.words_scanned || 0)}</div><div class="l">Words scanned</div></div></div>
        ${arr(ai.passages).slice(0, 12).map(p => `<blockquote class="ev"><span class="loc">${esc(p.location || '')}</span>${esc(p.text)}</blockquote>`).join('')}`}
        <p class="muted" style="font-size:13.5px;margin-bottom:0">Detectors often misclassify text by non-native English writers and formulaic methods sections. Use this to decide where to revise wording, never as evidence of misconduct.</p></div>`;
    } else {
      h += `<div class="card" style="margin-bottom:16px"><p style="margin:0"><b>Full similarity check not run.</b> This review used the free screens below. For a Turnitin-style similarity percentage, run iThenticate/Turnitin — or DrillBit through your university library (INFLIBNET ShodhShuddhi) — before submitting. The site owner can also enable Copyleaks.</p></div>`;
    }
    h += `<div class="card"><div class="card-head"><h2>Open-access overlap screen</h2><small>free · sample-based</small></div>
      <div class="stats">
        <div class="stat ${fs.matched ? 'major' : ''}"><div class="n">${esc(fs.matched || 0)} / ${esc(fs.sampled || 0)}</div><div class="l">Sampled sentences found verbatim in published works</div></div>
        <div class="stat"><div class="n">${esc(fs.own_work_matches || 0)}</div><div class="l">Matches to what looks like your own earlier version</div></div>
      </div>
      <p class="muted" style="font-size:13.5px">Searched as exact phrases in ${esc(arr(fs.engines).join(' and ') || 'open databases')}.${fs.note ? ' ' + esc(fs.note) : ''}</p>
      ${arr(fs.sources).length ? arr(fs.sources).map(s => `<div class="comment"><b>${esc(s.title)}</b>${s.year ? ` (${esc(s.year)})` : ''} ${s.own_work_suspected ? '<span class="tag">likely your own work</span>' : '<span class="tag bad">other authors</span>'} <span class="tag">${esc(s.matched_sentences)} sentence${s.matched_sentences === 1 ? '' : 's'}</span>
        <div class="sources">${esc(s.authors || '')}${s.venue ? ' · ' + esc(s.venue) : ''}${s.url ? ` · <a target="_blank" rel="noopener" href="${esc(s.url)}">${esc(s.doi || s.url)}</a>` : ''}</div>
        ${arr(s.hits).slice(0, 3).map(x => `<blockquote class="ev"><span class="loc">${esc(x.location || '')}</span>${esc(x.manuscript_text)}</blockquote>`).join('')}
        <div class="action"><b>Action:</b> ${s.own_work_suspected ? 'If this is your own preprint or thesis, disclose it in the cover letter and check the journal’s prior-publication policy.' : 'Rewrite in your own words or quote and cite the source.'}</div></div>`).join('') : `<p style="margin:0">${fs.status === 'complete' ? 'No verbatim overlap found in the sampled sentences.' : esc(fs.status || 'Not run')}</p>`}
    </div>`;
    h += `<div class="card"><div class="card-head"><h2>Writing-authenticity review</h2><small>no AI score</small></div>
      <p>${esc(sr.overall_note || (sr.status === 'disabled' ? 'Disabled.' : 'Not available.'))}</p>
      <dl class="kv"><dt>AI-use disclosure</dt><dd>${sr.disclosure_statement_found ? '<span class="yes">Found</span>' + (sr.disclosure_quote ? ` — <i>“${esc(sr.disclosure_quote)}”</i>` : '') : '<span class="no">Not found</span>'}${sr.disclosure_advice ? `<br><span class="muted">${esc(sr.disclosure_advice)}</span>` : ''}</dd>
      ${sr.style_shift_detected ? `<dt>Style shift</dt><dd>${esc(sr.style_shift_note)}</dd>` : ''}</dl>
      ${arr(sr.passages).map(x => `<div class="comment"><span class="tag">${esc(String(x.pattern || '').replace(/_/g, ' '))}</span>${x.quote_verified ? '' : ' <span class="tag warn">quote not verified</span>'}
        <blockquote class="ev"><span class="loc">${esc(x.location || '')}</span>${esc(x.quote)}</blockquote>
        ${x.why_it_matters ? `<p class="muted" style="margin:4px 0;font-size:14px">${esc(x.why_it_matters)}</p>` : ''}
        ${x.suggestion ? `<div class="action"><b>Suggestion:</b> ${esc(x.suggestion)}</div>` : ''}</div>`).join('')}
    </div>`;
    h += `<div class="card"><h3>Limits of these checks</h3><ul class="clean">${arr(IG.caveats).map(c => `<li>${esc(c)}</li>`).join('')}</ul></div>`;
    return h;
  }

  // ---------- literature review, built from this review's feedback ----------
  let litBrief = null;
  const LIT_STYLES = [['', 'APA 7 (default)'], ['harvard', 'Harvard'], ['vancouver', 'Vancouver'], ['chicago', 'Chicago (author-date)'], ['ieee', 'IEEE'], ['mla', 'MLA 9']];
  function viewLitReview(R, S, id) {
    litBrief = window.Q1Brief ? window.Q1Brief.literatureBriefFromReview(R, S) : { question: '', queries: [], gaps: [] };
    const gapsHtml = litBrief.gaps.length
      ? `<ul class="clean" style="margin:6px 0 0">${litBrief.gaps.map(g => `<li><small class="muted">${esc(g.source)}</small> — ${esc(g.text)}</li>`).join('')}</ul>`
      : '<p class="muted" style="margin:6px 0 0">The review raised no literature gaps, so the search uses the paper’s topic only.</p>';
    return `<div class="card">
      <div class="card-head"><h2>Literature review from this review’s feedback</h2><small>free sources</small></div>
      <p class="muted" style="margin-top:0">The search starts from this paper’s topic and the review’s literature gaps below. It draws on OpenAlex and Crossref, plus government and industry reports from trusted publishers (UN Tourism, OECD, WHO, World Bank, Government of India ministries, WTTC and similar). Sci-Hub and Wikipedia are never used. Every citation in the draft points to a source that was actually found.</p>
      <h3 style="margin:14px 0 4px">Gaps the literature should address</h3>${gapsHtml}
      <form id="litForm" style="margin-top:16px">
        <label class="field"><span>Research question</span><textarea name="question" rows="2">${esc(litBrief.question)}</textarea></label>
        <label class="field"><span>Search queries (one per line)</span><textarea name="queries" rows="5">${esc(litBrief.queries.join('\n'))}</textarea></label>
        <label class="field"><span>Expected length (optional)</span><input type="text" name="length" placeholder="1,200 to 1,800 words" maxlength="60"></label>
        <label class="field"><span>Headings or points to cover (optional, one per line)</span><textarea name="outline" rows="5" placeholder="Clinical readiness&#10;Regulatory governance&#10;Economic dynamics"></textarea></label>
        <p class="muted" style="font-size:13.5px;margin-top:-4px">If you list headings, the draft follows them in this order, one section each, and ends with a gaps section. Leave them empty for a draft organised by theme.</p>
        <div class="grid-2">
          <label class="field"><span>Citation style</span><select name="style">${LIT_STYLES.map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join('')}</select></label>
          <label class="field"><span>Published from (year, optional)</span><input type="number" name="yearFrom" min="1900" max="2100" placeholder="No limit"></label>
          <label class="field"><span>Minimum citations (optional)</span><input type="number" name="minCitations" min="0" placeholder="No limit"></label>
          <label class="field" style="flex-direction:row;align-items:center;gap:8px"><input type="checkbox" name="includeGrey" checked> <span>Include government and industry reports</span></label>
        </div>
        <p class="muted" style="font-size:13.5px">Recency is optional. Theory papers from any year are kept unless you set a start year.</p>
        <button class="btn btn-primary" type="submit" id="litRun">Build literature review</button>
        <p class="settings-status" id="litStatus" role="status"></p>
      </form>
      <div id="litResult"></div>
    </div>`;
  }
  function renderLitResult(d) {
    const box = $('#litResult');
    if (d.skipped && Array.isArray(d.references) && d.references.length) {
      box.innerHTML = `<h3 style="margin-top:18px">Sources found</h3><p class="muted" style="font-size:14px">The AI written draft is not connected on the server yet, so only the sources and reference list are shown. ${d.references.length} source(s) passed the filters.</p>` +
        `<ol style="font-size:14px;line-height:1.5">${d.references.map(r => `<li>${esc(r.text)}</li>`).join('')}</ol>`;
      return;
    }
    if (!d.ok) { box.innerHTML = `<p class="form-error">${esc(d.reason || d.error || 'No literature review was produced.')}</p>`; return; }
    const labels = d.labels || {};
    const body = String(d.draft || '').replace(/\{\{cite:([^}]+)\}\}/g, (m, k) => ' (' + esc(labels[k] || k) + ')');
    const excluded = Object.entries((d.log && d.log.excludedBy) || {}).map(([k, v]) => `${esc(k)}: ${v}`).join(' · ');
    box.innerHTML = `<h3 style="margin-top:18px">Draft review</h3>
      ${(d.draft ? String(body).split(/\n{2,}/).map(p => `<p>${esc(p)}</p>`).join('') : '<p class="muted">Empty draft.</p>')}
      <h3 style="margin-top:18px">References (${esc(d.style || 'APA 7')})</h3>
      <ol class="clean" style="padding-left:20px">${(d.references || []).map(r => `<li style="margin-bottom:8px">${esc(r.text)}${r.foundational ? ' <small class="muted">foundational</small>' : ''}${r.tier ? ` <small class="muted">${esc(r.tier)}</small>` : ''}</li>`).join('')}</ol>
      ${excluded ? `<p class="muted" style="font-size:13.5px"><b>Excluded during filtering:</b> ${excluded}</p>` : ''}
      ${d.unresolvedKeys && d.unresolvedKeys.length ? `<p class="form-error">Some citations could not be matched to a source and were removed: ${esc(d.unresolvedKeys.join(', '))}</p>` : ''}`;
  }
  async function runLitReview(e, id) {
    e.preventDefault();
    const f = e.target, st = $('#litStatus');
    const queries = f.queries.value.split('\n').map(s => s.trim()).filter(Boolean);
    if (!queries.length) { st.textContent = 'Add at least one search query.'; return; }
    if (!settings().api) { openSettings('Connect the review service first.'); return; }
    const btn = $('#litRun'); btn.disabled = true; st.textContent = 'Searching sources and writing the review. This usually takes a few minutes.';
    $('#litResult').innerHTML = '';
    try {
      const d = await apiPostForm(CFG.literaturePath || '/q1-literature-run', {
        review_id: id, question: f.question.value.trim(), queries: JSON.stringify(queries), style: f.style.value,
        length: f.length.value.trim(), outline: JSON.stringify(f.outline.value.split('\n').map(x => x.trim()).filter(Boolean)),
        filters: JSON.stringify({ yearFrom: f.yearFrom.value ? Number(f.yearFrom.value) : null, minCitations: f.minCitations.value ? Number(f.minCitations.value) : null, includeGrey: f.includeGrey.checked }),
        gaps: JSON.stringify((litBrief && litBrief.gaps) || [])
      });
      st.textContent = ''; renderLitResult(d);
    } catch (err) {
      st.textContent = /404/.test(err.message) ? 'The literature service is not connected yet. Its n8n workflow must be published first.' : err.message;
    } finally { btn.disabled = false; }
  }

  // Step-by-step revision plan. Built from revision_roadmap; optional fields
  // location / fix / verify are shown when the engine provides them.
  function viewRoadmap(S, id) {
    const RM = S.revision_roadmap || {};
    const groups = [['priority_1_must_fix', 'Priority 1 — Must fix', 'CRITICAL'], ['priority_2_substantive', 'Priority 2 — Substantive revision', 'MAJOR'], ['priority_3_strengthening', 'Priority 3 — Strengthening', 'MINOR'], ['priority_4_editorial', 'Priority 4 — Editorial', 'INFO']];
    const done = store.get('road:' + id, {});
    let total = 0, ticked = 0;
    groups.forEach(([k]) => arr(RM[k]).forEach((t, i) => { total++; if (done[k + ':' + i]) ticked++; }));
    let n = 0;
    const meta = (label, v) => v ? `<p class="muted" style="margin:2px 0 0 28px;font-size:13.5px"><b>${label}:</b> ${esc(v)}</p>` : '';
    const body = groups.map(([k, label, sev]) => {
      const items = arr(RM[k]);
      if (!items.length) return '';
      const start = n + 1;
      return `<h3 style="margin-top:18px"><span class="sev sev-${sev}">${sev === 'INFO' ? 'P4' : sev === 'MINOR' ? 'P3' : sev === 'MAJOR' ? 'P2' : 'P1'}</span> ${label}</h3>
        <ol class="clean" start="${start}" style="padding-left:0;list-style:none;margin:0">${items.map((t, i) => {
          n++; const key = k + ':' + i; const fids = arr(t.finding_ids).filter(Boolean);
          return `<li class="step" style="margin:0 0 12px">
            <label class="task ${done[key] ? 'done' : ''}" style="margin:0"><input type="checkbox" data-road="${key}" ${done[key] ? 'checked' : ''}><span><b>Step ${n}.</b> ${esc(t.action)}${fids.length ? ` <small>[${fids.map(esc).join(', ')}]</small>` : ''}</span></label>
            ${meta('Where', t.location)}${meta('How', t.fix)}${meta('Check', t.verify)}
          </li>`; }).join('')}</ol>`;
    }).join('');
    return `<div class="card"><p class="muted" style="margin-top:0">Work through the steps in order. Each step names the finding it resolves. When you are done, submit the revised paper as a new version: its <i>Changes since last version</i> tab shows which findings were resolved. Progress is saved in this browser.</p>
      <p style="margin:0 0 6px"><b id="stepCount">${ticked} of ${total} steps done</b></p>
      ${total ? body : '<p class="muted">The engine produced no revision steps for this review.</p>'}
      ${arr(S.cover_letter_tips).length ? `<h3 style="margin-top:18px">Cover-letter tips</h3><ul class="clean">${arr(S.cover_letter_tips).map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}</div>`;
  }
  function wireRoadmap(id) {
    $$('[data-road]').forEach(cb => cb.addEventListener('change', () => {
      const done = store.get('road:' + id, {}); done[cb.dataset.road] = cb.checked; store.set('road:' + id, done);
      cb.closest('.task').classList.toggle('done', cb.checked);
      const all = $$('[data-road]'); const sc = $('#stepCount');
      if (sc) sc.textContent = all.filter(x => x.checked).length + ' of ' + all.length + ' steps done';
    }));
    const rd = $('#refData'); if (!rd) return;
    const results = JSON.parse(rd.textContent.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'));
    const draw = () => {
      const all = $('#refFilter').value === 'all';
      const rows = results.filter(r => all || r.status !== 'VERIFIED');
      $('#refTable').innerHTML = table(['#', 'Reference in manuscript', 'Status', 'Crossref record', 'Notes'], rows.map(r => [esc(r.ref_index), esc(r.reference), `<span class="tag ${r.tone}">${esc(String(r.status).replace(/_/g, ' '))}</span>`,
        r.crossref_doi ? `${esc(r.crossref_title)} (${esc(r.crossref_year)})<br><a target="_blank" rel="noopener" href="https://doi.org/${esc(r.crossref_doi)}">doi:${esc(r.crossref_doi)}</a>` : '—',
        esc((r.notes || '') + (r.missing_doi_available ? ' Add DOI: ' + r.missing_doi_available : ''))]));
    };
    $('#refFilter').addEventListener('change', draw); draw();
  }

  function viewLetter(S) {
    return `<div class="card"><div class="card-head"><h2>Reviewer-style letter</h2><button class="btn btn-ghost btn-sm" id="copyLetter">Copy</button></div>
      <div class="letter">${esc(S.reviewer_letter || 'Not available.')}</div>
      ${S.limitations_of_this_review ? `<p class="muted" style="margin-top:18px;font-size:13.5px"><b>Limitations of this review:</b> ${esc(S.limitations_of_this_review)}</p>` : ''}</div>`;
  }

  function viewChecksShell(findings) {
    const reviewers = [...new Set(findings.map(f => f.reviewer))];
    return `<div class="card" style="margin-bottom:16px"><p style="margin:0">Raw output of every checklist item from every reviewer and engine, before adjudication — including the checks your paper passed.</p></div>
      <div class="toolbar">
        <select id="cRev"><option value="">All reviewers</option>${reviewers.map(r => `<option>${esc(r)}</option>`).join('')}</select>
        <select id="cSt"><option value="">All statuses</option><option>PASS</option><option>PARTIAL</option><option>FAIL</option><option>UNCERTAIN</option><option>NA</option></select>
        <input type="search" id="cQ" placeholder="Search checks…">
      </div><div id="checkTable"></div>`;
  }
  function wireChecks(findings) {
    if (!$('#cRev')) return;
    const draw = () => {
      const r = $('#cRev').value, s = $('#cSt').value, q = $('#cQ').value.toLowerCase();
      const rows = findings.filter(f => (!r || f.reviewer === r) && (!s || f.status === s) && (!q || JSON.stringify(f).toLowerCase().includes(q)));
      const stTone = st => st === 'PASS' ? 'ok' : st === 'FAIL' ? 'bad' : st === 'NA' ? '' : 'warn';
      $('#checkTable').innerHTML = table(['ID', 'Check', 'Status', 'Severity', 'Finding', 'Evidence', 'Reviewer'], rows.map(f => [
        `<span class="mono">${esc(f.id)}</span>`, `<span class="mono">${esc(f.check_id)}</span>`, `<span class="tag ${stTone(f.status)}">${esc(f.status)}</span>`,
        f.status === 'PASS' || f.status === 'NA' ? '' : `<span class="sev sev-${esc(f.severity)}">${esc(f.severity)}</span>`,
        esc(f.finding) + (f.recommendation && f.status !== 'PASS' ? `<br><small><b>Action:</b> ${esc(f.recommendation)}</small>` : ''),
        arr(f.evidence).map(e => `<small>${e.verified ? '✓' : '✗'} ${esc(e.location || '')} “${esc(String(e.quote).slice(0, 160))}”</small>`).join('<br>'),
        `<small>${esc(f.reviewer)}</small>`]));
    };
    ['#cRev', '#cSt'].forEach(x => $(x).addEventListener('change', draw)); $('#cQ').addEventListener('input', draw); draw();
  }

  // ---------- HOW IT WORKS ----------
  function renderHow() {
    app.innerHTML = `
      <div style="max-width:860px;margin:0 auto">
        <div class="eyebrow">How it works</div>
        <h1>Not one prompt. A review pipeline.</h1>
        <p class="lead muted">A single AI reading your paper produces confident, generic critique. This engine breaks the review into specialised, verifiable steps and keeps a human in charge of the final call.</p>
        <ol class="pipeline">
          <li><div><b>Extraction</b><span>Text is extracted with page markers so every finding can point to a location. Scanned PDFs are transcribed by Gemini; DOCX files are converted through Google Docs.</span></div></li>
          <li><div><b>Classification & inventory</b><span>Gemini identifies the design (e.g. cross-sectional survey + PLS-SEM, interviews, systematic review) and lists objectives, hypotheses, constructs, claims, numbers and references.</span></div></li>
          <li><div><b>Adaptive checklist</b><span>From a library of up to 300 Q1 criteria (kept in a database and editable without code changes), only the checks relevant to your design and chosen depth are selected — SEM checks for SEM papers, COREQ/SRQR for qualitative work, PRISMA for reviews.</span></div></li>
          <li><div><b>Seven independent specialist reviewers</b><span>Gemini reviewers for theory, method, statistics, literature, integrity, reporting and the editor view work separately (no groupthink), each returning structured findings with verbatim quotes.</span></div></li>
          <li><div><b>Evidence validator</b><span>Each quote is matched against your manuscript. A MAJOR or CRITICAL finding without a verifiable quote is held for human verification instead of being reported as fact.</span></div></li>
          <li><div><b>Rule-based number & language audit</b><span>Deterministic checks for inconsistent sample sizes, p = .000, reliability/validity/fit thresholds, Harman-only CMB, Fornell-Larcker-only validity, causal verbs in cross-sectional designs and missing ethics statements.</span></div></li>
          <li><div><b>Cross-validation engine</b><span>Objective → result tracing, hypothesis ↔ result comparison, table ↔ text and section-to-section contradiction checks.</span></div></li>
          <li><div><b>Best-fit journals (free sources)</b><span>OpenAlex finds the journals that published the papers most similar to yours in the last six years. Each is checked against the current Scopus source list, SCImago (SJR) quartiles, the Web of Science collection lists (SSCI, SCIE, AHCI, ESCI), the ABDC journal list and DOAJ (open access, fees, time to publication), filtered by your quartile, rank, fee and publisher choices, and given a short AI note on scope fit. Also available on its own under <a href="#/journals">Journal finder</a>.</span></div></li>
          <li><div><b>Reference verification</b><span>References are checked against Crossref for existence, metadata mismatches, missing DOIs and retraction notices; your title is searched for possible prior publication.</span></div></li>
          <li><div><b>Evidence map</b><span>Each hypothesis is traced from theory to measures, result and conclusion, each objective through method, results, discussion and conclusion, and each claim to the evidence or source behind it. Broken and weak links are shown in red and amber.</span></div></li>
          <li><div><b>Table &amp; statistics modules</b><span>Every table is transcribed and the numbers are re-checked by code (AVE and composite reliability recomputed from loadings, t against p, confidence intervals against "supported", HTMT, VIF, fit). In Full and Forensic modes, specialist modules then go deeper where your design needs them: SEM approach, measurement model, regression, mediation, moderation, multigroup analysis, qualitative rigour and a reporting-guideline audit.</span></div></li>
          <li><div><b>Raw-data reproduction (optional)</b><span>If you attach your dataset (CSV, XLSX or SAV), a private Python statistics engine running on our own server re-computes alpha, CR, AVE, loadings, HTMT, Fornell-Larcker and the PLS paths with bootstrapped confidence intervals (or a CFA for CB-SEM) and lists every reported value it cannot reproduce. The data never goes to an AI service and is not stored.</span></div></li>
          <li><div><b>Literature &amp; novelty engine</b><span>OpenAlex is searched for the closest recent and most-cited related studies to judge novelty, test the stated gap and list related work you do not cite. Every in-text citation is matched to the reference list, and a sample of claims is checked against the abstract of the work they cite.</span></div></li>
          <li><div><b>Originality & writing screen</b><span>Sampled sentences are searched as exact phrases in OpenAlex and Europe PMC to catch verbatim overlap with published work, and a writing review flags generic, template-like passages and a missing AI-use disclosure. No AI % score is given. An optional Copyleaks integration adds a full similarity percentage and AI detector. Choose <b>Originality only</b> on the form to run just this screen in a few minutes.</span></div></li>
          <li><div><b>Adjudication & synthesis</b><span>An adjudicator merges duplicates and dismisses findings the manuscript contradicts; Claude writes the final assessment, diagnostic profile, comments, roadmap and reviewer letter.</span></div></li>
          <li><div><b>Private mode &amp; clean-up</b><span>Tick <i>Private mode</i> to have the manuscript read only by an open AI model (gpt-oss-120b on Groq with Zero Data Retention: not stored, not used for training), so no text reaches Gemini, Claude or any outside search; it is a little less thorough, so treat it as a strong first pass. Tick <i>Delete working files</i> (or use <i>Free space</i> on the Dashboard) to remove the stored manuscript copy and the server's run data once the report is ready; <i>Delete</i> removes the whole review. In the Drive inbox, add [PRIVATE] or [CLEAN] to the file name.</span></div></li>
          <li><div><b>Versions, team keys & intake</b><span>Upload a file or paste a Drive/Dropbox link, give the journal's guideline URL to fetch its requirements, and mark a submission as a revision of an earlier review to get a check-by-check "resolved / still open / new" comparison. Each co-author or student can have their own revocable key, every manuscript is filed in a Google Drive folder, and a dashboard lists all reviews by manuscript and version. Files dropped into the Drive inbox folder are reviewed automatically.</span></div></li>
          <li><div><b>You decide</b><span>Confirm, modify or reject each finding, tick off the roadmap, and export your validated list.</span></div></li>
        </ol>
        <div class="card" style="margin-top:22px"><h3>Privacy</h3><p style="margin:0">Manuscript text is sent to Google Gemini (free tier: Google may use submitted text to improve its products, and human reviewers may read it) and Anthropic Claude through your own n8n server, and short sampled phrases are searched in OpenAlex and Europe PMC and stored there (status table, Google Drive report). This site is static: it stores nothing except your access key, review list and validation notes in your own browser. Do not upload manuscripts you received in confidence as a journal reviewer.</p></div>
      </div>`;
  }

  setMe(store.get('me', null));
  refreshMe();
  route();
})();
