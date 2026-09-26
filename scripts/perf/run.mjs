// scripts/perf/run.mjs — 侦测总入口。
//   node scripts/perf/run.mjs q1            # 只跑问题 1
//   node scripts/perf/run.mjs q1 q2 q3 q4   # 按序跑
//   node scripts/perf/run.mjs all
const CASES = {
  q1: './cases/q1-think.mjs',
  q2: './cases/q2-virtual.mjs',
  q3: './cases/q3-mutation.mjs',
  q4: './cases/q4-memory.mjs',
};
const argv = process.argv.slice(2);
const want = argv.length === 0 || argv.includes('all') ? Object.keys(CASES) : argv.filter((a) => a in CASES);
const out = {};
for (const name of want) {
  const t0 = Date.now();
  process.stdout.write('=== ' + name + ' ... ');
  try {
    const mod = await import(CASES[name]);
    out[name] = await mod[name]();
    process.stdout.write('ok (' + ((Date.now() - t0) / 1000).toFixed(1) + 's)\n');
  } catch (err) {
    out[name] = { error: String((err && err.stack) || err) };
    process.stdout.write('FAILED: ' + err + '\n');
  }
}
console.log(JSON.stringify(out, null, 1));