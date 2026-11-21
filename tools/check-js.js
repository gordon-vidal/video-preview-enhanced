'use strict';

const path = require('node:path');
const ts = require('typescript');

const root = path.join(__dirname, '..');
const format = {
  getCanonicalFileName: (file) => file,
  getCurrentDirectory: () => root,
  getNewLine: () => '\n',
};

// checkJs is file-wide. Keep semantic errors outside the opt-in regions out of CI
// while TypeScript still infers types from the real surrounding code.
function checkedLines(file) {
  const lines = new Set();
  let active = false;
  for (const [index, line] of file.text.split(/\r?\n/).entries()) {
    const marker = /^\s*\/\/ checkJs: (start|end)\s*$/.exec(line);
    if (!marker) {
      if (active) lines.add(index);
      continue;
    }
    if (active === (marker[1] === 'start')) throw new Error(`Unpaired checkJs marker in ${file.fileName}`);
    active = !active;
  }
  if (active || !lines.size) throw new Error(`Missing checkJs region in ${file.fileName}`);
  return lines;
}

function main() {
  const config = ts.getParsedCommandLineOfConfigFile(path.join(root, 'tsconfig.check.json'), {}, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: report,
  });
  if (!config) return;

  const program = ts.createProgram(config.fileNames, config.options);
  const diagnostics = [
    ...config.errors,
    ...program.getOptionsDiagnostics(),
    ...program.getGlobalDiagnostics(),
    ...program.getSyntacticDiagnostics(),
  ];
  for (const file of program.getRootFileNames().map((name) => program.getSourceFile(name)).filter(Boolean)) {
    const errors = program.getSemanticDiagnostics(file);
    if (path.resolve(file.fileName) === path.join(__dirname, 'read-block-contract.js')) {
      diagnostics.push(...errors);
    } else {
      const lines = checkedLines(file);
      diagnostics.push(...errors.filter(({ start }) =>
        start === undefined || lines.has(file.getLineAndCharacterOfPosition(start).line)));
    }
  }
  diagnostics.forEach(report);
}

function report(diagnostic) {
  process.stderr.write(ts.formatDiagnostic(diagnostic, format));
  process.exitCode = 1;
}

main();
