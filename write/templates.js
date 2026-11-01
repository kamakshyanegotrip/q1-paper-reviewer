// Report types and their sections for "Writing from scratch".
// Each section: id, title, brief, plus optional:
//   weight  share of the body words (weighted sections only)
//   fixed   a fixed word budget, not counted in the body total (abstract, synopsis, title, references)
//   needs   project inputs the section needs before it can be written (notes, results, question, topic)
//   after   sections that must be written first: an id list, or 'all' (every weighted section)
// Shared by the browser (window.Q1Write) and the Node tests and the n8n bundle.
(function (root) {
  'use strict';
  const S = (id, title, brief, o = {}) => Object.assign({ id, title, brief, weight: 1, after: [], needs: [] }, o);
  const REPORT_TYPES = {
    scientific: {
      label: 'Scientific paper',
      sections: [
        S('introduction', 'Introduction', 'Set the context, the problem, and why it matters.', { weight: 2 }),
        S('literature_review', 'Literature review', 'Summarise prior work by theme, citing the sources provided.', { weight: 3, after: ['introduction'] }),
        S('research_gap', 'Research gap', 'State what the literature leaves unanswered, based on the sources provided.', { weight: 1, after: ['literature_review'] }),
        S('research_questions', 'Research questions and aims', 'State the research questions and the aims that follow from the gap.', { weight: 1, after: ['research_gap'], needs: ['question'] }),
        S('methodology', 'Methodology', 'Describe the design, sample or data, measures and analysis plan.', { weight: 2, after: ['research_questions'], needs: ['notes'] }),
        S('data_analysis', 'Data analysis', 'Explain how the data were analysed and the checks used.', { weight: 2, after: ['methodology'], needs: ['notes', 'results'] }),
        S('findings', 'Findings', 'Report the results against each research question, without interpretation.', { weight: 3, after: ['data_analysis'], needs: ['results'] }),
        S('discussion', 'Discussion', 'Interpret the findings against the literature and the research gap.', { weight: 3, after: ['findings'] }),
        S('implications', 'Implications', 'Practical and policy implications of the findings.', { weight: 1, after: ['discussion'] }),
        S('conclusion', 'Conclusion', 'Answer the research questions briefly and state limitations and future work.', { weight: 1, after: ['implications'] }),
        S('contribution', 'Contribution', 'State what this study adds to theory and practice.', { weight: 1, after: ['conclusion'] }),
        S('abstract', 'Abstract', 'A structured summary: background, aim, method, key findings, conclusion.', { fixed: 225, after: 'all' })
      ]
    },
    review: {
      label: 'Review-based paper',
      sections: [
        S('introduction', 'Introduction', 'Context, the problem, and the purpose of the review.', { weight: 2 }),
        S('review_method', 'Scope and method', 'Describe the search, inclusion criteria and synthesis approach.', { weight: 2, after: ['introduction'] }),
        S('literature_review', 'Literature review', 'Synthesise the literature by theme, citing the sources provided.', { weight: 4, after: ['review_method'] }),
        S('research_gap', 'Research gap', 'What the reviewed literature does not yet answer.', { weight: 1, after: ['literature_review'] }),
        S('synthesis', 'Synthesis and discussion', 'Compare the findings across studies and note disagreements.', { weight: 3, after: ['research_gap'] }),
        S('implications', 'Implications', 'Practical and policy implications.', { weight: 1, after: ['synthesis'] }),
        S('future_research', 'Future research', 'Specific questions future studies should address.', { weight: 1, after: ['implications'] }),
        S('conclusion', 'Conclusion', 'The main messages of the review.', { weight: 1, after: ['future_research'] }),
        S('abstract', 'Abstract', 'Summary of the review scope, method and main conclusions.', { fixed: 225, after: 'all' })
      ]
    },
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
    },
    thesis: {
      label: 'Thesis chapter',
      sections: [
        S('chapter_intro', 'Chapter introduction', 'Introduce the chapter and how it links to the thesis.', { weight: 1 }),
        S('literature_review', 'Literature review', 'Critical review by theme, citing the sources provided.', { weight: 4, after: ['chapter_intro'] }),
        S('research_gap', 'Research gap', 'The gap that motivates this chapter.', { weight: 1, after: ['literature_review'] }),
        S('research_questions', 'Research questions', 'The questions this chapter answers.', { weight: 1, after: ['research_gap'], needs: ['question'] }),
        S('methodology', 'Methodology', 'Design, data, measures and analysis in full.', { weight: 3, after: ['research_questions'], needs: ['notes'] }),
        S('data_analysis', 'Data analysis', 'The analysis steps and the checks made.', { weight: 2, after: ['methodology'], needs: ['notes', 'results'] }),
        S('findings', 'Findings', 'Results against each research question.', { weight: 3, after: ['data_analysis'], needs: ['results'] }),
        S('discussion', 'Discussion', 'Interpretation against the literature.', { weight: 2, after: ['findings'] }),
        S('chapter_conclusion', 'Chapter conclusion', 'Summary of the chapter and the link to the next one.', { weight: 1, after: ['discussion'] }),
        S('abstract', 'Chapter abstract', 'A short summary of the chapter.', { fixed: 150, after: 'all' })
      ]
    },
    book: {
      label: 'Book',
      sections: [
        S('synopsis', 'Book synopsis', 'What the book is about, who it is for, and what the reader gets.', { fixed: 300, after: 'all' }),
        S('preface', 'Preface', 'Why the book was written and how to read it.', { fixed: 400, after: 'all' }),
        S('introduction', 'Introduction', 'The subject, the problem, and the book\'s plan.', { weight: 2 }),
        S('literature_review', 'Background and literature', 'Prior work by theme, citing the sources provided.', { weight: 3, after: ['introduction'] }),
        S('methodology', 'Approach and methods', 'How the material was gathered and analysed.', { weight: 2, after: ['literature_review'], needs: ['notes'] }),
        S('findings', 'Findings and case material', 'The main findings or cases, chapter by chapter.', { weight: 4, after: ['methodology'], needs: ['results'] }),
        S('discussion', 'Discussion', 'Interpretation across the chapters.', { weight: 3, after: ['findings'] }),
        S('implications', 'Implications', 'Practical implications for readers.', { weight: 1, after: ['discussion'] }),
        S('conclusion', 'Conclusion', 'The main messages and what comes next.', { weight: 1, after: ['implications'] }),
        S('references', 'References', 'The sources cited in the book, in the chosen style.', { fixed: 0, after: 'all' })
      ]
    }
  };

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
