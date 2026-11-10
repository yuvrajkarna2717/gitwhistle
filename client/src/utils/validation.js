export function validateWorkspaceName(name) {
  const v = name.trim();
  if (v.length < 2) return 'Name must be at least 2 characters';
  if (v.length > 100) return 'Name must be at most 100 characters';
  return null;
}
