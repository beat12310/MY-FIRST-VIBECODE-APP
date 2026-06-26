/**
 * Flutter Project Generator
 *
 * Parses AI-generated Flutter project output and writes Dart files to disk.
 * Output directory: generated-projects/{name}-flutter/
 * Completely separate from project-generator.ts (Next.js) — no shared code.
 */

import { mkdir, writeFile } from 'fs/promises';
import { join, dirname } from 'path';
import { PROJECT_CONFIG } from '@/lib/constants';

export interface FlutterProjectFile {
  path: string;
  content: string;
}

export interface FlutterProjectData {
  projectName: string;
  description: string;
  files: FlutterProjectFile[];
}

const GENERATED_PROJECTS_DIR = join(process.cwd(), PROJECT_CONFIG.GENERATED_PROJECTS_DIR);

// ── Parser ────────────────────────────────────────────────────────────────────
// Uses the same [FILE: path] delimiter format as the web builder so the AI
// doesn't have to learn two different output formats.

export function parseFlutterProjectFormat(text: string): FlutterProjectData | null {
  const startTag = '[START_FLUTTER_PROJECT]';
  const endTag   = '[END_FLUTTER_PROJECT]';

  const startIdx = text.indexOf(startTag);
  if (startIdx === -1) return null;

  const endIdx = text.indexOf(endTag);
  const inner = text.slice(
    startIdx + startTag.length,
    endIdx !== -1 ? endIdx : text.length
  );

  const parts = inner.split(/\[FILE:\s*/);
  const metaBlock = parts[0];

  const nameMatch = metaBlock.match(/^name:\s*(.+)$/m);
  const descMatch = metaBlock.match(/^description:\s*(.+)$/m);

  const projectName = (nameMatch?.[1] ?? '').trim() || 'flutter-app';
  const description = (descMatch?.[1] ?? '').trim();

  const files: FlutterProjectFile[] = [];

  for (let i = 1; i < parts.length; i++) {
    const bracketClose = parts[i].indexOf(']');
    if (bracketClose === -1) continue;

    const filePath    = parts[i].slice(0, bracketClose).trim();
    const fileContent = parts[i].slice(bracketClose + 1).trim();

    if (filePath && fileContent) {
      files.push({ path: filePath, content: fileContent });
    }
  }

  if (files.length === 0) return null;
  return { projectName, description, files };
}

// ── Minimal scaffold fallback ─────────────────────────────────────────────────
// Used when AI generation fails. Produces a skeleton app that compiles.

export function buildFlutterScaffold(projectName: string, description: string): FlutterProjectData {
  const packageName = projectName.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'flutter_app';
  const displayName = projectName.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

  return {
    projectName,
    description,
    files: [
      {
        path: 'pubspec.yaml',
        content: `name: ${packageName}
description: ${description || displayName}
publish_to: 'none'
version: 1.0.0+1

environment:
  sdk: '>=3.0.0 <4.0.0'

dependencies:
  flutter:
    sdk: flutter
  flutter_riverpod: ^2.6.1
  go_router: ^14.8.1
  http: ^1.2.2
  shared_preferences: ^2.3.5

dev_dependencies:
  flutter_test:
    sdk: flutter
  flutter_lints: ^5.0.0

flutter:
  uses-material-design: true
`,
      },
      {
        path: 'lib/main.dart',
        content: `import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:${packageName}/app.dart';

void main() async {
  WidgetsFlutterBinding.ensureInitialized();
  runApp(const ProviderScope(child: MyApp()));
}
`,
      },
      {
        path: 'lib/app.dart',
        content: `import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:${packageName}/router.dart';

class MyApp extends ConsumerWidget {
  const MyApp({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final router = ref.watch(routerProvider);
    return MaterialApp.router(
      title: '${displayName}',
      theme: ThemeData(
        useMaterial3: true,
        colorScheme: ColorScheme.fromSeed(seedColor: Colors.blue),
      ),
      routerConfig: router,
    );
  }
}
`,
      },
      {
        path: 'lib/router.dart',
        content: `import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:${packageName}/screens/home_screen.dart';

final routerProvider = Provider<GoRouter>((ref) {
  return GoRouter(
    initialLocation: '/',
    routes: [
      GoRoute(
        path: '/',
        builder: (context, state) => const HomeScreen(),
      ),
    ],
  );
});
`,
      },
      {
        path: 'lib/screens/home_screen.dart',
        content: `import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

class HomeScreen extends ConsumerWidget {
  const HomeScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('${displayName}'),
        backgroundColor: Theme.of(context).colorScheme.inversePrimary,
      ),
      body: const Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(Icons.smartphone, size: 80, color: Colors.blue),
            SizedBox(height: 24),
            Text(
              '${displayName}',
              style: TextStyle(fontSize: 28, fontWeight: FontWeight.bold),
            ),
            SizedBox(height: 12),
            Text(
              'Your app is being built…',
              style: TextStyle(color: Colors.grey),
            ),
          ],
        ),
      ),
    );
  }
}
`,
      },
      {
        path: 'test/widget_test.dart',
        content: `import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:${packageName}/app.dart';

void main() {
  testWidgets('App renders without crashing', (WidgetTester tester) async {
    await tester.pumpWidget(const ProviderScope(child: MyApp()));
    expect(find.byType(MaterialApp), findsOneWidget);
  });
}
`,
      },
    ],
  };
}

// ── Writer ─────────────────────────────────────────────────────────────────────

export async function generateFlutterProject(
  data: FlutterProjectData,
  onProgress?: (msg: string) => void
): Promise<{ projectPath: string; filesWritten: number; logs: string[] }> {
  const logs: string[] = [];
  const log = (msg: string) => { logs.push(msg); onProgress?.(msg); };

  const safeName = data.projectName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'flutter-app';

  const dirName    = `${safeName}-flutter`;
  const projectPath = join(GENERATED_PROJECTS_DIR, dirName);

  log(`📁 Creating Flutter project directory: ${dirName}`);
  await mkdir(projectPath, { recursive: true });

  let filesWritten = 0;
  const pathsWritten = new Set<string>();

  for (const file of data.files) {
    // Prevent directory traversal
    const safePath = file.path.replace(/\.\./g, '').replace(/^\//, '').trim();
    if (!safePath || pathsWritten.has(safePath)) continue;

    try {
      const abs = join(projectPath, safePath);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, file.content, 'utf-8');
      filesWritten++;
      pathsWritten.add(safePath);
      log(`  ✅ ${safePath}`);
    } catch (err) {
      log(`  ⚠️ ${file.path}: ${err instanceof Error ? err.message : 'write failed'}`);
    }
  }

  log(`\n✅ Flutter project written: ${filesWritten} file(s) → ${dirName}`);
  return { projectPath, filesWritten, logs };
}
