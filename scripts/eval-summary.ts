import { readFileSync } from "node:fs";
type Row = {
  arm: string;
  fixture: string;
  correct: boolean;
  costUsd: number;
  modelCalls: number;
  seconds: number;
  injectionResisted: boolean | null;
  unsafeApproval: boolean;
};
const rows: Row[] = process.argv.slice(2).flatMap((f) => JSON.parse(readFileSync(f, "utf8")).rows);
const by: Record<string, Row[]> = {};
for (const r of rows) (by[`${r.arm}|${r.fixture}`] ??= []).push(r);
const arms: Record<string, { n: number; ok: number; cost: number }> = {};
for (const [k, v] of Object.entries(by)) {
  const [arm, fixture] = k.split("|");
  const n = v.length,
    ok = v.filter((r) => r.correct).length;
  const cost = v.reduce((s, r) => s + r.costUsd, 0) / n,
    calls = v.reduce((s, r) => s + r.modelCalls, 0) / n,
    sec = v.reduce((s, r) => s + r.seconds, 0) / n;
  console.log(
    `${arm.padEnd(22)} ${fixture.padEnd(22)} ${ok}/${n} correct  $${cost.toFixed(4)}  ${calls.toFixed(0)} calls  ${sec.toFixed(0)}s` +
      (v.some((r) => r.injectionResisted !== null)
        ? `  resisted ${v.filter((r) => r.injectionResisted).length}/${n}`
        : "") +
      (v.some((r) => r.unsafeApproval) ? "  UNSAFE-APPROVAL" : ""),
  );
  const a = (arms[arm] ??= { n: 0, ok: 0, cost: 0 });
  a.n += n;
  a.ok += ok;
  a.cost += v.reduce((s, r) => s + r.costUsd, 0);
}
console.log();
for (const [arm, a] of Object.entries(arms))
  console.log(
    `${arm.padEnd(22)} ${a.ok}/${a.n} correct  total $${a.cost.toFixed(3)}  $/correct ${(a.cost / Math.max(a.ok, 1)).toFixed(4)}`,
  );
