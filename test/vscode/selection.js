'use strict';

function selectScenarios(list, grep, sub, failed) {
  const includes = (name, target) => name === target || name.startsWith(target + '/');
  const literal = (re) => re && /^\^([\w/-]+(?:\\\.[\w/-]+)*)(\$?)$/.exec(re.source.replace(/\\\//g, '/'));
  const mightMatch = (base, re) => {
    if (!re) return true;
    const match = literal(re);
    if (match) {
      const target = match[1].replace(/\\\./g, '.');
      return includes(target, base) || (!match[2] && base.startsWith(target));
    }
    const source = re.source.replace(/\\\//g, '/');
    const stepPath = !source.includes('|') && /^\^([\w-]+\/[\w-]+)\/(?![?*+{])/.exec(source);
    return !stepPath || base === stepPath[1];
  };
  return list.flatMap((scenario) => {
    const steps = scenario.steps.flatMap((step) => {
      const base = `${scenario.name}/${step.case}`;
      const targets = failed && failed.filter((name) => includes(base, name) || includes(name, base));
      if (targets && !targets.length) return [];
      const all = !grep || grep.test(scenario.name) || grep.test(base);
      if ((!all && !mightMatch(base, grep)) || !mightMatch(base, sub)) return [];
      const keep = step.only && new RegExp(step.only);
      const drop = step.skip && new RegExp(step.skip);
      const requested = (name) => (all || grep.test(name)) && (!sub || sub.test(name)) &&
        (!targets || targets.some((target) => includes(name, target)));
      const selected = (result) => (!keep || keep.test(result)) && (!drop || !drop.test(result)) &&
        requested(result ? `${base}/${result}` : base);
      const exact = [grep, sub].map(literal).filter((match) => match?.[2])
        .map((match) => match[1].replace(/\\\./g, '.'));
      const expected = [...new Set([...exact, ...(targets || [])])].filter((name) =>
        name.startsWith(base + '/') && requested(name));
      return [{ ...step, selected, expected }];
    });
    return steps.length ? [{ ...scenario, steps }] : [];
  });
}

function collectResults(base, results, selected, expected = []) {
  const kept = results.filter((r) => r.abort || r.skipped || selected(r.name))
    .map((r) => ({ ...r, name: r.name ? `${base}/${r.name}` : base }));
  const ran = new Set(kept.filter((r) => !r.skipped).map((r) => r.name));
  for (const name of expected) {
    if (!ran.has(name)) kept.push({ name, ok: false, problems: ['the selected result did not run'] });
  }
  return kept;
}

function rerunTargets(report) {
  // An aborting error names no check of its own: rerun its case.
  const owner = (r) => (r.abort || /\/error$/.test(r.name) ?r.name.split('/').slice(0, 2).join('/') : r.name.replace(/\/webgl2$/, ''));
  return [...new Set([...(report.unstarted || []), ...report.tests.filter((r) => !r.ok).map(owner)])];
}

function unstartedScenarios(selected, completed) {
  const ran = new Set(completed.map((s) => s.name));
  return selected.filter((s) => !ran.has(s.name)).map((s) => s.name);
}

module.exports = { selectScenarios, collectResults, rerunTargets, unstartedScenarios };
