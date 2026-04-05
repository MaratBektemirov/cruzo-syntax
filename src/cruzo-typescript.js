"use strict";

const fs = require("fs");
const path = require("path");
const vscode = require("vscode");
const ts = require("typescript");

const VOID_HTML_ELEMENTS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr"
]);

function findTagEndIndexInTemplateText(text, startIndex) {
  let quote = null;
  for (let i = startIndex; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === "\\") {
        i += 1;
        continue;
      }
      if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === "'" || ch === "\"") {
      quote = ch;
      continue;
    }
    if (ch === ">") {
      return i;
    }
  }
  return -1;
}

function normalizeMustacheExpression(rawExpression) {
  if (!rawExpression) {
    return "";
  }
  const trimmed = rawExpression.trim();
  const mustacheMatch = trimmed.match(/^\{\{\s*([\s\S]*?)\s*\}\}$/);
  return mustacheMatch ? mustacheMatch[1].trim() : trimmed;
}

function getVirtualScriptExtension(document) {
  const p = document.fileName.toLowerCase();
  if (p.endsWith(".tsx")) {
    return ".tsx";
  }
  if (p.endsWith(".jsx")) {
    return ".jsx";
  }
  return ".ts";
}

/** @type {Map<string, { program: import('typescript').Program, rootNames: string[], options: import('typescript').CompilerOptions, configPath: string | null, mtime: number }>} */
const programCache = new Map();

const VIRTUAL_SUFFIX = ".__cruzo_virtual__";

/**
 * @param {string} filePath
 */
function normalizeFsPath(filePath) {
  return path.normalize(filePath);
}

/**
 * @param {import('vscode').TextDocument} document
 */
function getDocumentFsPath(document) {
  return normalizeFsPath(document.uri.fsPath);
}

/**
 * @param {string} virtualPath
 * @param {string} documentPath
 */
function moduleSpecifierRelative(virtualPath, documentPath) {
  let rel = path.relative(path.dirname(virtualPath), documentPath);
  rel = rel.replace(/\\/g, "/");
  rel = rel.replace(/\.(tsx?|jsx?)$/i, "");
  if (!rel.startsWith(".")) {
    rel = `./${rel}`;
  }
  return rel;
}

/**
 * @param {import('typescript').TypeChecker} checker
 * @param {import('typescript').Type} type
 */
function typeToStringSafe(checker, type) {
  if (!type) {
    return "any";
  }
  return checker.typeToString(
    type,
    undefined,
    ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope
  );
}

/**
 * @param {import('vscode').WorkspaceFolder | undefined} folder
 * @param {string} documentPath
 */
function findConfigPath(folder, documentPath) {
  const roots = [];
  if (folder?.uri.fsPath) {
    roots.push(folder.uri.fsPath);
  }
  roots.push(path.dirname(documentPath));

  for (const root of roots) {
    const tsconfig = ts.findConfigFile(root, ts.sys.fileExists, "tsconfig.json");
    if (tsconfig) {
      return tsconfig;
    }
    const jsconfig = ts.findConfigFile(root, ts.sys.fileExists, "jsconfig.json");
    if (jsconfig) {
      return jsconfig;
    }
  }
  return undefined;
}

/**
 * @param {string} configPath
 */
function getConfigMtime(configPath) {
  try {
    return fs.statSync(configPath).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * @param {import('vscode').TextDocument} document
 */
function getProgramCacheKey(document) {
  const folder = vscode.workspace.getWorkspaceFolder(document.uri);
  const docPath = getDocumentFsPath(document);
  const configPath = findConfigPath(folder, docPath) || "";
  const mtime = configPath ? getConfigMtime(configPath) : 0;
  return `${document.uri.toString()}::v${document.version}::${configPath}::${mtime}`;
}

/**
 * @param {import('vscode').TextDocument} document
 */
function getBaseCompilerSetup(document) {
  const folder = vscode.workspace.getWorkspaceFolder(document.uri);
  const docPath = getDocumentFsPath(document);
  const configPath = findConfigPath(folder, docPath);
  const cacheKey = getProgramCacheKey(document);
  const cached = programCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  /** @type {import('typescript').CompilerOptions} */
  let options = {
    allowJs: true,
    checkJs: false,
    jsx: ts.JsxEmit.Preserve,
    target: ts.ScriptTarget.Latest,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    skipLibCheck: true,
    strict: false
  };
  /** @type {string[]} */
  let rootNames = [docPath];

  if (configPath) {
    const readJson = ts.readConfigFile(configPath, ts.sys.readFile);
    const parsed = ts.parseJsonConfigFileContent(
      readJson.config,
      ts.sys,
      path.dirname(configPath),
      undefined,
      configPath
    );
    options = { ...options, ...parsed.options };
    rootNames = parsed.fileNames.length ? [...parsed.fileNames] : [docPath];
    if (!rootNames.includes(docPath)) {
      rootNames.push(docPath);
    }
  }

  const host = ts.createCompilerHost(options, true);
  const docPathCanon = host.getCanonicalFileName(docPath);
  const origReadFile = host.readFile.bind(host);
  host.readFile = (fileName) => {
    if (host.getCanonicalFileName(fileName) === docPathCanon) {
      return document.getText();
    }
    return origReadFile(fileName);
  };

  const program = ts.createProgram({
    rootNames,
    options,
    host
  });

  const entry = {
    program,
    rootNames,
    options,
    configPath: configPath || null,
    mtime: configPath ? getConfigMtime(configPath) : 0
  };
  if (programCache.size > 8) {
    programCache.clear();
  }
  programCache.set(cacheKey, entry);
  return entry;
}

function clearTsProgramCache() {
  programCache.clear();
}

/**
 * @param {import('vscode').TextDocument} document
 */
function getOrCreateTsProgram(document) {
  return getBaseCompilerSetup(document).program;
}

/**
 * @param {import('vscode').TextDocument} document
 */
function getTypeChecker(document) {
  return getOrCreateTsProgram(document).getTypeChecker();
}

/**
 * @param {import('vscode').TextDocument} document
 */
function getSourceFile(document) {
  const program = getOrCreateTsProgram(document);
  const p = getDocumentFsPath(document);
  let sf = program.getSourceFile(p);
  if (sf) {
    return sf;
  }
  sf = program.getSourceFile(p.replace(/\\/g, "/"));
  if (sf) {
    return sf;
  }
  const norm = normalizeFsPath(p);
  for (const candidate of program.getSourceFiles()) {
    if (normalizeFsPath(candidate.fileName) === norm) {
      return candidate;
    }
  }
  return undefined;
}

/**
 * @param {import('typescript').Node} node
 */
function getEnclosingClassNode(tsApi, sourceFile, offset) {
  const token = tsApi.getTokenAtPosition(sourceFile, offset);
  const cls = tsApi.findAncestor(token, (n) => tsApi.isClassDeclaration(n) || tsApi.isClassExpression(n));
  return cls || null;
}

/**
 * @param {import('typescript').TypeChecker} checker
 * @param {import('typescript').ClassLikeDeclaration} classNode
 */
function getRootType(checker, classNode) {
  const sym = classNode.symbol;
  if (!sym) {
    return checker.getTypeAtLocation(classNode);
  }
  return checker.getDeclaredTypeOfSymbol(sym);
}

/**
 * @param {import('typescript').TypeChecker} checker
 * @param {import('typescript').Type} type
 */
function unwrapReactiveType(checker, type) {
  if (!type) {
    return type;
  }

  const tryUnwrapRef = (t) => {
    if (!t || !(t.flags & ts.TypeFlags.Object)) {
      return null;
    }
    const ref = t;
    if (!(ref.objectFlags & ts.ObjectFlags.Reference)) {
      return null;
    }
    const target = ref.target;
    const name = target?.symbol?.escapedName;
    if (name === "Rx" || name === "RxFunc") {
      const args = checker.getTypeArguments(ref);
      if (args && args[0]) {
        return args[0];
      }
    }
    return null;
  };

  let current = type;
  const seen = new Set();
  for (let i = 0; i < 12; i += 1) {
    if (seen.has(current)) {
      break;
    }
    seen.add(current);

    const fromRx = tryUnwrapRef(current);
    if (fromRx) {
      current = fromRx;
      continue;
    }

    const actual = checker.getTypeOfPropertyOfType(current, "actual");
    if (actual) {
      current = actual;
      continue;
    }

    break;
  }

  return current;
}

/**
 * @param {import('typescript').TypeChecker} checker
 * @param {import('typescript').Type} type
 */
function getIterationElementType(checker, type) {
  if (!type) {
    return undefined;
  }
  const base = unwrapReactiveType(checker, type);
  if (!base) {
    return undefined;
  }

  if (checker.isArrayType(base)) {
    const args = checker.getTypeArguments(base);
    return args[0];
  }

  if (base.flags & ts.TypeFlags.Union) {
    const parts = [];
    for (const t of base.types) {
      const e = getIterationElementType(checker, t);
      if (e) {
        parts.push(e);
      }
    }
    if (parts.length) {
      return checker.getUnionType(parts);
    }
    return undefined;
  }

  if (base.flags & ts.TypeFlags.Object && base.objectFlags & ts.ObjectFlags.Reference) {
    const target = base.target;
    const name = target?.symbol?.escapedName;
    if (name === "Array" || name === "ReadonlyArray") {
      const args = checker.getTypeArguments(base);
      return args[0];
    }
  }

  const numIndex = checker.getIndexTypeOfType(base, ts.IndexKind.Number);
  if (numIndex) {
    return numIndex;
  }

  return undefined;
}

/**
 * @param {{ kind: string, name?: string | null }} segment
 */
function segmentKey(segment) {
  if (segment.kind === "rx") {
    return "rx";
  }
  if (segment.kind === "member" && segment.name) {
    return `m:${segment.name}`;
  }
  if (segment.kind === "index") {
    return "i";
  }
  return "";
}

/**
 * @param {import('typescript').TypeChecker} checker
 * @param {import('typescript').Type | undefined} rootType
 * @param {Array<{ kind: string, name?: string | null }>} segments
 */
function resolveChainType(checker, rootType, segments) {
  if (!rootType) {
    return null;
  }
  let current = rootType;
  for (const segment of segments) {
    if (segment.kind === "rx") {
      current = unwrapReactiveType(checker, current);
      if (!current) {
        return null;
      }
      continue;
    }
    if (segment.kind === "member" && segment.name) {
      const sym = getPropertySymbol(checker, current, segment.name);
      if (!sym) {
        return null;
      }
      current = checker.getTypeOfSymbol(sym);
      continue;
    }
    if (segment.kind === "index") {
      const numIndex = checker.getIndexTypeOfType(current, ts.IndexKind.Number);
      const strIndex = checker.getIndexTypeOfType(current, ts.IndexKind.String);
      current = numIndex || strIndex || current;
      continue;
    }
  }
  return current;
}

/**
 * @param {import('typescript').TypeChecker} checker
 * @param {import('typescript').Type} objectType
 * @param {string} name
 */
function getPropertySymbol(checker, objectType, name) {
  if (!objectType) {
    return undefined;
  }
  return checker.getPropertyOfType(objectType, name);
}

/**
 * @param {import('typescript').TypeChecker} checker
 * @param {import('typescript').Type} type
 */
function getPropertiesOfType(checker, type) {
  if (!type) {
    return [];
  }
  return checker.getPropertiesOfType(type);
}

/**
 * @param {import('typescript').TypeChecker} checker
 * @param {import('typescript').Symbol} symbol
 */
function getSymbolDocumentation(checker, symbol) {
  const parts = symbol.getDocumentationComment(checker);
  return ts.displayPartsToString(parts);
}

/**
 * @param {string} expr
 */
function sanitizeExpressionThisKeyword(expr) {
  return expr.replace(/\bthis\b/g, "__cruzo_this");
}

/**
 * @param {import('typescript').ClassLikeDeclaration} classNode
 * @param {string} virtualPath
 * @param {string} docPath
 */
function buildRootPreamble(classNode, virtualPath, docPath) {
  const rel = moduleSpecifierRelative(virtualPath, docPath);
  const className = classNode.name ? classNode.name.text : null;
  const modFlags = ts.getEffectiveModifierFlags(classNode);
  const isExport = !!(modFlags & ts.ModifierFlags.Export);
  const isDefault = !!(modFlags & ts.ModifierFlags.ExportDefault);

  if (isDefault && className) {
    return `import ${className} from "${rel}";\ndeclare const root: ${className};\n`;
  }
  if (isDefault && !className) {
    return `import __cruzoDefault from "${rel}";\ndeclare const root: InstanceType<typeof __cruzoDefault>;\n`;
  }
  if (className && isExport) {
    return `import { ${className} } from "${rel}";\ndeclare const root: ${className};\n`;
  }
  return "";
}

/**
 * @param {import('typescript').TypeChecker} checker
 * @param {import('typescript').ClassLikeDeclaration} classNode
 * @param {string} preambleSoFar
 */
function ensureRootDeclaration(checker, classNode, preambleSoFar) {
  if (preambleSoFar.includes("declare const root:")) {
    return preambleSoFar;
  }
  const inst = getRootType(checker, classNode);
  const s = typeToStringSafe(checker, inst);
  return `${preambleSoFar}declare const root: ${s};\n`;
}

/**
 * @param {import('typescript').TypeChecker} checker
 * @param {import('typescript').Type | undefined} thisType
 */
function buildThisDecl(checker, thisType) {
  if (!thisType) {
    return "declare const __cruzo_this: any;\n";
  }
  return `declare const __cruzo_this: ${typeToStringSafe(checker, thisType)};\n`;
}

/**
 * @param {import('vscode').TextDocument} document
 * @param {string} virtualBody
 */
function createProgramWithVirtualFile(document, virtualBody) {
  const setup = getBaseCompilerSetup(document);
  const docPath = getDocumentFsPath(document);
  const ext = getVirtualScriptExtension(document);
  const virtualPath = normalizeFsPath(`${docPath.replace(/\.(tsx?|jsx?)$/i, "")}${VIRTUAL_SUFFIX}${ext}`);

  const preambleLines = [
    "declare const index: number;",
    "declare const event: Event;",
    "declare const once: { <T>(x: T): T };",
    ""
  ];
  const fullVirtual = `${preambleLines.join("\n")}${virtualBody}`;

  const host = ts.createCompilerHost(setup.options, true);
  const origRead = host.readFile.bind(host);
  const origFileExists = host.fileExists.bind(host);
  const virtualPathCanon = host.getCanonicalFileName(virtualPath);
  const docPathCanon = host.getCanonicalFileName(docPath);

  host.readFile = (fileName) => {
    const c = host.getCanonicalFileName(fileName);
    if (c === virtualPathCanon) {
      return fullVirtual;
    }
    if (c === docPathCanon) {
      return document.getText();
    }
    return origRead(fileName);
  };
  host.fileExists = (fileName) => {
    if (host.getCanonicalFileName(fileName) === virtualPathCanon) {
      return true;
    }
    return origFileExists(fileName);
  };

  const rootNames = setup.rootNames.includes(virtualPath) ? setup.rootNames : [...setup.rootNames, virtualPath];
  const program = ts.createProgram({
    rootNames,
    options: setup.options,
    host
  });

  return { program, virtualPath, sourceText: fullVirtual };
}

/**
 * @param {import('typescript').Program} program
 * @param {string} virtualPath
 * @param {string} sourceText
 * @param {number} offset
 */
function getNodeAtOffsetInVirtual(program, virtualPath, sourceText, offset) {
  const sf = program.getSourceFile(virtualPath);
  if (!sf) {
    return null;
  }
  return ts.getTokenAtPosition(sf, offset);
}

/**
 * @returns {{ checker: import('typescript').TypeChecker, type: import('typescript').Type, program: import('typescript').Program } | null}
 */
function getExpressionType(document, classNode, thisType, expression) {
  const checker = getTypeChecker(document);
  const docPath = getDocumentFsPath(document);
  const ext = getVirtualScriptExtension(document);
  const virtualPath = normalizeFsPath(`${docPath.replace(/\.(tsx?|jsx?)$/i, "")}${VIRTUAL_SUFFIX}${ext}`);

  let preamble = buildRootPreamble(classNode, virtualPath, docPath);
  preamble = ensureRootDeclaration(checker, classNode, preamble);
  preamble += buildThisDecl(checker, thisType);

  const body = `${preamble}\nconst __cruzo_expr_probe = (${sanitizeExpressionThisKeyword(expression)});\n`;
  const { program } = createProgramWithVirtualFile(document, body);
  const vchecker = program.getTypeChecker();
  const sf = program.getSourceFile(virtualPath);
  if (!sf) {
    return null;
  }
  const probeDecl = sf.statements.find(
    (s) => ts.isVariableStatement(s) && s.declarationList.declarations.some((d) => d.name.getText() === "__cruzo_expr_probe")
  );
  if (!probeDecl || !ts.isVariableStatement(probeDecl)) {
    return null;
  }
  const decl = probeDecl.declarationList.declarations[0];
  if (!decl.initializer) {
    return null;
  }
  const type = vchecker.getTypeAtLocation(decl.initializer);
  return { checker: vchecker, type, program };
}

/**
 * Mirrors extension `extractLetDeclarationsFromTag` scoping rules; adds expression text.
 * @param {string} tagText
 * @param {number} tagStartOffsetInRaw
 * @param {number} relativeOffset
 */
function extractLetBindingsFromTag(tagText, tagStartOffsetInRaw, relativeOffset) {
  const tagNameMatch = tagText.match(/^<\s*[A-Za-z][\w:-]*/);
  const attrSearchStart = tagNameMatch ? tagNameMatch[0].length : 0;
  const insideCurrentTag =
    relativeOffset >= tagStartOffsetInRaw &&
    relativeOffset <= tagStartOffsetInRaw + tagText.length - 1;
  const declarations = [];
  const reLet = /\blet-([A-Za-z_$][\w$]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let match;
  while ((match = reLet.exec(tagText)) !== null) {
    const varName = match[1];
    const full = match[0];
    const idxInFull = full.lastIndexOf(varName);
    if (idxInFull === -1 || match.index < attrSearchStart) {
      continue;
    }
    const nameStart = tagStartOffsetInRaw + match.index + idxInFull;
    if (insideCurrentTag && nameStart > relativeOffset) {
      continue;
    }
    const rawVal = match[2] || match[3] || "";
    declarations.push({
      name: varName,
      expr: normalizeMustacheExpression(rawVal.trim()),
      scopeOffset: tagStartOffsetInRaw
    });
  }
  reLet.lastIndex = 0;
  return declarations;
}

/**
 * @param {string} rawTemplate
 * @param {number} relativeOffset
 */
function getActiveLetBindingMap(rawTemplate, relativeOffset) {
  const stack = [];
  let cursor = 0;

  while (cursor < rawTemplate.length) {
    const tagStart = rawTemplate.indexOf("<", cursor);
    if (tagStart === -1 || tagStart > relativeOffset) {
      break;
    }
    const tagEnd = findTagEndIndexInTemplateText(rawTemplate, tagStart);
    if (tagEnd === -1) {
      break;
    }
    const tagText = rawTemplate.slice(tagStart, tagEnd + 1);
    cursor = tagEnd + 1;

    if (/^<!--/.test(tagText)) {
      continue;
    }

    const closeMatch = tagText.match(/^<\s*\/\s*([A-Za-z][\w:-]*)/);
    if (closeMatch) {
      const closeName = closeMatch[1].toLowerCase();
      for (let i = stack.length - 1; i >= 0; i -= 1) {
        if (stack[i].name === closeName) {
          stack.splice(i);
          break;
        }
      }
      continue;
    }

    const openMatch = tagText.match(/^<\s*([A-Za-z][\w:-]*)/);
    if (!openMatch) {
      continue;
    }

    const name = openMatch[1].toLowerCase();
    const selfClosing = /\/\s*>$/.test(tagText) || VOID_HTML_ELEMENTS.has(name);
    const lets = extractLetBindingsFromTag(tagText, tagStart, relativeOffset);
    stack.push({ name, lets });

    if (selfClosing) {
      stack.pop();
    }
  }

  const active = new Map();
  for (let i = stack.length - 1; i >= 0; i -= 1) {
    for (const L of stack[i].lets) {
      if (!active.has(L.name)) {
        active.set(L.name, { expr: L.expr, scopeOffset: L.scopeOffset });
      }
    }
  }
  return active;
}

/**
 * @param {string} rawTemplate
 * @param {number} relativeOffset
 * @param {string} letName
 */
function findLetBindingForName(rawTemplate, relativeOffset, letName) {
  return getActiveLetBindingMap(rawTemplate, relativeOffset).get(letName) || null;
}

/**
 * @param {import('vscode').TextDocument} document
 * @param {import('typescript').ClassLikeDeclaration} classNode
 * @param {string} rawTemplate
 * @param {number} relativeOffset
 * @param {string} letName
 * @param {(expr: string) => { owner: string, segments: any[] } | null} parseOwnerAccessorExpression
 */
function getLetVariableType(document, classNode, rawTemplate, relativeOffset, letName, parseOwnerAccessorExpression) {
  const binding = findLetBindingForName(rawTemplate, relativeOffset, letName);
  if (!binding || !binding.expr) {
    return null;
  }
  const repeatChain = getRepeatParsedChain(rawTemplate, binding.scopeOffset, parseOwnerAccessorExpression);
  const thisType = getThisTypeFromRepeat(document, classNode, repeatChain);
  const probe = getExpressionType(document, classNode, thisType, binding.expr);
  return probe ? probe.type : null;
}

/**
 * @param {import('vscode').TextDocument} document
 * @param {import('typescript').ClassLikeDeclaration} classNode
 * @param {Array<{ owner: string, segments: Array<{ kind: string, name?: string | null }> }>} repeatParsedChain
 */
function getThisTypeFromRepeat(document, classNode, repeatParsedChain) {
  const checker = getTypeChecker(document);
  let rootType = getRootType(checker, classNode);
  let thisType = rootType;

  if (!repeatParsedChain.length) {
    return thisType;
  }

  for (const item of repeatParsedChain) {
    const base = item.owner === "root" ? rootType : thisType;
    if (!base) {
      return undefined;
    }
    const iterated = resolveChainType(checker, base, item.segments);
    if (!iterated) {
      return undefined;
    }
    const elem = getIterationElementType(checker, iterated);
    if (!elem) {
      return undefined;
    }
    thisType = elem;
  }

  return thisType;
}

/**
 * Parse repeat expressions from root template up to relativeOffset (same logic as extension).
 * @param {string} rawTemplate
 * @param {number} relativeOffset
 * @param {(expr: string) => { owner: string, segments: any[] } | null} parseOwnerAccessorExpression
 */
function getRepeatParsedChain(rawTemplate, relativeOffset, parseOwnerAccessorExpression) {
  const RE_REPEAT_ATTR = /\brepeat\s*=\s*(?:"([^"]*)"|'([^']*)')/;
  const stack = [];
  let cursor = 0;

  while (cursor < rawTemplate.length) {
    const tagStart = rawTemplate.indexOf("<", cursor);
    if (tagStart === -1 || tagStart > relativeOffset) {
      break;
    }
    const tagEnd = findTagEndIndexInTemplateText(rawTemplate, tagStart);
    if (tagEnd === -1) {
      break;
    }
    const tagText = rawTemplate.slice(tagStart, tagEnd + 1);
    cursor = tagEnd + 1;

    if (/^<!--/.test(tagText)) {
      continue;
    }

    const closeMatch = tagText.match(/^<\s*\/\s*([A-Za-z][\w:-]*)/);
    if (closeMatch) {
      const closeName = closeMatch[1].toLowerCase();
      for (let i = stack.length - 1; i >= 0; i -= 1) {
        if (stack[i].name === closeName) {
          stack.splice(i);
          break;
        }
      }
      continue;
    }

    const openMatch = tagText.match(/^<\s*([A-Za-z][\w:-]*)/);
    if (!openMatch) {
      continue;
    }

    const name = openMatch[1].toLowerCase();
    const selfClosing = /\/\s*>$/.test(tagText) || VOID_HTML_ELEMENTS.has(name);
    const repeatMatch = tagText.match(RE_REPEAT_ATTR);
    const repeatExpression = repeatMatch
      ? normalizeMustacheExpression(repeatMatch[1] || repeatMatch[2] || "")
      : null;

    stack.push({ name, repeatExpression });

    if (selfClosing) {
      stack.pop();
    }
  }

  const chain = stack.map((x) => x.repeatExpression).filter(Boolean);
  const parsed = [];
  for (const expr of chain) {
    const p = parseOwnerAccessorExpression(expr);
    if (p) {
      parsed.push(p);
    }
  }
  return parsed;
}

module.exports = {
  ts,
  clearTsProgramCache,
  getOrCreateTsProgram,
  getTypeChecker,
  getSourceFile,
  getDocumentFsPath,
  getEnclosingClassNode,
  getRootType,
  getThisTypeFromRepeat,
  getLetVariableType,
  findLetBindingForName,
  getActiveLetBindingMap,
  getExpressionType,
  unwrapReactiveType,
  resolveChainType,
  getPropertiesOfType,
  getPropertySymbol,
  getIterationElementType,
  typeToStringSafe,
  getSymbolDocumentation,
  sanitizeExpressionThisKeyword,
  buildRootPreamble,
  ensureRootDeclaration,
  buildThisDecl,
  createProgramWithVirtualFile,
  getNodeAtOffsetInVirtual,
  segmentKey,
  getRepeatParsedChain,
  moduleSpecifierRelative
};
