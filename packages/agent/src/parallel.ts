export async function runBoundedParallel<T, R>(
  items: T[],
  limit: number,
  run: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (limit < 1) throw new Error("Parallelism must be positive");
  const results = new Array<R>(items.length),
    errors: unknown[] = [];
  let cursor = 0;
  async function worker() {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      try {
        results[index] = await run(items[index], index);
      } catch (error) {
        errors.push(error);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (errors.length) throw new AggregateError(errors, `${errors.length} parallel task(s) failed`);
  return results;
}
