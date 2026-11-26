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

/** Files checked in full: the contract files (no opt-in region; they hold types and assertions only). */
const WHOLE_FILES = new Set(['read-block-contract.js', 'unified-contracts-check.js'].map((name) => path.join(__dirname, name)));
const isWhole = (file) => file.isDeclarationFile || WHOLE_FILES.has(path.resolve(file.fileName));

/** @param {string} name a tsconfig in the repo root @returns {{ program: import('typescript').Program, errors: readonly import('typescript').Diagnostic[] } | null} */
function load(name) {
  const config = ts.getParsedCommandLineOfConfigFile(path.join(root, name), {}, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: report,
  });
  if (!config) return null;
  const program = ts.createProgram(config.fileNames, config.options);
  return {
    program,
    errors: [
      ...config.errors,
      ...program.getOptionsDiagnostics(),
      ...program.getGlobalDiagnostics(),
    ],
  };
}

/** tsconfig.check.json: every listed file's opt-in regions (the contract files in full). */
function checkRegions() {
  const loaded = load('tsconfig.check.json');
  if (!loaded) return;
  const { program } = loaded;
  const diagnostics = [...loaded.errors, ...program.getSyntacticDiagnostics()];
  for (const file of program.getRootFileNames().map((name) => program.getSourceFile(name)).filter(Boolean)) {
    const errors = program.getSemanticDiagnostics(file);
    if (isWhole(file)) {
      diagnostics.push(...errors);
    } else {
      const lines = checkedLines(file);
      diagnostics.push(...errors.filter(({ start }) =>
        start === undefined || lines.has(file.getLineAndCharacterOfPosition(start).line)));
    }
  }
  diagnostics.forEach(report);
}

/**
 * tsconfig.contracts.json: the unified viewer's contracts across files. Imports resolve here, so
 * tools/unified-contracts-check.js sees each module's real exported types and holds them to
 * media/unified-contracts.d.ts. Only the contract files' own errors count: the modules it pulls in are checked by
 * their regions above, not in full under this program's `strict`.
 */
function checkContracts() {
  const loaded = load('tsconfig.contracts.json');
  if (!loaded) return;
  const { program } = loaded;
  const diagnostics = [...loaded.errors];
  for (const file of program.getRootFileNames().map((name) => program.getSourceFile(name)).filter(Boolean)) {
    diagnostics.push(...program.getSyntacticDiagnostics(file), ...program.getSemanticDiagnostics(file));
  }
  diagnostics.forEach(report);
}

function main() {
  checkRegions();
  checkContracts();
}

function report(diagnostic) {
  process.stderr.write(ts.formatDiagnostic(diagnostic, format));
  process.exitCode = 1;
}

main();
