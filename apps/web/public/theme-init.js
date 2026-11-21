// Apply the saved theme before the first paint (no flash); the app keeps it in sync afterwards.
// Kept as a file (not inline) so a strict Content-Security-Policy keeps working.
try {
  const saved = localStorage.getItem('agent-team:theme');
  const dark =
    saved === 'dark' ||
    (saved !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
} catch {
  // storage blocked: the app falls back to the system preference
}
