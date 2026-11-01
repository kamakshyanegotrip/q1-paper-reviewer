// Article, thesis and book formats, from the Academic writing reference documents
// (Empirical Research Article Formats, Review Research Article Formats, Case Study Research Article
// Formats, Thesis and Dissertation Formats, Academic Book Formats). Each format lists its sections in order.
// Weights, required inputs and dependencies are inferred from each section title (see classify).
(function (root) {
  'use strict';

  const EMP_QUANT = ['Introduction and research questions', 'Literature review, conceptual framework and hypotheses', 'Research design and data', 'Measures/variables and estimation strategy', 'Data quality and assumption checks', 'Results and robustness/sensitivity analysis', 'Discussion', 'Conclusion, limitations and implications'];
  const EMP_QUAL = ['Introduction and research questions', 'Literature and interpretive lens', 'Research paradigm, setting and researcher positionality', 'Participant/case selection and recruitment', 'Data generation and ethics', 'Analytic procedures and reflexivity', 'Findings with evidence excerpts', 'Discussion and theoretical/practical contribution', 'Limitations and conclusion'];
  const EMP_MIXED = ['Introduction and integrated research question', 'Theoretical/conceptual background', 'Mixed-methods rationale and design', 'Quantitative strand (sampling, instruments, analysis)', 'Qualitative strand (sampling, data collection, analysis)', 'Point(s) of integration and joint displays', 'Quantitative and qualitative results', 'Integrated meta-inferences, convergence/divergence', 'Discussion, limitations and conclusion'];

  // The 30 empirical designs. Each design shares its approach's section list (per the source document).
  const EMP_DESIGNS = {
    quant: [['q1', 'Q1 Cross-sectional survey'], ['q2', 'Q2 Longitudinal panel study'], ['q3', 'Q3 Repeated cross-sectional study'], ['q4', 'Q4 Randomized controlled experiment'], ['q5', 'Q5 Quasi-experimental study'], ['q6', 'Q6 Correlational / predictive study'], ['q7', 'Q7 Structural equation modeling study'], ['q8', 'Q8 Multilevel / hierarchical study'], ['q9', 'Q9 Time-series / forecasting study'], ['q10', 'Q10 Econometric secondary-data study'], ['q11', 'Q11 Choice experiment / conjoint study'], ['q12', 'Q12 Scale development and validation'], ['q13', 'Q13 Quantitative content analysis'], ['q14', 'Q14 Spatial / GIS empirical study'], ['q15', 'Q15 Machine-learning predictive study']],
    qual: [['ql1', 'QL1 Phenomenology'], ['ql2', 'QL2 Grounded theory'], ['ql3', 'QL3 Ethnography'], ['ql4', 'QL4 Narrative inquiry'], ['ql5', 'QL5 Qualitative case study'], ['ql6', 'QL6 Multiple-case qualitative study'], ['ql7', 'QL7 Qualitative descriptive study'], ['ql8', 'QL8 Reflexive thematic analysis'], ['ql9', 'QL9 Discourse / critical discourse analysis'], ['ql10', 'QL10 Participatory action research']],
    mixed: [['mm1', 'MM1 Convergent parallel design'], ['mm2', 'MM2 Explanatory sequential design'], ['mm3', 'MM3 Exploratory sequential design'], ['mm4', 'MM4 Embedded mixed-methods design'], ['mm5', 'MM5 Multiphase mixed-methods design']]
  };

  const REVIEW = {
    narrative: ['Introduction', 'Review approach and source selection', 'Thematic literature review', 'Critical synthesis', 'Research directions', 'Conclusion'],
    systematic: ['Introduction and review questions', 'Protocol and search', 'Eligibility and screening', 'Data extraction and quality appraisal', 'Evidence synthesis', 'Results', 'Discussion', 'Conclusion'],
    scoping: ['Introduction', 'PCC question', 'Search and screening', 'Data charting', 'Evidence map', 'Thematic results', 'Discussion', 'Conclusion'],
    bibliometric: ['Introduction', 'Database/search/data cleaning', 'Performance analysis', 'Citation and collaboration networks', 'Co-word and thematic evolution', 'Discussion', 'Conclusion'],
    meta_analysis: ['Introduction', 'Systematic search', 'Effect-size extraction', 'Risk of bias', 'Statistical models', 'Heterogeneity', 'Moderator and sensitivity analyses', 'Discussion', 'Conclusion'],
    qualitative_synthesis: ['Introduction', 'Search and selection', 'Qualitative appraisal', 'Coding', 'Descriptive and analytical themes', 'Interpretive model', 'Discussion', 'Conclusion'],
    integrative: ['Introduction', 'Integrative search and evaluation', 'Data reduction', 'Conceptual and empirical synthesis', 'Integrated framework', 'Discussion', 'Conclusion'],
    critical: ['Introduction', 'Literature selection and critique criteria', 'Strengths and weaknesses', 'Contradictions', 'Alternative framework', 'Discussion', 'Conclusion'],
    theoretical: ['Introduction', 'Theory selection', 'Individual theory analyses', 'Comparative evaluation', 'Theoretical integration', 'Propositions', 'Conclusion'],
    conceptual: ['Introduction', 'Concept identification', 'Definitions and dimensions', 'Existing model comparison', 'Framework development', 'Propositions', 'Implications', 'Conclusion'],
    umbrella: ['Introduction', 'Review-level search and eligibility', 'Quality appraisal', 'Overlap assessment', 'Findings across reviews', 'Certainty', 'Discussion', 'Conclusion'],
    rapid: ['Introduction', 'Focused questions', 'Streamlined search and screening', 'Appraisal', 'Results', 'Decision implications', 'Shortcuts and limitations', 'Conclusion'],
    realist: ['Introduction', 'Initial program theory', 'Iterative search', 'Relevance/rigor appraisal', 'CMO analysis', 'Refined theory', 'Implications', 'Conclusion'],
    mapping: ['Introduction', 'Search', 'Eligibility', 'Classification scheme', 'Evidence distribution', 'Clusters and gaps', 'Discussion', 'Conclusion'],
    mixed_methods_sr: ['Introduction', 'Mixed-methods protocol', 'Search', 'Appraisal', 'Quantitative synthesis', 'Qualitative synthesis', 'Integration and joint displays', 'Discussion', 'Conclusion'],
    methodological: ['Introduction', 'Method review criteria', 'Study identification', 'Sampling and instruments', 'Analysis methods', 'Quality trends', 'Recommendations', 'Conclusion'],
    state_of_the_art: ['Introduction', 'Timeframe and scope', 'Current knowledge', 'Recent innovations', 'Emerging frontiers', 'Challenges', 'Discussion', 'Conclusion'],
    systematized: ['Introduction', 'Search and selection', 'Structured synthesis', 'Findings', 'Method limitations', 'Discussion', 'Conclusion'],
    network_meta_analysis: ['Introduction', 'Systematic search', 'Network geometry', 'Direct/indirect estimates', 'Consistency', 'Ranking', 'Discussion', 'Conclusion'],
    living: ['Introduction', 'Protocol', 'Continuous search and update criteria', 'Screening', 'Updated findings', 'Changes since prior version', 'Discussion', 'Conclusion'],
    diagnostic_accuracy: ['Introduction', 'Index/reference tests', 'Search', 'QUADAS appraisal', 'Sensitivity/specificity synthesis', 'Accuracy plots', 'Discussion', 'Conclusion'],
    individual_participant_data: ['Introduction', 'Search and data acquisition', 'Harmonization', 'Participant-level models', 'Results', 'Heterogeneity', 'Discussion', 'Conclusion'],
    critical_interpretive: ['Introduction', 'Iterative search', 'Critical appraisal', 'Synthetic constructs', 'Synthesizing argument', 'Implications', 'Conclusion'],
    meta_ethnography: ['Introduction', 'Focus and study selection', 'Reading studies', 'Relating and translating concepts', 'Line-of-argument synthesis', 'Discussion', 'Conclusion']
  };

  const CASE = {
    descriptive: ['Introduction', 'Literature and concepts', 'Case design and data', 'Case profile', 'Descriptive themes', 'Discussion', 'Conclusion'],
    exploratory: ['Introduction', 'Research questions', 'Exploratory design and sampling', 'Context', 'Inductive themes', 'Emerging propositions', 'Conclusion'],
    explanatory: ['Introduction', 'Theory and propositions', 'Case and evidence design', 'Context', 'Pattern findings', 'Rival explanations', 'Discussion', 'Conclusion'],
    intrinsic: ['Introduction', 'Case significance', 'Context', 'Methodology', 'Interpretive findings', 'Discussion', 'Conclusion'],
    instrumental: ['Introduction', 'Broader issue and theory', 'Case rationale', 'Evidence', 'Case analysis', 'Broader implications', 'Conclusion'],
    single_case: ['Introduction', 'Theory', 'Single-case rationale', 'Methods', 'Case context', 'Within-case findings', 'Discussion', 'Conclusion'],
    multiple_case: ['Introduction', 'Theory', 'Replication-based case selection', 'Methods', 'Case profiles', 'Within-case findings', 'Cross-case synthesis', 'Conclusion'],
    comparative: ['Introduction', 'Comparison framework', 'Case selection', 'Comparable evidence', 'Case profiles', 'Dimension-wise comparison', 'Explanations', 'Conclusion'],
    longitudinal: ['Introduction', 'Temporal theory', 'Period and data', 'Baseline', 'Phases and turning points', 'Change mechanisms', 'Conclusion'],
    embedded: ['Introduction', 'Theory', 'Main case and subunits', 'Methods', 'Subunit findings', 'Integrated case-level analysis', 'Conclusion'],
    historical: ['Introduction', 'Historiography', 'Archival methods', 'Historical background', 'Chronology', 'Turning points', 'Interpretation', 'Conclusion'],
    critical: ['Introduction', 'Critical theory', 'Positionality and methods', 'Case context', 'Institutional findings', 'Critical discussion', 'Conclusion'],
    evaluative: ['Introduction', 'Program background', 'Evaluation criteria', 'Data/methods', 'Implementation', 'Outcomes', 'Recommendations', 'Conclusion'],
    action_research: ['Introduction', 'Practical problem', 'Action research approach', 'Diagnosis', 'Intervention cycles', 'Reflection', 'Evaluation', 'Conclusion'],
    mixed_methods: ['Introduction', 'Theory', 'Case and mixed-methods design', 'Quantitative findings', 'Qualitative themes', 'Integration', 'Discussion', 'Conclusion'],
    theory_building: ['Introduction', 'Theoretical background', 'Case sampling', 'Iterative analysis', 'Patterns', 'Constructs', 'Proposed theory', 'Conclusion'],
    theory_testing: ['Introduction', 'Theory/propositions', 'Operationalization', 'Case evidence', 'Pattern tests', 'Rival explanations', 'Discussion', 'Conclusion'],
    extreme_deviant: ['Introduction', 'Why case is exceptional', 'Theory', 'Methods', 'Exceptional features', 'Mechanisms', 'Implications', 'Conclusion'],
    revelatory: ['Introduction', 'Novel access rationale', 'Theory', 'Data and ethics', 'Context', 'Revelatory findings', 'Implications', 'Conclusion'],
    process_tracing: ['Introduction', 'Causal question', 'Hypothesized mechanism', 'Evidence/tests', 'Chronology', 'Mechanism tests', 'Rival explanations', 'Conclusion']
  };

  const THESIS_STANDARD = ['Introduction', 'Literature review', 'Theoretical and conceptual framework', 'Research methodology', 'Results and analysis', 'Discussion', 'Conclusion'];
  const THESIS = {
    standard: THESIS_STANDARD,
    quantitative: ['Introduction', 'Literature review', 'Theory/hypotheses', 'Methods and measures', 'Data validation', 'Statistical results', 'Discussion', 'Conclusion'],
    qualitative: ['Introduction', 'Literature', 'Paradigm/methodology', 'Context/participants', 'Thematic findings', 'Interpretation', 'Conclusion'],
    mixed_methods: ['Introduction', 'Literature/theory', 'Mixed-methods design', 'Quantitative strand', 'Qualitative strand', 'Integration', 'Discussion', 'Conclusion'],
    experimental: ['Introduction', 'Theory', 'Experimental design', 'Intervention and measurement', 'Results', 'Causal discussion', 'Conclusion'],
    survey: ['Introduction', 'Literature', 'Framework/hypotheses', 'Questionnaire and sampling', 'Data quality', 'Statistical testing', 'Discussion', 'Conclusion'],
    case_study: ['Introduction', 'Literature/theory', 'Case methodology', 'Context', 'Within-case findings', 'Cross-case analysis if applicable', 'Discussion', 'Conclusion'],
    comparative: ['Introduction', 'Literature', 'Comparative framework', 'Case/country selection', 'Profiles', 'Comparative findings', 'Interpretation', 'Conclusion'],
    longitudinal: ['Introduction', 'Literature/temporal framework', 'Longitudinal design', 'Baseline', 'Trends', 'Temporal analysis', 'Discussion', 'Conclusion'],
    systematic_review: ['Introduction', 'Conceptual background', 'Protocol', 'Screening/appraisal', 'Included study profile', 'Evidence synthesis', 'Discussion', 'Conclusion'],
    meta_analysis: ['Introduction', 'Literature', 'Search/selection', 'Effect-size methods', 'Pooled estimates', 'Heterogeneity/moderators', 'Discussion', 'Conclusion'],
    bibliometric: ['Introduction', 'Literature', 'Database/methods', 'Performance analysis', 'Science mapping', 'Thematic evolution', 'Research agenda', 'Conclusion'],
    conceptual_theoretical: ['Introduction', 'Critical literature', 'Theories', 'Philosophical/method foundations', 'Construct analysis', 'Framework development', 'Propositions/evaluation', 'Conclusion'],
    historical: ['Introduction', 'Historiography', 'Source methods', 'Background', 'Chronology', 'Interpretive analysis', 'Discussion', 'Conclusion'],
    policy_analysis: ['Introduction', 'Policy literature', 'Evaluation framework', 'Policy context', 'Implementation/comparison', 'Outcomes', 'Reform framework', 'Conclusion'],
    action_research: ['Introduction', 'Literature', 'Action research design', 'Baseline', 'Intervention cycle 1', 'Later cycles', 'Evaluation', 'Conclusion'],
    design_science: ['Introduction', 'Existing solutions', 'Design science methods', 'Requirements', 'Artifact development', 'Demonstration', 'Evaluation', 'Conclusion'],
    secondary_data: ['Introduction', 'Literature/theory', 'Variables/hypotheses', 'Data/methods', 'Descriptives', 'Statistical models', 'Robustness', 'Discussion', 'Conclusion'],
    article_based: ['General introduction', 'Integrative literature', 'Overall methodology', 'Paper 1', 'Paper 2', 'Paper 3', 'Integrative discussion', 'Overall conclusion'],
    objective_wise: ['Introduction and research objectives', 'Literature review and research gaps', 'Theory and conceptual framework', 'Overall research methodology', 'Findings: objective 1', 'Findings: objective 2', 'Findings: objective 3', 'Findings: objective 4', 'Findings: objective 5', 'Integrated discussion and framework validation', 'Conclusion, contribution and recommendations']
  };

  const BOOK_CHAPTERS = Array.from({ length: 12 }, (_, i) => `Chapter ${i + 1}`);
  const BOOK = ['Preface', 'Introduction'].concat(BOOK_CHAPTERS, ['Conclusion', 'References']);

  // The families and their sub-formats, in the order the page offers them.
  const FAMILIES = [
    { key: 'empirical', label: 'Empirical research article', article: true, subs: [
      ...EMP_DESIGNS.quant.map(([k, l]) => [k, l, EMP_QUANT]),
      ...EMP_DESIGNS.qual.map(([k, l]) => [k, l, EMP_QUAL]),
      ...EMP_DESIGNS.mixed.map(([k, l]) => [k, l, EMP_MIXED])] },
    { key: 'review', label: 'Review-based article', article: true, subs: Object.entries(REVIEW).map(([k, v]) => [k, k.replace(/_/g, ' '), v]) },
    { key: 'case', label: 'Case study article', article: true, subs: Object.entries(CASE).map(([k, v]) => [k, k.replace(/_/g, ' '), v]) },
    { key: 'thesis', label: 'Thesis or dissertation', article: false, subs: Object.entries(THESIS).map(([k, v]) => [k, k.replace(/_/g, ' '), v]) },
    { key: 'book', label: 'Academic book', article: false, subs: [['authored', 'Authored or edited book', BOOK], ['textbook', 'Textbook', BOOK], ['monograph', 'Research monograph', BOOK], ['reference', 'Reference book or handbook', BOOK]] }
  ];

  // Infers a section's word budget and inputs from its title.
  function classify(title) {
    const t = title.toLowerCase();
    if (/^abstract/.test(t)) return { fixed: 225, after: 'all' };
    if (/^references|^appendi|^declaration|supplementary/.test(t)) return { fixed: 0, after: 'all' };
    if (/^preface|^foreword/.test(t)) return { fixed: 400, after: 'all' };
    let weight = 1, needs = [];
    if (/implication/.test(t)) weight = 1;
    else if (/introduction|background|context|problem|objective/.test(t)) weight = 2;
    else if (/literature|theor|framework|hypothes|proposition|conceptual|construct|interpretive lens/.test(t)) weight = 3;
    else if (/discussion|interpretation|synthesis|integration|reflexivity/.test(t)) weight = 3;
    else if (/result|finding|outcome|statistic|pooled|theme|analysis|evidence|effect|heterogeneity|accuracy|ranking|map|charting|appraisal|coding/.test(t)) weight = 2;
    if (/result|finding|outcome|statistic|pooled|theme|within|cross-case|accuracy|ranking|updated|evidence excerpt|analysis/.test(t) && !/^introduction/.test(t)) needs = ['results'];
    if (/method|design|sampl|measure|instrument|data|protocol|search|screen|select|participant|paradigm|setting|strand|eligib|strategy|recruit|case/.test(t) && !/implication|discussion|finding|result/.test(t)) needs = needs.concat(['notes']);
    if (/conclusion|recommend|future|limitation|shortcut/.test(t)) weight = 1;
    return { weight, needs: [...new Set(needs)] };
  }

  // Section id: the title up to its first qualifier, so "Literature review, conceptual framework" -> literature_review.
  function idOf(title, taken) {
    const base = title.toLowerCase().split(/,| and | with | \(|:|\/| for |;/)[0].trim().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'section';
    let id = base, n = 2;
    while (taken.has(id)) id = base + '_' + (n++);
    taken.add(id);
    return id;
  }

  function buildSections(titles, article) {
    const taken = new Set();
    const list = titles.map(title => {
      const c = classify(title);
      const id = idOf(title, taken);
      return Object.assign({ id, title, brief: title + ', as the chosen format sets it out.', weight: c.weight || 1, after: [], needs: c.needs || [] },
        c.fixed != null ? { fixed: c.fixed, after: 'all', weight: 1 } : {}, c.after && c.fixed == null ? { after: c.after } : {});
    });
    // Each body section waits for the one before it; the abstract, references and preface wait for the body.
    list.forEach((s, i) => {
      if (s.after === 'all') return;
      s.after = i > 0 && list.slice(0, i).some(x => x.fixed == null) ? [list.slice(0, i).filter(x => x.fixed == null).pop().id] : [];
    });
    if (article && !list.some(s => s.id === 'abstract')) {
      list.push({ id: 'abstract', title: 'Abstract', brief: 'A structured summary of the article: background, aim, method, key findings, conclusion.', weight: 1, fixed: 225, after: 'all', needs: [] });
    }
    if (!list.some(s => s.id === 'references')) {
      list.push({ id: 'references', title: 'References', brief: 'The sources cited in this document, in the chosen style.', weight: 1, fixed: 0, after: 'all', needs: [] });
    }
    return list;
  }

  function buildTypes() {
    const types = {};
    for (const fam of FAMILIES) {
      for (const [key, label, titles] of fam.subs) {
        types[fam.key + ':' + key] = { label: fam.label + ': ' + label, family: fam.key, familyLabel: fam.label, sections: buildSections(titles, fam.article) };
      }
    }
    return types;
  }

  const api = { FAMILIES, buildTypes, classify, buildSections };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.Q1Formats = api;
})(typeof window !== 'undefined' ? window : globalThis);
