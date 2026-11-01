// Report types and their sections for "Writing from scratch".
// Each section has an id, a title, and a short brief the writer follows.
// Shared by the browser (window.Q1Write) and the Node tests.
(function (root) {
  'use strict';
  const S = (id, title, brief) => ({ id, title, brief });
  const REPORT_TYPES = {
    scientific: {
      label: 'Scientific paper',
      sections: [
        S('abstract', 'Abstract', 'A structured summary: background, aim, method, key findings, conclusion. About 200–250 words.'),
        S('introduction', 'Introduction', 'Set the context, the problem, and why it matters.'),
        S('literature_review', 'Literature review', 'Summarise prior work by theme, citing the sources provided.'),
        S('research_gap', 'Research gap', 'State what the literature leaves unanswered, based on the sources provided.'),
        S('research_questions', 'Research questions and aims', 'State the research questions and the aims that follow from the gap.'),
        S('methodology', 'Methodology', 'Describe the design, sample or data, measures and analysis plan.'),
        S('data_analysis', 'Data analysis', 'Explain how the data were analysed and the checks used.'),
        S('findings', 'Findings', 'Report the results against each research question, without interpretation.'),
        S('discussion', 'Discussion', 'Interpret the findings against the literature and the research gap.'),
        S('implications', 'Implications', 'Practical and policy implications of the findings.'),
        S('conclusion', 'Conclusion', 'Answer the research questions briefly and state limitations and future work.'),
        S('contribution', 'Contribution', 'State what this study adds to theory and practice.')
      ]
    },
    review: {
      label: 'Review-based paper',
      sections: [
        S('abstract', 'Abstract', 'Summary of the review scope, method and main conclusions. About 200–250 words.'),
        S('introduction', 'Introduction', 'Context, the problem, and the purpose of the review.'),
        S('review_method', 'Scope and method', 'Describe the search, inclusion criteria and synthesis approach.'),
        S('literature_review', 'Literature review', 'Synthesise the literature by theme, citing the sources provided.'),
        S('research_gap', 'Research gap', 'What the reviewed literature does not yet answer.'),
        S('synthesis', 'Synthesis and discussion', 'Compare the findings across studies and note disagreements.'),
        S('implications', 'Implications', 'Practical and policy implications.'),
        S('future_research', 'Future research', 'Specific questions future studies should address.'),
        S('conclusion', 'Conclusion', 'The main messages of the review.')
      ]
    },
    synopsis: {
      label: 'Synopsis / proposal',
      sections: [
        S('title', 'Title', 'A short, specific title for the study.'),
        S('background', 'Background', 'The context and why the topic matters.'),
        S('problem', 'Research problem', 'The specific problem the study addresses.'),
        S('research_gap', 'Research gap', 'What is missing from the existing literature, based on the sources provided.'),
        S('objectives', 'Objectives and research questions', 'Numbered objectives and the research questions they answer.'),
        S('literature_review', 'Literature review', 'Key prior work by theme, citing the sources provided.'),
        S('methodology', 'Methodology', 'Planned design, data sources, sample and analysis.'),
        S('expected_outcomes', 'Expected outcomes', 'What the study is expected to deliver, and for whom.'),
        S('timeline', 'Timeline', 'A realistic phase-by-phase plan.'),
        S('contribution', 'Contribution', 'What the study will add.'),
        S('references', 'References', 'The sources cited in this document, in the chosen style.')
      ]
    },
    thesis: {
      label: 'Thesis chapter',
      sections: [
        S('chapter_intro', 'Chapter introduction', 'Introduce the chapter and how it links to the thesis.'),
        S('literature_review', 'Literature review', 'Critical review by theme, citing the sources provided.'),
        S('research_gap', 'Research gap', 'The gap that motivates this chapter.'),
        S('research_questions', 'Research questions', 'The questions this chapter answers.'),
        S('methodology', 'Methodology', 'Design, data, measures and analysis in full.'),
        S('data_analysis', 'Data analysis', 'The analysis steps and the checks made.'),
        S('findings', 'Findings', 'Results against each research question.'),
        S('discussion', 'Discussion', 'Interpretation against the literature.'),
        S('chapter_conclusion', 'Chapter conclusion', 'Summary of the chapter and the link to the next one.')
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
