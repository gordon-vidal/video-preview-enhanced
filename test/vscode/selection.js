'use strict';

function selectScenarios(list, grep, sub, failed) {
  const includes = (name, target) => name === target || name.startsWith(target + '/');
  const literal = (re) => re && /^\^([\w/-]+(?:\\\.[\w/-]+)*)(\$?)$/.exec(re.source.replace(/\\\//g, '/'));
  const mightMatch = (base, re) => {
    if (!re) return true;
    const match = literal(re);
    if (!match) return true;
    const target = match[1].replace(/\\\./g, '.');
    return includes(target, base) || (!match[2] && base.startsWith(target));
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
      const selected = (result) => {
        const name = result ? `${base}/${result}` : base;
        return (!keep || keep.test(result)) && (!drop || !drop.test(result)) &&
          (all || grep.test(name)) && (!sub || sub.test(name)) &&
          (!targets || targets.some((target) => includes(name, target)));
      };
      const exactResult = [grep, sub].some((re) => {
        const match = literal(re);
        return match?.[2] && match[1].replace(/\\\./g, '.').startsWith(base + '/');
      });
      return [{ ...step, selected, expectResult: exactResult || targets?.some((name) => name.startsWith(base + '/')) }];
    });
    return steps.length ? [{ ...scenario, steps }] : [];
  });
}

module.exports = { selectScenarios };
