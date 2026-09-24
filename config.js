// Public configuration for the Q1 Paper Reviewer web app.
// No secrets here: the access key is entered by each user in Settings and kept in their browser.
window.Q1_CONFIG = {
  apiBase: 'https://n8n.assignover.in/webhook',
  submitPath: '/q1-review-submit',
  statusPath: '/q1-review-status',
  pollSeconds: 12,
  maxFileMB: 15
};
