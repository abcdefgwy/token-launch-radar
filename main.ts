/**
 * Token Launch Radar CLI 入口
 * 用法：node --experimental-strip-types main.ts --input <file|dir> --output <dir>
 */

import { copyFileSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardIssue, buildRadar, dataScript, parseSnapshot } from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

interface CliOptions {
  inputPath: string;
  outputDir: string;
}

/** 解析命令行参数与环境变量，返回规范化后的输入文件路径与输出目录 */
function parseArgs(argv: string[]): CliOptions {
  let inputArg = '/input/snapshot.json';
  let outputArg = process.env.MAKEFUN_OUTPUT_DIR || '/output';

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--input' && i + 1 < argv.length) {
      inputArg = argv[++i]!;
    } else if (arg === '--output' && i + 1 < argv.length) {
      outputArg = argv[++i]!;
    }
  }

  let resolvedInput = resolve(inputArg);
  if (statSync(resolvedInput).isDirectory()) {
    resolvedInput = join(resolvedInput, 'snapshot.json');
  }

  return {
    inputPath: resolvedInput,
    outputDir: resolve(outputArg),
  };
}

/** 递归复制目录下所有非隐藏文件（按文件名排序以确保确定性） */
function copyDirContents(srcDir: string, destDir: string): number {
  mkdirSync(destDir, { recursive: true });
  let count = 0;
  const entries = readdirSync(srcDir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name)
  );
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const srcPath = join(srcDir, entry.name);
    const destPath = join(destDir, entry.name);
    if (entry.isDirectory()) {
      count += copyDirContents(srcPath, destPath);
    } else if (entry.isFile()) {
      copyFileSync(srcPath, destPath);
      count++;
    }
  }
  return count;
}

/** 执行雷达数据构建、静态资源复制与 dossier.json 打包 */
function run(): void {
  const { inputPath, outputDir } = parseArgs(process.argv.slice(2));
  const rootDir = dirname(fileURLToPath(import.meta.url));

  const rawJson = JSON.parse(readFileSync(inputPath, 'utf8'));
  const snapshot = parseSnapshot(rawJson);
  const radar = buildRadar(snapshot);

  mkdirSync(outputDir, { recursive: true });

  // 1. 写入 board.json 与 data.js
  writeFileSync(join(outputDir, 'board.json'), JSON.stringify(boardIssue(radar), null, 2), 'utf8');
  writeFileSync(join(outputDir, 'data.js'), dataScript(radar), 'utf8');

  // 2. 复制 dashboard/* 与 screenshots/* 到输出目录
  const dashCount = copyDirContents(join(rootDir, 'dashboard'), join(outputDir, 'dashboard'));
  const shotCount = copyDirContents(join(rootDir, 'screenshots'), join(outputDir, 'screenshots'));

  // 3. 构建并写入 dossier.json
  const dossierBytes = buildDossier(outputDir, {
    text_max_bytes: 65536,
    screenshots: { max: 4, max_bytes: 524288 },
    dashboard: { max_files: 400, max_bytes: 4194304 },
  });
  writeFileSync(join(outputDir, 'dossier.json'), dossierBytes);

  console.log(
    `[token-radar] Built ${radar.rows.length} ranked rows (watchlist ${radar.summary.watchlist_covered}/${radar.summary.watchlist_total}), copied ${dashCount} dashboard files and ${shotCount} screenshots -> ${outputDir}`
  );
}

run();
