/* Q1 Paper Reviewer — static single-page app (no build step, no dependencies).
   Talks to the n8n review engine through two webhooks:
     POST {apiBase}/q1-review-submit   multipart form → { ok, review_id }
     GET  {apiBase}/q1-review-status?id=&key=[&include=result] → progress / final result JSON
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
  const settings = () => ({ key: store.get('key', ''), api: store.get('api', '') || CFG.apiBase });
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
    SUBSTANTIVE_REVISION_NEEDED: 'Substantive revision needed', NOT_READY: 'Not ready for submission', UNDETERMINED: 'Not determined'
  };
  const RATING_W = { Strong: 90, Moderate: 62, Weak: 32, Unclear: 10 };
  const STAGES = [
    ['received', 'Manuscript received', 5],
    ['classifying', 'Text extraction, study-design classification & manuscript inventory', 15],
    ['specialist_review', '7 independent specialist reviewers', 25],
    ['cross_validation', 'Evidence validation & cross-document consistency audit', 55],
    ['reference_check', 'Reference verification on Crossref', 65],
    ['adjudication', 'Adjudication of findings', 75],
    ['synthesis', 'Q1 synthesis report', 85],
    ['done', 'Report ready', 100]
  ];

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
    renderHome();
  }
  window.addEventListener('hashchange', route);

  // ---------- settings dialog ----------
  const dlg = $('#settingsDialog');
  function openSettings(msg) {
    const s = settings();
    $('#setKey').value = s.key; $('#setApi').value = s.api;
    $('#settingsStatus').textContent = msg || '';
    if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', '');
  }
  $('#settingsBtn').addEventListener('click', () => openSettings());
  $('#closeSettings').addEventListener('click', () => dlg.close());
  $('#settingsForm').addEventListener('submit', (e) => {
    const key = $('#setKey').value.trim(); const api = $('#setApi').value.trim();
    if (!key) { e.preventDefault(); $('#settingsStatus').textContent = 'Please enter the access key.'; return; }
    store.set('key', key); store.set('api', api && api !== CFG.apiBase ? api : '');
    toast('Settings saved'); setTimeout(route, 50);
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
        <p class="lead">Upload your paper and a panel of seven independent AI specialist reviewers evaluates it against an adaptive checklist of 110+ Scopus Q1 criteria. Every finding must quote your manuscript, numbers and references are checked by rule and against Crossref, and an adjudicator removes duplicates and unsupported claims.</p>
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
        <div class="grid-2">
          <label class="field"><span>Target journal <em>required</em></span><input type="text" name="target_journal" required placeholder="e.g. Tourism Management"></label>
          <label class="field"><span>Paper title <i>optional</i></span><input type="text" name="paper_title" placeholder="Detected automatically"></label>
          <label class="field"><span>Article type</span>
            <select name="article_type">
              <option>Original research article</option><option>Systematic / scoping review</option><option>Meta-analysis</option>
              <option>Conceptual paper</option><option>Case study</option><option>Research note / short communication</option>
            </select></label>
          <label class="field"><span>Research field</span><input type="text" name="field" value="Tourism & Hospitality"></label>
        </div>
        <div class="field" style="margin-bottom:6px"><span>Review depth</span></div>
        <div class="modes">
          <div class="mode"><input type="radio" name="review_mode" id="m1" value="QUICK"><label for="m1"><b>Quick</b><span>~40 core checks · 15 refs · fastest</span></label></div>
          <div class="mode"><input type="radio" name="review_mode" id="m2" value="FULL_Q1" checked><label for="m2"><b>Full Q1</b><span>~90–120 checks · 40 refs · recommended</span></label></div>
          <div class="mode"><input type="radio" name="review_mode" id="m3" value="FORENSIC"><label for="m3"><b>Forensic</b><span>All checks · 80 refs · deepest</span></label></div>
        </div>
        <details class="more">
          <summary>Journal guidelines, notes & email (optional)</summary>
          <label class="field"><span>Aims & scope / author guidelines</span><textarea name="journal_guidelines" placeholder="Paste the journal's aims & scope and key submission requirements for a sharper journal-fit check"></textarea></label>
          <label class="field"><span>Anything the reviewers should know?</span><textarea name="author_notes" placeholder="e.g. This is a revised version; data collection was in 2025"></textarea></label>
          <label class="field"><span>Also email the report to</span><input type="email" name="email" placeholder="you@university.edu"></label>
        </details>
        <label class="consent"><input type="checkbox" id="consent"> <span>I am authorised to process this manuscript with third-party AI services (Google Gemini, Anthropic Claude). I will not upload manuscripts I received in confidence as a journal reviewer.</span></label>
        <p class="form-error" id="formError" role="alert"></p>
        <button class="btn btn-primary btn-lg" type="submit" id="submitBtn" style="width:100%">Start Q1 review</button>
      </form>
    </section>`;
    const addKey = $('#addKeyBtn'); if (addKey) addKey.addEventListener('click', () => openSettings());
    wireForm();
  }

  function wireForm() {
    const dz = $('#dropzone'), fi = $('#fileInput'), form = $('#submitForm'), err = $('#formError');
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

    form.addEventListener('submit', async (e) => {
      e.preventDefault(); err.textContent = '';
      const s = settings();
      if (!s.key) { openSettings('An access key is required to submit.'); return; }
      if (!file) { err.textContent = 'Please choose your manuscript file.'; return; }
      const fd = new FormData(form);
      if (!String(fd.get('target_journal') || '').trim()) { err.textContent = 'Please enter the target journal.'; form.target_journal.focus(); return; }
      if (!$('#consent').checked) { err.textContent = 'Please confirm the data-processing statement.'; return; }
      fd.append('access_key', s.key);
      fd.append('manuscript', file, file.name);
      const btn = $('#submitBtn'); btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Uploading…';
      try {
        const res = await fetch(s.api.replace(/\/$/, '') + CFG.submitPath, { method: 'POST', body: fd });
        const data = await res.json().catch(() => null);
        if (!res.ok || !data || !data.ok) throw new Error((data && data.error) || ('Submission failed (' + res.status + ')'));
        history.upsert({ id: data.review_id, title: fd.get('paper_title') || file.name, journal: fd.get('target_journal'), mode: fd.get('review_mode'), submitted_at: new Date().toISOString(), status: 'queued' });
        toast('Submitted — review ' + data.review_id + ' started');
        location.hash = '#/review/' + encodeURIComponent(data.review_id);
      } catch (ex) {
        err.textContent = ex.message === 'Failed to fetch' ? 'Could not reach the review server. Check your connection or the API URL in Settings.' : ex.message;
        btn.disabled = false; btn.textContent = 'Start Q1 review';
      }
    });
  }

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
    app.innerHTML = `
      <div class="card progress-wrap" id="progressCard">
        <div class="eyebrow">Review in progress</div>
        <h2 id="pTitle">${esc(entry.title || id)}</h2>
        <p class="muted" style="margin:0">${esc(entry.journal || '')}${entry.journal ? ' · ' : ''}<span class="mono">${esc(id)}</span></p>
        <div class="bar"><div id="pBar" style="width:3%"></div></div>
        <p class="status-msg" id="pMsg">Connecting…</p>
        <ol class="steps" id="pSteps"></ol>
        <p class="progress-note" style="margin-top:18px">A full review usually takes 10–20 minutes. You can close this tab — the review keeps running, and it will be in <a href="#/reviews">My reviews</a> when you return.</p>
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
    const idx = Math.max(0, STAGES.findIndex(s => s[0] === stage));
    const cur = stage === 'error' ? STAGES.findIndex(s => s[2] > (progress || 0)) : idx;
    $('#pSteps').innerHTML = STAGES.map((s, i) => {
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
      ['roadmap', 'Revision roadmap'], ['letter', 'Reviewer letter'], ['checks', 'All checks', findings.length]
    ];
    if (R.integrity) tabs.splice(5, 0, ['originality', 'Originality & AI']);
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
            <span class="mono">${esc(R.review_id || id)}</span><span>${esc(fmtDate(R.generated_at))}</span>
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
      <section class="tab-panel" data-panel="comments" hidden>${viewComments(S)}</section>
      <section class="tab-panel" data-panel="findings" hidden>${viewFindingsShell(actionable)}</section>
      <section class="tab-panel" data-panel="audits" hidden>${viewAudits(R)}</section>
      <section class="tab-panel" data-panel="references" hidden>${viewReferences(R)}</section>
      ${R.integrity ? `<section class="tab-panel" data-panel="originality" hidden>${viewOriginality(R.integrity)}</section>` : ''}
      <section class="tab-panel" data-panel="roadmap" hidden>${viewRoadmap(S, id)}</section>
      <section class="tab-panel" data-panel="letter" hidden>${viewLetter(S)}</section>
      <section class="tab-panel" data-panel="checks" hidden>${viewChecksShell(findings)}</section>`;

    $$('.tabs button').forEach(b => b.addEventListener('click', () => {
      $$('.tabs button').forEach(x => { x.classList.toggle('active', x === b); x.setAttribute('aria-selected', x === b); });
      $$('.tab-panel').forEach(p => { p.hidden = p.dataset.panel !== b.dataset.tab; });
    }));
    wireFindings(actionable, id);
    wireChecks(findings);
    wireRoadmap(id);
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
          <div class="stat"><div class="n">${R.checklist_size || '—'}</div><div class="l">Checks applied</div></div>
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
      <div class="card" style="margin-bottom:16px"><p style="margin:0">Every issue below survived adjudication. Decide what to do with each one — your decisions are saved in this browser and included in <b>Export validations</b>. <span class="muted" id="valProgress"></span></p></div>
      <div class="toolbar">
        <select id="fSev" aria-label="Severity"><option value="">All severities</option><option>CRITICAL</option><option>MAJOR</option><option>MINOR</option><option>INFO</option></select>
        <select id="fDec" aria-label="Decision"><option value="">All decisions</option><option>CONFIRMED</option><option>NEEDS_VERIFICATION</option><option>DISPUTED</option></select>
        <select id="fSec" aria-label="Section"><option value="">All sections</option>${sections.map(s => `<option>${esc(s)}</option>`).join('')}</select>
        <select id="fVal" aria-label="Your decision"><option value="">Any validation</option><option value="none">Not yet validated</option>${VAL.map(v => `<option value="${v[0]}">${v[1]}</option>`).join('')}</select>
        <input type="search" id="fQ" placeholder="Search findings…" aria-label="Search">
      </div>
      <div id="findingList"></div>`;
  }
  function wireFindings(list, id) {
    const vals = store.get('val:' + id, {});
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
      store.set('val:' + id, vals); draw();
    });
    $('#findingList').addEventListener('change', e => {
      if (!e.target.matches('[data-note]')) return;
      const fid = e.target.closest('.finding').dataset.id; vals[fid] = Object.assign(vals[fid] || {}, { note: e.target.value });
      store.set('val:' + id, vals);
    });
    draw();
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

  function viewRoadmap(S, id) {
    const RM = S.revision_roadmap || {};
    const groups = [['priority_1_must_fix', 'Priority 1 — Must fix', 'CRITICAL'], ['priority_2_substantive', 'Priority 2 — Substantive revision', 'MAJOR'], ['priority_3_strengthening', 'Priority 3 — Strengthening', 'MINOR'], ['priority_4_editorial', 'Priority 4 — Editorial', 'INFO']];
    const done = store.get('road:' + id, {});
    return `<div class="card"><p class="muted" style="margin-top:0">Tick items off as you revise — progress is saved in this browser.</p>
      ${groups.map(([k, label, sev]) => `<div class="roadmap-group"><h3><span class="sev sev-${sev}">${sev === 'INFO' ? 'P4' : sev === 'MINOR' ? 'P3' : sev === 'MAJOR' ? 'P2' : 'P1'}</span> ${label}</h3>
        ${arr(RM[k]).length ? arr(RM[k]).map((t, i) => { const key = k + ':' + i; return `<label class="task ${done[key] ? 'done' : ''}"><input type="checkbox" data-road="${key}" ${done[key] ? 'checked' : ''}><span>${esc(t.action)}${arr(t.finding_ids).filter(Boolean).length ? ` <small>[${arr(t.finding_ids).filter(Boolean).map(esc).join(', ')}]</small>` : ''}</span></label>`; }).join('') : '<p class="muted">Nothing in this group.</p>'}</div>`).join('')}
      ${arr(S.cover_letter_tips).length ? `<h3>Cover-letter tips</h3><ul class="clean">${arr(S.cover_letter_tips).map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}</div>`;
  }
  function wireRoadmap(id) {
    $$('[data-road]').forEach(cb => cb.addEventListener('change', () => {
      const done = store.get('road:' + id, {}); done[cb.dataset.road] = cb.checked; store.set('road:' + id, done);
      cb.closest('.task').classList.toggle('done', cb.checked);
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
          <li><div><b>Adaptive checklist</b><span>From a library of 110+ Q1 criteria, only the checks relevant to your design and chosen depth are selected — SEM checks for SEM papers, COREQ/SRQR for qualitative work, PRISMA for reviews.</span></div></li>
          <li><div><b>Seven independent specialist reviewers</b><span>Claude reviewers for theory, method, statistics, literature, integrity, reporting and the editor view work separately (no groupthink), each returning structured findings with verbatim quotes.</span></div></li>
          <li><div><b>Evidence validator</b><span>Each quote is matched against your manuscript. A MAJOR or CRITICAL finding without a verifiable quote is held for human verification instead of being reported as fact.</span></div></li>
          <li><div><b>Rule-based number & language audit</b><span>Deterministic checks for inconsistent sample sizes, p = .000, reliability/validity/fit thresholds, Harman-only CMB, Fornell-Larcker-only validity, causal verbs in cross-sectional designs and missing ethics statements.</span></div></li>
          <li><div><b>Cross-validation engine</b><span>Objective → result tracing, hypothesis ↔ result comparison, table ↔ text and section-to-section contradiction checks.</span></div></li>
          <li><div><b>Reference verification</b><span>References are checked against Crossref for existence, metadata mismatches, missing DOIs and retraction notices; your title is searched for possible prior publication.</span></div></li>
          <li><div><b>Originality & writing screen</b><span>Sampled sentences are searched as exact phrases in OpenAlex and Europe PMC to catch verbatim overlap with published work, and a writing review flags generic, template-like passages and a missing AI-use disclosure. No AI % score is given. An optional Copyleaks integration adds a full similarity percentage and AI detector.</span></div></li>
          <li><div><b>Adjudication & synthesis</b><span>An adjudicator merges duplicates and dismisses findings the manuscript contradicts; Claude Opus writes the final assessment, diagnostic profile, comments, roadmap and reviewer letter.</span></div></li>
          <li><div><b>You decide</b><span>Confirm, modify or reject each finding, tick off the roadmap, and export your validated list.</span></div></li>
        </ol>
        <div class="card" style="margin-top:22px"><h3>Privacy</h3><p style="margin:0">Manuscript text is sent to Google Gemini and Anthropic Claude through your own n8n server, and short sampled phrases are searched in OpenAlex and Europe PMC and stored there (status table, Google Drive report). This site is static: it stores nothing except your access key, review list and validation notes in your own browser. Do not upload manuscripts you received in confidence as a journal reviewer.</p></div>
      </div>`;
  }

  route();
})();
