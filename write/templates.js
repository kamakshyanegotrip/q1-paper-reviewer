// Report types and their sections for "Writing from scratch".
// Article, thesis and book formats come from write/formats.js (built from the academic format documents);
// the synopsis / proposal type is kept here.
// Each section: id, title, brief, plus optional:
//   weight  share of the body words (weighted sections only)
//   fixed   a fixed word budget, not counted in the body total (abstract, synopsis, title, references)
//   needs   project inputs the section needs before it can be written (notes, results, question, topic)
//   after   sections that must be written first: an id list, or 'all' (every weighted section)
// Shared by the browser (window.Q1Write) and the Node tests and the n8n bundle.
(function (root) {
  'use strict';
  const S = (id, title, brief, o = {}) => Object.assign({ id, title, brief, weight: 1, after: [], needs: [] }, o);
  const F = (typeof require === 'function') ? require('./formats') : root.Q1Formats;
  const REPORT_TYPES = Object.assign({}, F.buildTypes(), {
    synopsis: {
      label: 'Synopsis / proposal',
      sections: [
        S('title', 'Title', 'A short, specific title for the study.', { fixed: 15, needs: ['question'] }),
        S('background', 'Background', 'The context and why the topic matters.', { weight: 2 }),
        S('problem', 'Research problem', 'The specific problem the study addresses.', { weight: 1, after: ['background'] }),
        S('research_gap', 'Research gap', 'What is missing from the existing literature, based on the sources provided.', { weight: 1, after: ['problem'] }),
        S('objectives', 'Objectives and research questions', 'Numbered objectives and the research questions they answer.', { weight: 1, after: ['research_gap'], needs: ['question'] }),
        S('literature_review', 'Literature review', 'Key prior work by theme, citing the sources provided.', { weight: 3, after: ['objectives'] }),
        S('methodology', 'Methodology', 'Planned design, data sources, sample and analysis.', { weight: 2, after: ['literature_review'], needs: ['notes'] }),
        S('expected_outcomes', 'Expected outcomes', 'What the study is expected to deliver, and for whom.', { weight: 1, after: ['methodology'] }),
        S('timeline', 'Timeline', 'A realistic phase-by-phase plan.', { weight: 1, after: ['expected_outcomes'] }),
        S('contribution', 'Contribution', 'What the study will add.', { weight: 1, after: ['timeline'] }),
        S('references', 'References', 'The sources cited in this document, in the chosen style.', { fixed: 0, after: 'all' })
      ]
    }
  });

  // Builds the text for one section. Earlier sections are passed in so later ones stay consistent.
  function sectionBrief(type, sectionId) {
    const t = REPORT_TYPES[type];
    const s = t && t.sections.find(x => x.id === sectionId);
    return s ? s.brief : '';
  }

  const api = { REPORT_TYPES, sectionBrief };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.Q1Write = api;
})(typeof window !== 'undefined' ? window : globalThis);
