// Test-only loader: exercise real TSX pages/routes without a Next server or build.
import { readFile, access } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
const root = new URL('../../', import.meta.url);
export async function resolve(specifier, context, nextResolve) {
  if (['next/server', 'next/link', 'next/navigation', 'next/image', 'next/headers'].includes(specifier)) {
    return nextResolve(specifier + '.js', context);
  }
  if (specifier.startsWith('@/') || specifier.startsWith('.')) {
    const url = specifier.startsWith('@/') ? new URL(specifier.slice(2), root) : new URL(specifier, context.parentURL);
    if (!/\.[a-z]+$/.test(url.pathname)) {
      for (const extension of ['.ts', '.tsx']) {
        const candidate = url.href + extension;
        try { await access(fileURLToPath(candidate)); return { url: candidate, shortCircuit: true }; } catch {}
      }
    }
  }
  return nextResolve(specifier, context);
}
export async function load(url, context, nextLoad) {
  if (/\.tsx?$/.test(new URL(url).pathname) && !url.includes('/node_modules/')) {
    const source = await readFile(fileURLToPath(url), 'utf8');
    return { format: 'module', shortCircuit: true, source: ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX },
      fileName: fileURLToPath(url),
    }).outputText };
  }
  return nextLoad(url, context);
}
