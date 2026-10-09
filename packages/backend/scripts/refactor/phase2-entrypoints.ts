/**
 * Phase 2 step 2 (constitution X.4): one public entry point per domain.
 *
 * 1. Finds every import of `@app/domains/<d>/<deep path>` from a file outside domain <d>.
 * 2. Generates `libs/domains/<d>/index.ts` that re-exports exactly the symbols used from outside:
 *    `export { … }` for values, `export type { … }` for type-only symbols (isolatedModules),
 *    `export { default as <DeclaredName> }` for default exports (models).
 * 3. Rewrites those imports to `@app/domains/<d>`, merged into one declaration per file
 *    (plus one `import type` declaration if the original was type-only).
 *
 * Deep specifiers it can't express through the barrel (namespace imports, `export *`,
 * `jest.mock()` / `require()` / `import()` strings) are left untouched and listed.
 *
 * Run: TS_NODE_TRANSPILE_ONLY=1 node -r ts-node/register scripts/refactor/phase2-entrypoints.ts [--dry-run]
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';

const BACKEND = path.resolve(__dirname, '../..');
const DOMAINS_DIR = path.join(BACKEND, 'libs/domains');
const DRY = process.argv.includes('--dry-run');
const DEEP = /^@app\/domains\/([a-z0-9-]+)\/(.+)$/;

const configPath = path.join(BACKEND, 'tsconfig.json');
const parsed = ts.parseJsonConfigFileContent(
  ts.readConfigFile(configPath, ts.sys.readFile).config,
  ts.sys,
  BACKEND,
);
const program = ts.createProgram({
  rootNames: parsed.fileNames,
  options: { ...parsed.options, noEmit: true },
});
const checker = program.getTypeChecker();

type Export = {
  exported: string;
  source: string;
  imported: string;
  isValue: boolean;
};
const exportsByDomain = new Map<string, Map<string, Export>>(); // domain → exportedName → Export
const conflicts: string[] = [];
const leftDeep: string[] = [];

const domainOf = (file: string) => {
  const rel = path.relative(DOMAINS_DIR, file);
  return rel.startsWith('..') ? null : rel.split(path.sep)[0];
};

function addExport(domain: string, e: Export) {
  const table = exportsByDomain.get(domain) ?? new Map<string, Export>();
  exportsByDomain.set(domain, table);
  const prev = table.get(e.exported);
  if (prev && (prev.source !== e.source || prev.imported !== e.imported)) {
    conflicts.push(
      `${domain}: '${e.exported}' exported by both ${prev.source} and ${e.source}`,
    );
    return;
  }
  table.set(e.exported, {
    ...e,
    isValue: e.isValue || (prev?.isValue ?? false),
  });
}

function resolveExport(
  moduleSymbol: ts.Symbol,
  name: string,
): ts.Symbol | undefined {
  const sym = checker
    .getExportsOfModule(moduleSymbol)
    .find((s) => s.escapedName === name);
  if (!sym) return undefined;
  return sym.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(sym) : sym;
}

const isValue = (s: ts.Symbol | undefined) =>
  !!s && (s.flags & ts.SymbolFlags.Value) !== 0;

/** Barrel name for a default export. Models get a `Model` suffix: `User` the model and `@User()` the
 *  decorator both live in identity, and the suffix marks model exports as transitional (IX.4). */
function defaultName(moduleSymbol: ts.Symbol, file: string): string {
  const target = resolveExport(moduleSymbol, 'default');
  const decl = target?.declarations?.[0] as ts.NamedDeclaration | undefined;
  const name =
    decl?.name && ts.isIdentifier(decl.name) ? decl.name.text : undefined;
  if (!name)
    throw new Error(
      `${file}: default export has no declared name; can't re-export it from the barrel`,
    );
  const source = decl!.getSourceFile().fileName;
  return source.includes(`${path.sep}infra${path.sep}models${path.sep}`) &&
    !name.endsWith('Model')
    ? `${name}Model`
    : name;
}

type Edit = { start: number; end: number; text: string };
const editsByFile = new Map<string, Edit[]>();

for (const sf of program.getSourceFiles()) {
  if (
    sf.isDeclarationFile ||
    !sf.fileName.startsWith(BACKEND) ||
    sf.fileName.includes('node_modules')
  )
    continue;
  const ownDomain = domainOf(sf.fileName);
  // file → domain → { value specs, type specs, first statement }
  const merged = new Map<
    string,
    { value: string[]; type: string[]; decls: ts.Statement[] }
  >();

  const visitCalls = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      const m = DEEP.exec(node.arguments[0].text);
      if (m && m[1] !== ownDomain)
        leftDeep.push(
          `${path.relative(BACKEND, sf.fileName)}: ${node.expression.getText(sf)}('${node.arguments[0].text}')`,
        );
    }
    ts.forEachChild(node, visitCalls);
  };
  visitCalls(sf);

  for (const stmt of sf.statements) {
    const spec =
      (ts.isImportDeclaration(stmt) || ts.isExportDeclaration(stmt)) &&
      stmt.moduleSpecifier &&
      ts.isStringLiteral(stmt.moduleSpecifier)
        ? stmt.moduleSpecifier
        : null;
    if (!spec) continue;
    const m = DEEP.exec(spec.text);
    if (!m || m[1] === ownDomain) continue;
    const domain = m[1];
    const moduleSymbol = checker.getSymbolAtLocation(spec);
    if (!moduleSymbol)
      throw new Error(`${sf.fileName}: cannot resolve ${spec.text}`);
    const sourceFile =
      (
        moduleSymbol.valueDeclaration ?? moduleSymbol.declarations?.[0]
      )?.getSourceFile().fileName ?? '';
    const source =
      './' +
      path
        .relative(path.join(DOMAINS_DIR, domain), sourceFile)
        .replace(/\.tsx?$/, '');
    const where = path.relative(BACKEND, sf.fileName);

    if (ts.isExportDeclaration(stmt)) {
      if (!stmt.exportClause || !ts.isNamedExports(stmt.exportClause)) {
        leftDeep.push(`${where}: export * from '${spec.text}'`);
        continue;
      }
      const parts = stmt.exportClause.elements.map((el) => {
        const imported = (el.propertyName ?? el.name).text;
        addExport(domain, {
          exported: imported,
          source,
          imported,
          isValue: isValue(resolveExport(moduleSymbol, imported)),
        });
        return el.getText(sf);
      });
      const kw = stmt.isTypeOnly ? 'export type' : 'export';
      editsByFile.set(sf.fileName, [
        ...(editsByFile.get(sf.fileName) ?? []),
        {
          start: stmt.getStart(sf),
          end: stmt.getEnd(),
          text: `${kw} { ${parts.join(', ')} } from '@app/domains/${domain}';`,
        },
      ]);
      continue;
    }

    const clause = (stmt as ts.ImportDeclaration).importClause;
    if (!clause) {
      leftDeep.push(`${where}: import '${spec.text}' (side effect)`);
      continue;
    }
    if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
      leftDeep.push(
        `${where}: import * as ${clause.namedBindings.name.text} from '${spec.text}'`,
      );
      continue;
    }
    const specs: string[] = [];
    if (clause.name) {
      const declared = defaultName(moduleSymbol, where);
      addExport(domain, {
        exported: declared,
        source,
        imported: 'default',
        isValue: isValue(resolveExport(moduleSymbol, 'default')),
      });
      specs.push(
        declared === clause.name.text
          ? declared
          : `${declared} as ${clause.name.text}`,
      );
    }
    if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const el of clause.namedBindings.elements) {
        const imported = (el.propertyName ?? el.name).text;
        let exported = imported;
        if (imported === 'default') exported = defaultName(moduleSymbol, where);
        addExport(domain, {
          exported,
          source,
          imported,
          isValue: isValue(resolveExport(moduleSymbol, imported)),
        });
        const local = el.name.text;
        specs.push(
          `${el.isTypeOnly ? 'type ' : ''}${exported === local ? exported : `${exported} as ${local}`}`,
        );
      }
    }
    const bucket = merged.get(domain) ?? { value: [], type: [], decls: [] };
    merged.set(domain, bucket);
    (clause.isTypeOnly ? bucket.type : bucket.value).push(...specs);
    bucket.decls.push(stmt);
  }

  for (const [domain, b] of merged) {
    const lines: string[] = [];
    if (b.value.length)
      lines.push(
        `import { ${[...new Set(b.value)].join(', ')} } from '@app/domains/${domain}';`,
      );
    if (b.type.length)
      lines.push(
        `import type { ${[...new Set(b.type)].join(', ')} } from '@app/domains/${domain}';`,
      );
    const edits = editsByFile.get(sf.fileName) ?? [];
    b.decls.forEach((d, i) => {
      // Remove later declarations including their line break; replace the first with the merged one.
      const end =
        i === 0
          ? d.getEnd()
          : d.getEnd() + (sf.text[d.getEnd()] === '\n' ? 1 : 0);
      edits.push({
        start: d.getStart(sf),
        end,
        text: i === 0 ? lines.join('\n') : '',
      });
    });
    editsByFile.set(sf.fileName, edits);
  }
}

if (conflicts.length) {
  console.error(
    'Name conflicts (fix before generating barrels):\n  ' +
      [...new Set(conflicts)].join('\n  '),
  );
  process.exit(1);
}

// Barrels.
const INDEX_HEADER = (d: string) => `/**
 * Public entry point of the \`${d}\` domain (constitution X.4). Code outside this domain imports only
 * from \`@app/domains/${d}\`. Generated from actual cross-domain usage in Phase 2 (later batches append); extend
 * it by hand when a new export is needed. Models exported here are transitional (IX.4 debt): other
 * domains must stop injecting them.
 */
`;
/** Names an existing barrel already exports: later batches append to it instead of regenerating it. */
function existingExports(indexFile: string): Set<string> {
  const sf = program.getSourceFile(indexFile);
  const sym = sf && checker.getSymbolAtLocation(sf);
  return new Set(sym ? checker.getExportsOfModule(sym).map((s) => s.name) : []);
}

for (const domain of fs.readdirSync(DOMAINS_DIR)) {
  const file = path.join(DOMAINS_DIR, domain, 'index.ts');
  const exists = fs.existsSync(file);
  const already = exists ? existingExports(file) : new Set<string>();
  const table = new Map(
    [...(exportsByDomain.get(domain) ?? new Map<string, Export>())].filter(
      ([name]) => !already.has(name),
    ),
  );
  if (exists && table.size === 0) {
    console.log(`${domain}/index.ts: unchanged (${already.size} exports)`);
    continue;
  }
  const bySource = new Map<string, Export[]>();
  for (const e of table.values())
    bySource.set(e.source, [...(bySource.get(e.source) ?? []), e]);
  const order = (s: string) =>
    s.includes('/infra/models/')
      ? 0
      : s.includes('/api/')
        ? 2
        : s.includes('/application/')
          ? 3
          : s.includes('/infra/')
            ? 4
            : 1;
  const sources = [...bySource.keys()].sort(
    (a, b) => order(a) - order(b) || a.localeCompare(b),
  );
  const body = sources
    .map((src) => {
      const list = bySource
        .get(src)!
        .sort((a, b) => a.exported.localeCompare(b.exported));
      const fmt = (e: Export) =>
        e.imported === e.exported
          ? e.exported
          : `${e.imported} as ${e.exported}`;
      const values = list.filter((e) => e.isValue).map(fmt);
      const types = list.filter((e) => !e.isValue).map(fmt);
      return [
        values.length ? `export { ${values.join(', ')} } from '${src}';` : '',
        types.length
          ? `export type { ${types.join(', ')} } from '${src}';`
          : '',
      ]
        .filter(Boolean)
        .join('\n');
    })
    .join('\n');
  console.log(
    `${domain}/index.ts: ${exists ? `+${table.size} exports appended to ${already.size}` : `${table.size} exports`} from ${sources.length} files`,
  );
  if (DRY) continue;
  if (exists) fs.appendFileSync(file, body + '\n');
  else
    fs.writeFileSync(
      file,
      INDEX_HEADER(domain) + (body ? body + '\n' : 'export {};\n'),
    );
}

// Import rewrites.
let files = 0;
for (const [file, edits] of editsByFile) {
  let text = fs.readFileSync(file, 'utf8');
  for (const e of edits.sort((a, b) => b.start - a.start))
    text = text.slice(0, e.start) + e.text + text.slice(e.end);
  files++;
  if (!DRY) fs.writeFileSync(file, text);
}
console.log(
  `${DRY ? '[dry-run] ' : ''}rewrote deep domain imports in ${files} files`,
);
if (leftDeep.length)
  console.log(
    `Left as deep imports (${leftDeep.length}):\n  ` + leftDeep.join('\n  '),
  );
