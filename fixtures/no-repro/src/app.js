export function render(items) {
  return items.map((item) => `<li>${item}</li>`).join("");
}
