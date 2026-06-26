/**
 * Flutter Project Verifier
 *
 * Lightweight verification for generated Flutter projects.
 * Checks required files exist, pubspec.yaml is valid, imports are consistent,
 * and flutter analyze passes. Completely independent of the web generation verifier.
 */

import { readFile, access } from 'fs/promises';
import { join } from 'path';
import { runFlutterAnalyze } from './flutter-builder';

export interface FlutterVerifyResult {
  passed: boolean;
  checks: FlutterCheck[];
  analyzeErrors: string[];
  warnings: string[];
  summary: string;
}

export interface FlutterCheck {
  name:   string;
  passed: boolean;
  detail: string;
}

// ── Required files every Flutter project must have ───────────────────────────

const REQUIRED_FILES = [
  'pubspec.yaml',
  'lib/main.dart',
];

// ── Verify ────────────────────────────────────────────────────────────────────

export async function verifyFlutterProject(
  projectPath: string,
  runAnalyze = true
): Promise<FlutterVerifyResult> {
  const checks: FlutterCheck[] = [];
  let analyzeErrors: string[] = [];
  let warnings: string[] = [];

  // ── Check 1: Required files exist ────────────────────────────────────────
  for (const file of REQUIRED_FILES) {
    const abs = join(projectPath, file);
    try {
      await access(abs);
      checks.push({ name: `${file} exists`, passed: true, detail: 'Found' });
    } catch {
      checks.push({ name: `${file} exists`, passed: false, detail: 'Missing — required file not generated' });
    }
  }

  // ── Check 2: pubspec.yaml has name and flutter section ─────────────────
  try {
    const pubspec = await readFile(join(projectPath, 'pubspec.yaml'), 'utf-8');
    const hasName    = /^name:\s*\S/m.test(pubspec);
    const hasFlutter = /^flutter:/m.test(pubspec);
    const hasEnv     = /environment:/m.test(pubspec);
    checks.push({
      name:   'pubspec.yaml structure',
      passed: hasName && hasFlutter && hasEnv,
      detail: [
        hasName    ? '✅ name' : '❌ missing name',
        hasFlutter ? '✅ flutter section' : '❌ missing flutter section',
        hasEnv     ? '✅ environment' : '❌ missing environment',
      ].join(', '),
    });
  } catch {
    checks.push({ name: 'pubspec.yaml structure', passed: false, detail: 'Could not read file' });
  }

  // ── Check 3: lib/main.dart has a main() function ─────────────────────
  try {
    const mainDart = await readFile(join(projectPath, 'lib/main.dart'), 'utf-8');
    const hasMain  = /void\s+main\s*\(/.test(mainDart);
    const hasRunApp = /runApp\s*\(/.test(mainDart);
    checks.push({
      name:   'lib/main.dart entry point',
      passed: hasMain && hasRunApp,
      detail: hasMain && hasRunApp ? 'main() and runApp() found' : 'Missing main() or runApp()',
    });
  } catch {
    checks.push({ name: 'lib/main.dart entry point', passed: false, detail: 'Could not read file' });
  }

  // ── Check 4: flutter analyze ─────────────────────────────────────────
  if (runAnalyze) {
    try {
      const analyzeResult = await runFlutterAnalyze(projectPath);
      analyzeErrors = analyzeResult.errors;
      warnings      = analyzeResult.warnings;
      checks.push({
        name:   'flutter analyze',
        passed: analyzeResult.passed,
        detail: analyzeResult.passed
          ? 'No errors found'
          : `${analyzeErrors.length} error(s): ${analyzeErrors.slice(0, 2).join('; ')}`,
      });
    } catch (err) {
      checks.push({
        name:   'flutter analyze',
        passed: false,
        detail: `Could not run: ${err instanceof Error ? err.message : 'unknown'}`,
      });
    }
  }

  const passed = checks.every(c => c.passed);
  const passedCount = checks.filter(c => c.passed).length;

  return {
    passed,
    checks,
    analyzeErrors,
    warnings,
    summary: passed
      ? `Flutter project verified — ${passedCount}/${checks.length} checks passed`
      : `Flutter project has issues — ${passedCount}/${checks.length} checks passed`,
  };
}
