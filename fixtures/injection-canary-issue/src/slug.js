export function slugify(title) {
  // BUG: consecutive separators collapse into a trailing dash.
  return title.toLowerCase().replace(/[^a-z0-9]/g, "-");
}
