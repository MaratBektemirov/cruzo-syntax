const path = require("path");
const ignore = require("ignore");
const vscode = require("vscode");

const VOID_ELEMENTS = new Set([
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

const selectorLocationCache = new Map();
let selectorLocationCacheRevision = 0;
const templateTargetsCache = new Map();
const componentMembersCache = new Map();
const MAX_LOCAL_CACHE_SIZE = 300;
const RE_HTML_TAG = /<\/?[A-Za-z][\w:-]*[\s>]/;
const RE_CRUZO_MARKERS = /\{\{[\s\S]*\}\}|::rx\b|\bonce::|\b(?:repeat|attached|inner-html|let-[a-zA-Z_][\w-]*|on[a-zA-Z]+)\s*=/;
const RE_WORD_RANGE = /[A-Za-z_$][\w$-]*/;
const RE_TAG_CONTEXT = /<\/*[A-Za-z][\w:-]*$/;
const RE_REPEAT_ATTR = /\brepeat\s*=\s*(?:"([^"]*)"|'([^']*)')/;
const RE_LET_ATTR = /\blet-([A-Za-z_$][\w$]*)\s*=/g;
const RE_COMPLETION_OWNER = /(?:^|[^\w$])(root|this)(?:\s*::rx)?\s*(?:\?\.|\.)\s*[A-Za-z_$\w$]*$/;
const RE_COMPLETION_MEMBER_CHAIN = /(?:^|[^\w$])(root|this)(?:\s*::rx)?((?:\s*(?:\?\.|\.)\s*[A-Za-z_$][\w$]*|\s*\[\s*(?:"[^"\n]+"|'[^'\n]+'|`[^`\n]+`|\d+)\s*\]|\s*::rx)+)\s*(?:\?\.|\.)\s*[A-Za-z_$\w$]*$/;
const RE_ACCESSOR_CHAIN = /\b(root|this)(?:\s*::rx)?((?:\s*(?:\?\.|\.)\s*[A-Za-z_$][\w$]*|\s*\[\s*(?:"[^"\n]+"|'[^'\n]+'|`[^`\n]+`|\d+)\s*\]|\s*::rx)+)/g;
const RE_OWNER_CHAIN_EXACT = /^\s*(root|this)(?:\s*::rx)?((?:\s*(?:\?\.|\.)\s*[A-Za-z_$][\w$]*|\s*\[\s*(?:"[^"\n]+"|'[^'\n]+'|`[^`\n]+`|\d+)\s*\]|\s*::rx)+)\s*$/;
const RE_ATTR_CONTEXT = /<[^>]*$/;
const RE_IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
const RE_HOVER_WORD = /[A-Za-z_-]+/;

function countLeadingClosings(line) {
  let remaining = line.trim();
  let count = 0;

  while (remaining.startsWith("</")) {
    const match = remaining.match(/^<\/[A-Za-z][\w:-]*\s*>/);
    if (!match) {
      break;
    }
    count += 1;
    remaining = remaining.slice(match[0].length).trimStart();
  }

  return count;
}

function countTagDelta(line) {
  const tagPattern = /<\/?([A-Za-z][\w:-]*)(\s[^>]*?)?>/g;
  let openCount = 0;
  let closeCount = 0;

  for (const match of line.matchAll(tagPattern)) {
    const fullTag = match[0];
    const tagName = (match[1] || "").toLowerCase();

    if (fullTag.startsWith("</")) {
      closeCount += 1;
      continue;
    }

    if (fullTag.endsWith("/>") || VOID_ELEMENTS.has(tagName)) {
      continue;
    }

    openCount += 1;
  }

  return openCount - closeCount;
}

function findTagEndIndex(line) {
  let quote = null;

  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
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

function getOpenTagWithoutEndName(line) {
  const startMatch = line.match(/^<([A-Za-z][\w:-]*)(\s.*)?$/);
  if (!startMatch) {
    return null;
  }
  if (line.startsWith("</")) {
    return null;
  }
  return findTagEndIndex(line) === -1 ? startMatch[1].toLowerCase() : null;
}

function formatCruzo(text, indentSize, baseIndent) {
  const lines = text.split(/\r?\n/);
  const out = [];
  let indentLevel = 0;
  let insideMultilineTag = false;
  let multilineTagName = "";
  const normalizedBaseIndent = baseIndent || "";

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const rawLine = lines[lineIndex];
    const trimmed = rawLine.trim();

    if (!trimmed) {
      out.push("");
      continue;
    }

    const leadingClosings = countLeadingClosings(trimmed);
    const continuationIndent = insideMultilineTag ? 1 : 0;
    const lineIndent = Math.max(indentLevel + continuationIndent - leadingClosings, 0);
    // Format only HTML layout; keep template expressions unchanged.
    const normalized = trimmed;
    const basePrefix = lineIndex === 0 ? "" : normalizedBaseIndent;
    out.push(`${basePrefix}${" ".repeat(lineIndent * indentSize)}${normalized}`);

    let delta = countTagDelta(trimmed);

    const openTagWithoutEndName = getOpenTagWithoutEndName(trimmed);
    if (!insideMultilineTag && openTagWithoutEndName) {
      insideMultilineTag = true;
      multilineTagName = openTagWithoutEndName;
    } else if (insideMultilineTag) {
      const endIndex = findTagEndIndex(trimmed);
      if (endIndex !== -1) {
        insideMultilineTag = false;
        const beforeEnd = trimmed.slice(0, endIndex).trimEnd();
        const selfClosing = /\/\s*$/.test(beforeEnd);
        if (!selfClosing && multilineTagName && !VOID_ELEMENTS.has(multilineTagName)) {
          delta += 1;
        }
        multilineTagName = "";
      }
    }

    indentLevel = Math.max(indentLevel + delta, 0);
  }

  return out.join("\n");
}

function isEscapedBacktick(text, index) {
  let slashCount = 0;
  let i = index - 1;
  while (i >= 0 && text[i] === "\\") {
    slashCount += 1;
    i -= 1;
  }
  return slashCount % 2 === 1;
}

function getLineLeadingWhitespace(lineText) {
  return lineText.match(/^\s*/)[0] || "";
}

function skipQuotedStringLiteral(text, startIndex, quote) {
  let i = startIndex + 1;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === quote) {
      return i + 1;
    }
    i += 1;
  }
  return i;
}

function skipSingleLineComment(text, startIndex) {
  let i = startIndex + 2;
  while (i < text.length) {
    if (text[i] === "\n") {
      return i + 1;
    }
    i += 1;
  }
  return i;
}

function skipMultiLineComment(text, startIndex) {
  let i = startIndex + 2;
  while (i < text.length - 1) {
    if (text[i] === "*" && text[i + 1] === "/") {
      return i + 2;
    }
    i += 1;
  }
  return text.length;
}

function parseTemplateExpression(text, startIndex, ranges) {
  let i = startIndex;
  let depth = 1;

  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];

    if (ch === "'" || ch === "\"") {
      i = skipQuotedStringLiteral(text, i, ch);
      continue;
    }

    if (ch === "/" && next === "/") {
      i = skipSingleLineComment(text, i);
      continue;
    }
    if (ch === "/" && next === "*") {
      i = skipMultiLineComment(text, i);
      continue;
    }

    if (ch === "`") {
      i = parseTemplateLiteralRange(text, i, ranges);
      continue;
    }

    if (ch === "{") {
      depth += 1;
      i += 1;
      continue;
    }
    if (ch === "}") {
      depth -= 1;
      i += 1;
      if (depth === 0) {
        return i;
      }
      continue;
    }

    i += 1;
  }

  return i;
}

function parseTemplateLiteralRange(text, startIndex, ranges) {
  let i = startIndex + 1;

  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];

    if (ch === "\\") {
      i += 2;
      continue;
    }

    if (ch === "`") {
      ranges.push({ start: startIndex, end: i });
      return i + 1;
    }

    if (ch === "$" && next === "{") {
      i = parseTemplateExpression(text, i + 2, ranges);
      continue;
    }

    i += 1;
  }

  return i;
}

function findAllTemplateLiteralTargets(document, indentSize) {
  const text = document.getText();
  const ranges = [];
  let i = 0;

  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];

    if (ch === "'" || ch === "\"") {
      i = skipQuotedStringLiteral(text, i, ch);
      continue;
    }

    if (ch === "/" && next === "/") {
      i = skipSingleLineComment(text, i);
      continue;
    }
    if (ch === "/" && next === "*") {
      i = skipMultiLineComment(text, i);
      continue;
    }

    if (ch === "`") {
      i = parseTemplateLiteralRange(text, i, ranges);
      continue;
    }

    i += 1;
  }

  const targets = [];
  for (const range of ranges) {
    const rangeStart = document.positionAt(range.start + 1);
    const rangeEnd = document.positionAt(range.end);
    const openingPosition = document.positionAt(range.start);
    const openingLine = document.lineAt(openingPosition.line).text;
    const hostIndent = getLineLeadingWhitespace(openingLine);
    const baseIndent = `${hostIndent}${" ".repeat(indentSize)}`;

    targets.push({
      range: new vscode.Range(rangeStart, rangeEnd),
      baseIndent
    });
  }

  return targets;
}

function getTemplateTargetsCacheKey(document, indentSize) {
  return `${document.uri.toString()}::${document.version}::${indentSize}`;
}

function getTemplateLiteralTargetsCached(document, indentSize) {
  const key = getTemplateTargetsCacheKey(document, indentSize);
  const cached = templateTargetsCache.get(key);
  if (cached) {
    return cached;
  }

  const targets = findAllTemplateLiteralTargets(document, indentSize);
  if (templateTargetsCache.size > MAX_LOCAL_CACHE_SIZE) {
    templateTargetsCache.clear();
  }
  templateTargetsCache.set(key, targets);
  return targets;
}

function getSupportedLanguageIds() {
  return new Set(["typescript", "javascript"]);
}

function normalizeToPosix(filePath) {
  return filePath.replace(/\\/g, "/");
}

async function readGitignoreMatcher(workspaceFolder) {
  try {
    const gitignoreUri = vscode.Uri.joinPath(workspaceFolder.uri, ".gitignore");
    const bytes = await vscode.workspace.fs.readFile(gitignoreUri);
    const text = Buffer.from(bytes).toString("utf8");
    const matcher = ignore();
    matcher.add(text);
    return matcher;
  } catch {
    return null;
  }
}

function isPathIgnoredByMatcher(relativePath, matcher) {
  if (!matcher) {
    return false;
  }

  const rel = normalizeToPosix(relativePath).replace(/^\/+/, "");
  return matcher.ignores(rel);
}

function buildTemplateEdits(document, indentSize) {
  const templateTargets = getTemplateLiteralTargetsCached(document, indentSize);
  if (!templateTargets.length) {
    return [];
  }

  const sortedTargets = templateTargets.sort((a, b) => {
    const aOffset = document.offsetAt(a.range.start);
    const bOffset = document.offsetAt(b.range.start);
    return bOffset - aOffset;
  });

  return sortedTargets.map((target) => {
    const raw = document.getText(target.range);
    if (!raw.includes("\n")) {
      return null;
    }
    if (!looksLikeHtmlTemplate(raw)) {
      return null;
    }
    const formatted = formatCruzo(raw, indentSize, target.baseIndent);
    if (formatted === raw) {
      return null;
    }
    return {
      range: target.range,
      formatted
    };
  }).filter(Boolean);
}

function looksLikeCruzoTemplate(text) {
  const t = text.trim();
  if (!t) {
    return false;
  }

  const hasHtml = RE_HTML_TAG.test(t);
  const hasCruzo = RE_CRUZO_MARKERS.test(t);

  return hasHtml || hasCruzo;
}

function looksLikeHtmlTemplate(text) {
  const t = text.trim();
  if (!t) {
    return false;
  }

  return RE_HTML_TAG.test(t);
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getTemplateTargetAtPosition(document, position, indentSize) {
  const targets = getTemplateLiteralTargetsCached(document, indentSize);
  for (const target of targets) {
    if (target.range.contains(position)) {
      const raw = document.getText(target.range);
      if (looksLikeCruzoTemplate(raw)) {
        return { ...target, raw };
      }
    }
  }
  return null;
}

function getWordRangeAtPosition(document, position) {
  return document.getWordRangeAtPosition(position, RE_WORD_RANGE);
}

function isTagContext(lineText, wordStartCharacter) {
  const left = lineText.slice(0, wordStartCharacter);
  return RE_TAG_CONTEXT.test(left);
}

function getRootMemberAtPosition(document, position, templateTarget) {
  const wordRange = getWordRangeAtPosition(document, position);
  if (!wordRange) {
    return null;
  }

  const word = document.getText(wordRange);
  const raw = templateTarget.raw;
  const targetStartOffset = document.offsetAt(templateTarget.range.start);
  const wordStartOffset = document.offsetAt(wordRange.start) - targetStartOffset;
  const wordEndOffset = document.offsetAt(wordRange.end) - targetStartOffset;

  const pattern = /\broot\.([A-Za-z_$][\w$]*)/g;
  for (const match of raw.matchAll(pattern)) {
    const full = match[0];
    const member = match[1];
    const fullIndex = match.index || 0;
    const memberStart = fullIndex + full.indexOf(member);
    const memberEnd = memberStart + member.length;
    if (wordStartOffset >= memberStart && wordEndOffset <= memberEnd && member === word) {
      return {
        name: member,
        wordRange
      };
    }
  }

  return null;
}

function getTemplateAccessorMemberAtPosition(document, position, templateTarget) {
  const wordRange = getWordRangeAtPosition(document, position);
  if (!wordRange) {
    return null;
  }

  const word = document.getText(wordRange);
  const raw = templateTarget.raw;
  const targetStartOffset = document.offsetAt(templateTarget.range.start);
  const wordStartOffset = document.offsetAt(wordRange.start) - targetStartOffset;
  const wordEndOffset = document.offsetAt(wordRange.end) - targetStartOffset;
  const pattern = RE_ACCESSOR_CHAIN;
  pattern.lastIndex = 0;

  for (const match of raw.matchAll(pattern)) {
    const owner = match[1];
    const chainText = match[2] || "";
    const fullIndex = match.index || 0;
    const chainStart = fullIndex + match[0].indexOf(chainText);
    const segments = parseAccessorChainSegments(chainText, chainStart);
    for (let i = 0; i < segments.length; i += 1) {
      const segment = segments[i];
      if (segment.kind === "member" && wordStartOffset >= segment.start && wordEndOffset <= segment.end && segment.name === word) {
        return {
          owner,
          name: segment.name,
          segments,
          targetSegmentIndex: i,
          wordRange
        };
      }
    }
  }
  pattern.lastIndex = 0;

  return null;
}

function isOffsetInsideRange(offset, ranges) {
  for (const range of ranges) {
    if (offset >= range.start && offset <= range.end) {
      return true;
    }
  }
  return false;
}

function findEnclosingClassRange(document, position) {
  const text = document.getText();
  const positionOffset = document.offsetAt(position);
  const classPattern = /\b(?:class|interface|type)\s+[A-Za-z_$][\w$]*[^{]*\{/g;
  let match;
  let bestRange = null;

  while ((match = classPattern.exec(text)) !== null) {
    const classStart = match.index || 0;
    const openBrace = classStart + match[0].lastIndexOf("{");
    let depth = 1;
    let i = openBrace + 1;

    for (; i < text.length; i += 1) {
      const ch = text[i];
      if (ch === "{") {
        depth += 1;
      } else if (ch === "}") {
        depth -= 1;
        if (depth === 0) {
          break;
        }
      }
    }

    if (depth !== 0) {
      continue;
    }

    const classEnd = i + 1;
    if (positionOffset < classStart || positionOffset > classEnd) {
      continue;
    }

    const range = new vscode.Range(document.positionAt(classStart), document.positionAt(classEnd));
    if (!bestRange || document.offsetAt(bestRange.start) <= classStart) {
      bestRange = range;
    }
  }

  return bestRange;
}

function findMemberDeclarations(document, memberName, searchRange = null) {
  const text = document.getText();
  const rangeStart = searchRange ? document.offsetAt(searchRange.start) : 0;
  const rangeEnd = searchRange ? document.offsetAt(searchRange.end) : text.length;
  const source = text.slice(rangeStart, rangeEnd);
  const escaped = escapeRegExp(memberName);
  const templateRanges = getTemplateLiteralTargetsCached(document, 2)
    .map((target) => ({
      start: document.offsetAt(target.range.start),
      end: document.offsetAt(target.range.end)
    }))
    .filter((range) => range.end >= rangeStart && range.start <= rangeEnd);
  const patterns = [
    new RegExp(`^\\s*(?:[\\{,]\\s*)*(?:public\\s+|private\\s+|protected\\s+|readonly\\s+|static\\s+|async\\s+|get\\s+|set\\s+|abstract\\s+|override\\s+)*(${escaped})\\s*(?:<[^>\\n]*>\\s*)?\\(`, "gm"),
    new RegExp(`^\\s*(?:[\\{,]\\s*)*(?:public\\s+|private\\s+|protected\\s+|readonly\\s+|static\\s+|abstract\\s+|override\\s+)*(?:declare\\s+)?(${escaped})(?:[!?])?\\s*(?::|=)`, "gm"),
    new RegExp(`^\\s*(?:[\\{,]\\s*)*(?:public\\s+|private\\s+|protected\\s+|readonly\\s+|static\\s+|abstract\\s+|override\\s+)*(?:declare\\s+)?get\\s+(${escaped})\\s*(?:[!?])?\\s*\\([^)]*\\)\\s*(?::|\\{)`, "gm")
  ];

  const ranges = [];

  for (const regex of patterns) {
    let match;
    while ((match = regex.exec(source)) !== null) {
      const declarationName = match[1];
      const relativeIdx = match[0].indexOf(declarationName);
      const absoluteStart = rangeStart + (match.index || 0) + relativeIdx;
      const absoluteEnd = absoluteStart + declarationName.length;
      if (isOffsetInsideRange(absoluteStart, templateRanges)) {
        continue;
      }
      ranges.push(new vscode.Range(document.positionAt(absoluteStart), document.positionAt(absoluteEnd)));
    }
  }

  return ranges;
}

function findMemberAssignmentStarts(document, memberName, searchRange = null) {
  const text = document.getText();
  const rangeStart = searchRange ? document.offsetAt(searchRange.start) : 0;
  const rangeEnd = searchRange ? document.offsetAt(searchRange.end) : text.length;
  const source = text.slice(rangeStart, rangeEnd);
  const escaped = escapeRegExp(memberName);
  const pattern = new RegExp(
    `^\\s*(?:public\\s+|private\\s+|protected\\s+|readonly\\s+|static\\s+)*(?:declare\\s+)?${escaped}\\s*(?::[^=\\n]+)?\\s*=`,
    "gm"
  );
  const starts = [];
  let match;
  while ((match = pattern.exec(source)) !== null) {
    const idx = rangeStart + (match.index || 0) + match[0].lastIndexOf("=");
    starts.push(idx + 1);
  }
  return starts;
}

function isLikelyClassMemberStart(text, offset) {
  let i = offset;
  while (i < text.length && /\s/.test(text[i])) {
    i += 1;
  }

  if (i >= text.length) {
    return true;
  }

  if (text[i] === "}") {
    return true;
  }

  const tail = text.slice(i, Math.min(i + 220, text.length));
  return /^(?:(?:public|private|protected|readonly|static|async|declare|get|set)\s+)*(?:[#A-Za-z_$][\w$]*)\s*(?:[!?])?\s*(?:\(|:|=|<)/.test(tail);
}

function readAssignedExpression(text, startOffset) {
  let i = startOffset;
  while (i < text.length && /\s/.test(text[i])) {
    i += 1;
  }

  const exprStart = i;
  let quote = null;
  let templateDepth = 0;
  const stack = [];

  for (; i < text.length; i += 1) {
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

    if (ch === "`") {
      templateDepth = templateDepth === 0 ? 1 : 0;
      continue;
    }
    if (templateDepth > 0) {
      continue;
    }

    if (ch === "(" || ch === "{" || ch === "[") {
      stack.push(ch);
      continue;
    }

    if (ch === ")" || ch === "}" || ch === "]") {
      if (stack.length > 0) {
        stack.pop();
        continue;
      }
      if (ch === "}" && isLikelyClassMemberStart(text, i)) {
        return {
          start: exprStart,
          end: i,
          text: text.slice(exprStart, i)
        };
      }
      continue;
    }

    if (ch === ";" && stack.length === 0) {
      return {
        start: exprStart,
        end: i,
        text: text.slice(exprStart, i)
      };
    }

    if ((ch === "\n" || ch === "\r") && stack.length === 0 && isLikelyClassMemberStart(text, i + 1)) {
      return {
        start: exprStart,
        end: i,
        text: text.slice(exprStart, i)
      };
    }
  }

  return {
    start: exprStart,
    end: text.length,
    text: text.slice(exprStart)
  };
}

function findObjectKeyRangesInExpression(document, expressionStart, expressionText, propertyName) {
  const ranges = [];
  const escaped = escapeRegExp(propertyName);
  const keyPattern = new RegExp(`(?:^|[,{]\\s*)(["'\`]?)(?:${escaped})\\1\\s*:`, "gm");
  const objectLikePatterns = [
    /newRx\s*(?:<[^>\n]+>)?\s*\(\s*\{[\s\S]*?\}\s*\)/g,
    /\{[\s\S]*?\}/g
  ];

  for (const objectPattern of objectLikePatterns) {
    let objectMatch;
    while ((objectMatch = objectPattern.exec(expressionText)) !== null) {
      const objectText = objectMatch[0];
      const objectStart = expressionStart + (objectMatch.index || 0);
      let keyMatch;
      while ((keyMatch = keyPattern.exec(objectText)) !== null) {
        const keyIndex = keyMatch[0].lastIndexOf(propertyName);
        if (keyIndex === -1) {
          continue;
        }
        const start = objectStart + keyMatch.index + keyIndex;
        const end = start + propertyName.length;
        ranges.push(new vscode.Range(document.positionAt(start), document.positionAt(end)));
      }
    }
    if (ranges.length) {
      return ranges;
    }
  }

  return ranges;
}

function normalizeRepeatExpression(rawExpression) {
  if (!rawExpression) {
    return "";
  }
  const trimmed = rawExpression.trim();
  const mustacheMatch = trimmed.match(/^\{\{\s*([\s\S]*?)\s*\}\}$/);
  return mustacheMatch ? mustacheMatch[1].trim() : trimmed;
}

function findTagEndIndexInText(text, startIndex) {
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

function getRepeatExpressionChain(rawTemplate, relativeOffset) {
  const stack = [];
  let cursor = 0;

  while (cursor < rawTemplate.length) {
    const tagStart = rawTemplate.indexOf("<", cursor);
    if (tagStart === -1 || tagStart > relativeOffset) {
      break;
    }

    const tagEnd = findTagEndIndexInText(rawTemplate, tagStart);
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
    const selfClosing = /\/\s*>$/.test(tagText) || VOID_ELEMENTS.has(name);
    const repeatMatch = tagText.match(RE_REPEAT_ATTR);
    const repeatExpression = repeatMatch
      ? normalizeRepeatExpression(repeatMatch[1] || repeatMatch[2] || "")
      : null;

    stack.push({ name, repeatExpression });

    if (selfClosing) {
      stack.pop();
    }
  }

  return stack
    .map((item) => item.repeatExpression)
    .filter(Boolean);
}

function findRootSourceMemberFromRepeatChain(repeatChain) {
  for (let i = repeatChain.length - 1; i >= 0; i -= 1) {
    const sourceMatch = repeatChain[i].match(/^root(?:\s*::rx)?\s*(?:\?\.|\.)\s*([A-Za-z_$][\w$]*)$/);
    if (sourceMatch) {
      return sourceMatch[1];
    }
  }
  return null;
}

function findThisRepeatMemberDefinitions(document, position, templateTarget, propertyName, classRange = null) {
  const raw = templateTarget.raw;
  const absoluteOffset = document.offsetAt(position);
  const templateStart = document.offsetAt(templateTarget.range.start);
  const relativeOffset = absoluteOffset - templateStart;
  const repeatChain = getRepeatExpressionChain(raw, relativeOffset);
  if (!repeatChain.length) {
    return [];
  }

  const sourceMemberName = findRootSourceMemberFromRepeatChain(repeatChain);
  if (!sourceMemberName) {
    return [];
  }

  const assignmentStarts = findMemberAssignmentStarts(document, sourceMemberName, classRange);
  if (!assignmentStarts.length) {
    return [];
  }

  const text = document.getText();
  for (const assignmentStart of assignmentStarts) {
    const assigned = readAssignedExpression(text, assignmentStart);
    const propertyRanges = findObjectKeyRangesInExpression(
      document,
      assigned.start,
      assigned.text,
      propertyName
    );
    if (propertyRanges.length) {
      return propertyRanges;
    }
  }

  return [];
}

function extractLetDeclarationsFromTag(tagText, tagStartOffsetInRaw, relativeOffset) {
  const declarations = [];
  const tagNameMatch = tagText.match(/^<\s*[A-Za-z][\w:-]*/);
  const attrSearchStart = tagNameMatch ? tagNameMatch[0].length : 0;
  const insideCurrentTag = relativeOffset >= tagStartOffsetInRaw
    && relativeOffset <= tagStartOffsetInRaw + tagText.length - 1;
  let match;

  while ((match = RE_LET_ATTR.exec(tagText)) !== null) {
    const name = match[1];
    const full = match[0];
    const idxInFull = full.lastIndexOf(name);
    if (idxInFull === -1 || match.index < attrSearchStart) {
      continue;
    }

    const start = tagStartOffsetInRaw + match.index + idxInFull;
    if (insideCurrentTag && start > relativeOffset) {
      continue;
    }

    declarations.push({
      name,
      start,
      end: start + name.length
    });
  }

  RE_LET_ATTR.lastIndex = 0;
  return declarations;
}

function getActiveLetDeclarations(rawTemplate, relativeOffset) {
  const stack = [];
  let cursor = 0;

  while (cursor < rawTemplate.length) {
    const tagStart = rawTemplate.indexOf("<", cursor);
    if (tagStart === -1 || tagStart > relativeOffset) {
      break;
    }

    const tagEnd = findTagEndIndexInText(rawTemplate, tagStart);
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
    const selfClosing = /\/\s*>$/.test(tagText) || VOID_ELEMENTS.has(name);
    const lets = extractLetDeclarationsFromTag(tagText, tagStart, relativeOffset);
    stack.push({ name, lets });

    if (selfClosing) {
      stack.pop();
    }
  }

  const active = new Map();
  for (let i = stack.length - 1; i >= 0; i -= 1) {
    for (const letDecl of stack[i].lets) {
      if (!active.has(letDecl.name)) {
        active.set(letDecl.name, letDecl);
      }
    }
  }
  return active;
}

function getLetMemberAtPosition(document, position, templateTarget) {
  const wordRange = getWordRangeAtPosition(document, position);
  if (!wordRange) {
    return null;
  }

  const word = document.getText(wordRange);
  if (!RE_IDENTIFIER.test(word)) {
    return null;
  }

  const templateStartOffset = document.offsetAt(templateTarget.range.start);
  const relativeOffset = document.offsetAt(position) - templateStartOffset;
  const activeLets = getActiveLetDeclarations(templateTarget.raw, relativeOffset);
  const declaration = activeLets.get(word);
  if (!declaration) {
    return null;
  }

  const declarationRange = new vscode.Range(
    document.positionAt(templateStartOffset + declaration.start),
    document.positionAt(templateStartOffset + declaration.end)
  );

  return {
    name: word,
    wordRange,
    declarationRange
  };
}

function getLetAttributeAtPosition(document, position, templateTarget) {
  const templateStartOffset = document.offsetAt(templateTarget.range.start);
  const relativeOffset = document.offsetAt(position) - templateStartOffset;
  let match;

  while ((match = RE_LET_ATTR.exec(templateTarget.raw)) !== null) {
    const full = match[0];
    const name = match[1];
    const start = match.index || 0;
    const end = start + full.length;
    if (relativeOffset < start || relativeOffset > end) {
      continue;
    }

    RE_LET_ATTR.lastIndex = 0;
    return { name };
  }

  RE_LET_ATTR.lastIndex = 0;
  return null;
}

function collectComponentMembers(document) {
  const cacheKey = `${document.uri.toString()}::${document.version}`;
  const cached = componentMembersCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const text = document.getText();
  const members = new Map();
  const methodRegex = /\b(?:public\s+|private\s+|protected\s+|readonly\s+|static\s+|async\s+|get\s+|set\s+|abstract\s+|override\s+)*([A-Za-z_$][\w$]*)\s*(?:<[^>\n]*>\s*)?\(/g;
  const fieldRegex = /\b(?:public\s+|private\s+|protected\s+|readonly\s+|static\s+|abstract\s+|override\s+)*(?:declare\s+)?([A-Za-z_$][\w$]*)(?:[!?])?\s*(?::|=)/g;

  const pushMember = (name, kind, index) => {
    if (name === "constructor") {
      return;
    }
    if (!members.has(name)) {
      const start = index;
      const range = new vscode.Range(
        document.positionAt(start),
        document.positionAt(start + name.length)
      );
      members.set(name, { name, kind, range });
    }
  };

  let match;
  while ((match = methodRegex.exec(text)) !== null) {
    const name = match[1];
    const start = (match.index || 0) + match[0].indexOf(name);
    pushMember(name, vscode.CompletionItemKind.Method, start);
  }

  while ((match = fieldRegex.exec(text)) !== null) {
    const name = match[1];
    const start = (match.index || 0) + match[0].indexOf(name);
    pushMember(name, vscode.CompletionItemKind.Field, start);
  }

  const result = Array.from(members.values());
  if (componentMembersCache.size > MAX_LOCAL_CACHE_SIZE) {
    componentMembersCache.clear();
  }
  componentMembersCache.set(cacheKey, result);
  return result;
}

function getTextBeforePosition(document, position, maxChars = 160) {
  const lineText = document.lineAt(position.line).text;
  const start = Math.max(0, position.character - maxChars);
  return lineText.slice(start, position.character);
}

function getExpressionOwnerForCompletion(document, position) {
  const before = getTextBeforePosition(document, position);
  const ownerMatch = before.match(RE_COMPLETION_OWNER);
  return ownerMatch ? ownerMatch[1] : null;
}

function getCompletionOwnerMemberForPosition(document, position) {
  const before = getTextBeforePosition(document, position);
  const match = before.match(RE_COMPLETION_MEMBER_CHAIN);
  if (!match) {
    return null;
  }
  const chainText = match[2] || "";
  const segments = parseAccessorChainSegments(chainText);
  if (!segments.length) {
    return null;
  }
  return {
    owner: match[1],
    segments
  };
}

function parseAccessorChainSegments(chainText, chainStartOffset = 0) {
  const segments = [];
  const segmentPattern = /(?:\?\.|\.)\s*([A-Za-z_$][\w$]*)|\[\s*(?:"([^"\n]+)"|'([^'\n]+)'|`([^`\n]+)`|(\d+))\s*\]|(::rx)/g;
  let segmentMatch;

  while ((segmentMatch = segmentPattern.exec(chainText)) !== null) {
    const whole = segmentMatch[0] || "";
    const identifier = segmentMatch[1] || segmentMatch[2] || segmentMatch[3] || segmentMatch[4] || null;
    const numericIndex = segmentMatch[5] || null;
    const rxMarker = segmentMatch[6] || null;
    const start = chainStartOffset + (segmentMatch.index || 0) + (identifier ? whole.lastIndexOf(identifier) : 0);
    const end = start + (identifier ? identifier.length : 0);

    if (rxMarker) {
      segments.push({
        kind: "rx",
        name: null,
        start: chainStartOffset + (segmentMatch.index || 0),
        end: chainStartOffset + (segmentMatch.index || 0) + rxMarker.length
      });
      continue;
    }

    if (numericIndex !== null) {
      segments.push({
        kind: "index",
        name: null,
        start,
        end
      });
      continue;
    }

    if (identifier && RE_IDENTIFIER.test(identifier)) {
      segments.push({
        kind: "member",
        name: identifier,
        start,
        end
      });
    }
  }

  return segments;
}

function toLocation(locationLike) {
  if (!locationLike) {
    return null;
  }
  if ("uri" in locationLike && "range" in locationLike) {
    return locationLike;
  }
  if ("targetUri" in locationLike && "targetSelectionRange" in locationLike) {
    return {
      uri: locationLike.targetUri,
      range: locationLike.targetSelectionRange
    };
  }
  if ("targetUri" in locationLike && "targetRange" in locationLike) {
    return {
      uri: locationLike.targetUri,
      range: locationLike.targetRange
    };
  }
  return null;
}

async function getMemberTypeContexts(document, memberName, classRange) {
  const declarations = findMemberDeclarations(document, memberName, classRange);
  if (!declarations.length) {
    return [];
  }

  const typeLocations = await vscode.commands.executeCommand(
    "vscode.executeTypeDefinitionProvider",
    document.uri,
    declarations[0].start
  );
  if (!typeLocations || !typeLocations.length) {
    return [];
  }

  const result = [];
  const seen = new Set();

  for (const locationLike of typeLocations) {
    const location = toLocation(locationLike);
    if (!location) {
      continue;
    }

    const targetDocument = location.uri.toString() === document.uri.toString()
      ? document
      : await vscode.workspace.openTextDocument(location.uri);
    const targetClassRange = findEnclosingClassRange(targetDocument, location.range.start);
    if (!targetClassRange) {
      continue;
    }
    const key = `${location.uri.toString()}::${targetClassRange.start.line}:${targetClassRange.start.character}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push({ document: targetDocument, classRange: targetClassRange });
  }

  return result;
}

function findTypeBodyRangesByName(document, typeName) {
  const text = document.getText();
  const escaped = escapeRegExp(typeName);
  const patterns = [
    new RegExp(`\\b(?:export\\s+)?(?:default\\s+)?(?:abstract\\s+)?(?:class|interface)\\s+${escaped}\\b[^\\{]*\\{`, "g"),
    new RegExp(`\\b(?:export\\s+)?(?:default\\s+)?type\\s+${escaped}\\b[^=\\n]*=\\s*\\{`, "g")
  ];
  const ranges = [];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const start = match.index || 0;
      const openBrace = start + match[0].lastIndexOf("{");
      let depth = 1;
      let i = openBrace + 1;
      for (; i < text.length; i += 1) {
        const ch = text[i];
        if (ch === "{") {
          depth += 1;
        } else if (ch === "}") {
          depth -= 1;
          if (depth === 0) {
            break;
          }
        }
      }
      if (depth === 0) {
        ranges.push(new vscode.Range(document.positionAt(start), document.positionAt(i + 1)));
      }
    }
  }

  return ranges;
}

function extractRxGenericTypeName(document, declarationRange, memberName) {
  const text = document.getText();
  const startOffset = document.offsetAt(declarationRange.start);
  const tail = text.slice(startOffset, Math.min(text.length, startOffset + 650));
  const escaped = escapeRegExp(memberName);
  const typeArgPattern = `(any|\\{[^>]*?\\}|[A-Za-z_$][\\w$]*)`;
  const patterns = [
    // `foo: Rx<T>;` or `foo: RxFunc<T>;`
    new RegExp(`^${escaped}(?:[!?])?\\s*:\\s*[^=;\\n]*\\bRx(?:Func)?\\s*<\\s*(${typeArgPattern})\\s*>`),
    // `foo = this.newRx<T>(...);` or `foo = newRx<T>(...);`
    new RegExp(`^${escaped}(?:[!?])?\\s*=\\s*(?:this\\.)?newRx(?:Func)?\\s*<\\s*(${typeArgPattern})\\s*>`)
  ];

  for (const pattern of patterns) {
    const match = pattern.exec(tail);
    if (match && match[1]) {
      const matchedTypeArg = match[1];
      const matchedStartInTail = match.index || 0;
      const matchedInWhole = match[0].indexOf(matchedTypeArg);
      const absTypeArgStart = startOffset + matchedStartInTail + matchedInWhole;
      const absTypeArgEnd = absTypeArgStart + matchedTypeArg.length;

      if (matchedTypeArg === "any") {
        return { typeName: "any" };
      }

      if (matchedTypeArg.startsWith("{")) {
        return {
          inlineTypeLiteralRange: {
            startOffset: absTypeArgStart,
            endOffset: absTypeArgEnd
          }
        };
      }

      return { typeName: matchedTypeArg };
    }
  }

  return null;
}

function getContextKey(context) {
  return `${context.document.uri.toString()}::${context.classRange.start.line}:${context.classRange.start.character}`;
}

function uniqueContexts(contexts) {
  const result = [];
  const seen = new Set();
  for (const context of contexts) {
    const key = getContextKey(context);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(context);
  }
  return result;
}

function parseOwnerAccessorExpression(expression) {
  const normalized = normalizeRepeatExpression(expression || "");
  const match = normalized.match(RE_OWNER_CHAIN_EXACT);
  if (!match) {
    return null;
  }

  const segments = parseAccessorChainSegments(match[2] || "");
  if (!segments.length) {
    return null;
  }

  return {
    owner: match[1],
    segments
  };
}

async function resolveMemberSegmentsFromContexts(contexts, segments) {
  if (!contexts || !contexts.length || !segments || !segments.length) {
    return [];
  }

  let currentContexts = contexts;
  let sourceContexts = currentContexts;
  let sourceMemberName = null;

  for (const segment of segments) {
    if (segment.kind === "member") {
      sourceContexts = currentContexts;
      sourceMemberName = segment.name;
      currentContexts = await resolveContextsByMemberName(currentContexts, segment.name);
    } else if (segment.kind === "rx") {
      currentContexts = await resolveRxValueContexts(currentContexts, sourceContexts, sourceMemberName);
    }

    if (!currentContexts.length) {
      return [];
    }
  }

  return currentContexts;
}

async function getThisContextsFromRepeatChain(document, position, templateTarget, classRange) {
  if (!classRange) {
    return [];
  }

  const raw = templateTarget.raw;
  const absoluteOffset = document.offsetAt(position);
  const templateStart = document.offsetAt(templateTarget.range.start);
  const relativeOffset = absoluteOffset - templateStart;
  const repeatChain = getRepeatExpressionChain(raw, relativeOffset);

  const rootContexts = [{ document, classRange }];
  let thisContexts = rootContexts;

  if (!repeatChain.length) {
    return thisContexts;
  }

  for (const repeatExpression of repeatChain) {
    const parsed = parseOwnerAccessorExpression(repeatExpression);
    if (!parsed) {
      continue;
    }

    const baseContexts = parsed.owner === "root" ? rootContexts : thisContexts;
    if (!baseContexts.length) {
      thisContexts = [];
      continue;
    }

    thisContexts = await resolveMemberSegmentsFromContexts(baseContexts, parsed.segments);
  }

  return uniqueContexts(thisContexts);
}

function collectMembersFromContexts(contexts) {
  const result = [];
  const seenMembers = new Set();
  for (const context of contexts) {
    const members = collectComponentMembers(context.document).filter((member) =>
      context.classRange.contains(member.range.start)
    );
    for (const member of members) {
      if (seenMembers.has(member.name)) {
        continue;
      }
      seenMembers.add(member.name);
      result.push(member);
    }
  }
  return result;
}

function resolveContextsByTypeName(contexts, typeName) {
  const resolved = [];

  for (const context of contexts) {
    const ranges = findTypeBodyRangesByName(context.document, typeName);
    for (const range of ranges) {
      resolved.push({ document: context.document, classRange: range });
    }
  }

  return uniqueContexts(resolved);
}

async function resolveContextsByMemberName(contexts, memberName) {
  const nextContexts = [];

  for (const context of contexts) {
    const resolved = await getMemberTypeContexts(context.document, memberName, context.classRange);
    nextContexts.push(...resolved);
  }

  return uniqueContexts(nextContexts);
}

async function resolveRxValueContexts(contexts, sourceContexts, sourceMemberName) {
  if (!sourceContexts || !sourceContexts.length || !sourceMemberName) {
    return resolveContextsByMemberName(contexts, "actual");
  }

  const typeNames = new Set();
  let hasAny = false;
  const inlineContexts = [];
  for (const sourceContext of sourceContexts) {
    const declarations = findMemberDeclarations(
      sourceContext.document,
      sourceMemberName,
      sourceContext.classRange
    );
    for (const declaration of declarations) {
      const rxGenericInfo = extractRxGenericTypeName(
        sourceContext.document,
        declaration,
        sourceMemberName
      );
      if (rxGenericInfo) {
        if (rxGenericInfo.typeName) {
          const typeName = rxGenericInfo.typeName;
          if (typeName === "any") {
            hasAny = true;
          } else {
            typeNames.add(typeName);
          }
        } else if (rxGenericInfo.inlineTypeLiteralRange) {
          inlineContexts.push({
            document: sourceContext.document,
            classRange: new vscode.Range(
              sourceContext.document.positionAt(rxGenericInfo.inlineTypeLiteralRange.startOffset),
              sourceContext.document.positionAt(rxGenericInfo.inlineTypeLiteralRange.endOffset)
            )
          });
        }
      }
    }
  }

  // `Rx<any>` can't be unwrapped into a concrete type declaration; fall back to
  // member resolution via `Rx['actual']` instead.
  if (!typeNames.size && !inlineContexts.length && hasAny) {
    return resolveContextsByMemberName(contexts, "actual");
  }

  let resolved = [];
  for (const typeName of typeNames) {
    resolved = resolved.concat(resolveContextsByTypeName(sourceContexts, typeName));
  }

  if (inlineContexts.length) {
    resolved = resolved.concat(inlineContexts);
  }

  if (resolved.length) {
    return uniqueContexts(resolved);
  }

  return resolveContextsByMemberName(contexts, "actual");
}

async function collectMemberTypeMembers(document, memberSegments, classRange) {
  if (!memberSegments || !memberSegments.length) {
    return [];
  }

  let contexts = [{ document, classRange }];
  let sourceContexts = contexts;
  let sourceMemberName = null;
  for (const segment of memberSegments) {
    if (segment.kind === "member") {
      sourceContexts = contexts;
      sourceMemberName = segment.name;
      contexts = await resolveContextsByMemberName(contexts, segment.name);
    } else if (segment.kind === "rx") {
      contexts = await resolveRxValueContexts(contexts, sourceContexts, sourceMemberName);
    }

    if (!contexts.length) {
      return [];
    }
  }

  const result = [];
  const seenMembers = new Set();

  for (const context of contexts) {
    const members = collectComponentMembers(context.document).filter((member) =>
      context.classRange.contains(member.range.start)
    );
    for (const member of members) {
      if (seenMembers.has(member.name)) {
        continue;
      }
      seenMembers.add(member.name);
      result.push(member);
    }
  }

  return result;
}

async function resolveAccessorSegmentDeclarations(document, accessorMember, classRange) {
  const targetSegmentIndex = typeof accessorMember.targetSegmentIndex === "number"
    ? accessorMember.targetSegmentIndex
    : null;
  const segments = accessorMember.segments && accessorMember.segments.length
    ? accessorMember.segments
    : null;
  if (!segments || targetSegmentIndex === null) {
    return findMemberDeclarations(document, accessorMember.name, classRange).map((range) => ({
      document,
      range
    }));
  }

  let contexts = [{ document, classRange }];
  let sourceContexts = contexts;
  let sourceMemberName = null;
  for (let i = 0; i < targetSegmentIndex; i += 1) {
    const segment = segments[i];
    if (segment.kind === "member") {
      sourceContexts = contexts;
      sourceMemberName = segment.name;
      contexts = await resolveContextsByMemberName(contexts, segment.name);
    } else if (segment.kind === "rx") {
      contexts = await resolveRxValueContexts(contexts, sourceContexts, sourceMemberName);
    }

    if (!contexts.length) {
      return [];
    }
  }

  const target = segments[targetSegmentIndex];
  if (!target || target.kind !== "member") {
    return [];
  }

  const result = [];
  const seenRanges = new Set();
  for (const context of contexts) {
    const declarations = findMemberDeclarations(context.document, target.name, context.classRange);
    for (const range of declarations) {
      const key = `${context.document.uri.toString()}::${range.start.line}:${range.start.character}:${range.end.line}:${range.end.character}`;
      if (seenRanges.has(key)) {
        continue;
      }
      seenRanges.add(key);
      result.push({ document: context.document, range });
    }
  }

  return result;
}

function buildCruzoAttributeCompletions() {
  const attrs = [
    {
      label: "repeat",
      detail: "Cruzo repeat directive",
      snippet: "repeat=\"{{ $1 }}\""
    },
    {
      label: "attached",
      detail: "Cruzo conditional attach",
      snippet: "attached=\"{{ $1 }}\""
    },
    {
      label: "inner-html",
      detail: "Cruzo dynamic innerHTML",
      snippet: "inner-html=\"{{ $1 }}\""
    },
    {
      label: "let-",
      detail: "Cruzo lexical variable",
      snippet: "let-${1:name}=\"{{ $2 }}\""
    }
  ];

  const domEvents = [
    "abort", "afterprint", "animationcancel", "animationend", "animationiteration", "animationstart",
    "auxclick", "beforeinput", "beforeprint", "beforeunload", "blur", "cancel", "canplay",
    "canplaythrough", "change", "click", "close", "compositionend", "compositionstart", "compositionupdate",
    "contextmenu", "copy", "cuechange", "cut", "dblclick", "drag", "dragend", "dragenter", "dragleave",
    "dragover", "dragstart", "drop", "durationchange", "emptied", "ended", "error", "focus", "focusin",
    "focusout", "formdata", "fullscreenchange", "fullscreenerror", "gotpointercapture", "hashchange",
    "input", "invalid", "keydown", "keypress", "keyup", "languagechange", "load", "loadeddata",
    "loadedmetadata", "loadstart", "lostpointercapture", "message", "messageerror", "mousedown",
    "mouseenter", "mouseleave", "mousemove", "mouseout", "mouseover", "mouseup", "offline", "online",
    "open", "pagehide", "pageshow", "paste", "pause", "play", "playing", "pointercancel", "pointerdown",
    "pointerenter", "pointerleave", "pointermove", "pointerout", "pointerover", "pointerup", "popstate",
    "progress", "ratechange", "reset", "resize", "scroll", "scrollend", "securitypolicyviolation", "seeked",
    "seeking", "select", "selectionchange", "selectstart", "slotchange", "stalled", "storage", "submit",
    "suspend", "timeupdate", "toggle", "touchcancel", "touchend", "touchmove", "touchstart",
    "transitioncancel", "transitionend", "transitionrun", "transitionstart", "unload", "volumechange",
    "waiting", "wheel"
  ];
  const events = domEvents.map((eventName) => `on${eventName}`);

  const items = attrs.map((attr) => {
    const item = new vscode.CompletionItem(attr.label, vscode.CompletionItemKind.Property);
    item.detail = attr.detail;
    item.insertText = new vscode.SnippetString(attr.snippet);
    item.documentation = new vscode.MarkdownString(`Cruzo attribute \`${attr.label}\`.`);
    return item;
  });

  for (const ev of events) {
    const item = new vscode.CompletionItem(ev, vscode.CompletionItemKind.Event);
    item.detail = "Cruzo event expression";
    item.insertText = new vscode.SnippetString(`${ev}=\"{{ $1 }}\"`);
    item.documentation = new vscode.MarkdownString(`Event handler in Cruzo template: \`${ev}\`.`);
    items.push(item);
  }

  const dynamicEvent = new vscode.CompletionItem("on...", vscode.CompletionItemKind.Snippet);
  dynamicEvent.detail = "Cruzo dynamic event attribute";
  dynamicEvent.insertText = new vscode.SnippetString("on${1:event}=\"{{ $2 }}\"");
  dynamicEvent.documentation = new vscode.MarkdownString(
    "Generic event attribute snippet. Use for rare or custom events."
  );
  items.push(dynamicEvent);

  return items;
}

function buildCruzoKeywordCompletions() {
  const keywords = [
    { label: "root", doc: "Current component instance in Cruzo template expressions." },
    { label: "this", doc: "Current repeat item (or component context depending on expression)." },
    { label: "index", doc: "Current index in repeat context." },
    { label: "event", doc: "Current DOM event in on* handler expressions." },
    { label: "::rx", doc: "Reads reactive value from Rx." },
    { label: "once::", doc: "Evaluates expression once and caches the result." }
  ];

  return keywords.map((keyword) => {
    const item = new vscode.CompletionItem(keyword.label, vscode.CompletionItemKind.Keyword);
    item.documentation = new vscode.MarkdownString(keyword.doc);
    return item;
  });
}

function getCruzoHoverForWord(word) {
  const docs = {
    repeat: "Repeats node by array/number expression.",
    attached: "Attaches/detaches node depending on expression truthiness.",
    "inner-html": "Sets `innerHTML` from expression result.",
    index: "Current index in `repeat` scope.",
    event: "Current event in `on*` expression.",
    let: "Prefix for lexical template variables via `let-*` attributes.",
    root: "Component instance in template expression.",
    this: "Repeat item (or current context).",
    "::rx": "Reactive unwrap operator for `Rx` values.",
    "once::": "Runs expression once and memoizes result."
  };

  if (!docs[word]) {
    return null;
  }

  return new vscode.Hover(new vscode.MarkdownString(docs[word]));
}

function normalizeHoverContents(contents) {
  if (!contents || !contents.length) {
    return "";
  }

  const parts = contents.map((item) => {
    if (typeof item === "string") {
      return item;
    }
    if (item instanceof vscode.MarkdownString) {
      return item.value;
    }
    if (item && typeof item === "object" && "value" in item) {
      return `\`\`\`${item.language || ""}\n${item.value}\n\`\`\``;
    }
    return "";
  }).filter(Boolean);

  return parts.join("\n\n");
}

async function getTypeHoverAtLocation(uri, position) {
  try {
    const hovers = await vscode.commands.executeCommand(
      "vscode.executeHoverProvider",
      uri,
      position
    );

    if (!hovers || !hovers.length) {
      return null;
    }

    const markdown = normalizeHoverContents(hovers[0].contents);
    if (!markdown) {
      return null;
    }

    return new vscode.Hover(new vscode.MarkdownString(markdown));
  } catch {
    return null;
  }
}

function collectTemplateRootMemberOccurrences(document, memberName, indentSize) {
  const occurrences = [];
  const targets = getTemplateLiteralTargetsCached(document, indentSize);
  const pattern = new RegExp(`\\broot\\.(${escapeRegExp(memberName)})\\b`, "g");

  for (const target of targets) {
    const raw = document.getText(target.range);
    if (!looksLikeCruzoTemplate(raw)) {
      continue;
    }

    const targetStartOffset = document.offsetAt(target.range.start);
    for (const match of raw.matchAll(pattern)) {
      const full = match[0];
      const member = match[1];
      const fullIndex = match.index || 0;
      const memberStart = targetStartOffset + fullIndex + full.indexOf(member);
      const memberEnd = memberStart + member.length;
      occurrences.push(
        new vscode.Range(document.positionAt(memberStart), document.positionAt(memberEnd))
      );
    }
  }

  return occurrences;
}

async function findSelectorLocations(selectorName) {
  const cacheKey = `${selectorLocationCacheRevision}:${selectorName}`;
  const cached = selectorLocationCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const files = await vscode.workspace.findFiles("**/*.{ts,js}", "**/{node_modules,dist,.git}/**");
  const escaped = escapeRegExp(selectorName);
  const selectorPattern = new RegExp(`\\bselector\\s*=\\s*["'\`]${escaped}["'\`]`, "g");
  const locations = [];

  for (const uri of files) {
    const document = await vscode.workspace.openTextDocument(uri);
    const text = document.getText();
    let match;
    while ((match = selectorPattern.exec(text)) !== null) {
      const matchText = match[0];
      const selectorIndexInMatch = matchText.lastIndexOf(selectorName);
      const start = (match.index || 0) + selectorIndexInMatch;
      const end = start + selectorName.length;
      locations.push(new vscode.Location(uri, new vscode.Range(document.positionAt(start), document.positionAt(end))));
    }
  }

  selectorLocationCache.set(cacheKey, locations);
  return locations;
}

function activate(context) {
  const supportedLanguageIds = getSupportedLanguageIds();
  const selector = Array.from(supportedLanguageIds).map((language) => ({ language }));
  const readIndentSize = () => {
    const config = vscode.workspace.getConfiguration();
    return Math.max(1, Math.min(8, config.get("cruzo.format.indentSize", 2)));
  };
  let indentSize = readIndentSize();
  const getIndentSize = () => indentSize;
  const invalidateAnalysisCaches = () => {
    templateTargetsCache.clear();
    componentMembersCache.clear();
  };
  const invalidateSelectorCache = () => {
    selectorLocationCacheRevision += 1;
    selectorLocationCache.clear();
  };

  const formatCurrentFileCommand = vscode.commands.registerCommand("cruzo.formatTemplatesInFile", async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }

    if (!supportedLanguageIds.has(editor.document.languageId)) {
      vscode.window.showInformationMessage("Cruzo formatter supports only .ts and .js files.");
      return;
    }

    const edits = buildTemplateEdits(editor.document, getIndentSize());
    if (!edits.length) {
      vscode.window.showInformationMessage("No template literals suitable for formatting found in current file.");
      return;
    }

    await editor.edit((editBuilder) => {
      for (const item of edits) {
        editBuilder.replace(item.range, item.formatted);
      }
    });
  });

  const formatWorkspaceCommand = vscode.commands.registerCommand("cruzo.formatTemplatesInWorkspace", async () => {
    const currentIndentSize = getIndentSize();
    const files = await vscode.workspace.findFiles("**/*.{ts,js}", "**/{node_modules,dist,.git}/**");
    const workspaceFolders = vscode.workspace.workspaceFolders || [];
    const ignoredMatcherByFolder = new Map();

    for (const folder of workspaceFolders) {
      ignoredMatcherByFolder.set(folder.uri.toString(), await readGitignoreMatcher(folder));
    }

    if (!files.length) {
      vscode.window.showInformationMessage("No .ts or .js files found in workspace.");
      return;
    }

    const workspaceEdit = new vscode.WorkspaceEdit();
    let touchedDocs = 0;
    let formattedBlocks = 0;

    for (const uri of files) {
      const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
      if (workspaceFolder) {
        const matcher = ignoredMatcherByFolder.get(workspaceFolder.uri.toString()) || null;
        const relativePath = normalizeToPosix(path.relative(workspaceFolder.uri.fsPath, uri.fsPath));
        if (isPathIgnoredByMatcher(relativePath, matcher)) {
          continue;
        }
      }

      const document = await vscode.workspace.openTextDocument(uri);
      if (!supportedLanguageIds.has(document.languageId)) {
        continue;
      }

      const edits = buildTemplateEdits(document, currentIndentSize);
      if (!edits.length) {
        continue;
      }

      touchedDocs += 1;
      formattedBlocks += edits.length;

      for (const item of edits) {
        workspaceEdit.replace(uri, item.range, item.formatted);
      }
    }

    if (!formattedBlocks) {
      vscode.window.showInformationMessage("No template literals suitable for formatting found in .ts/.js workspace files.");
      return;
    }

    await vscode.workspace.applyEdit(workspaceEdit);
    vscode.window.showInformationMessage(
      `Cruzo formatted ${formattedBlocks} template blocks in ${touchedDocs} files.`
    );
  });

  const definitionProvider = vscode.languages.registerDefinitionProvider(selector, {
    async provideDefinition(document, position) {
      try {
        const templateTarget = getTemplateTargetAtPosition(document, position, getIndentSize());
        if (!templateTarget) {
          return null;
        }

        const classRange = findEnclosingClassRange(document, templateTarget.range.start);
        const accessorMember = getTemplateAccessorMemberAtPosition(document, position, templateTarget)
          || getRootMemberAtPosition(document, position, templateTarget);
        if (accessorMember) {
          const declarationCandidates = await resolveAccessorSegmentDeclarations(
            document,
            accessorMember,
            classRange
          );
          if (declarationCandidates.length) {
            return declarationCandidates.map((candidate) =>
              new vscode.Location(candidate.document.uri, candidate.range)
            );
          }

          const targetSegmentIndex = typeof accessorMember.targetSegmentIndex === "number"
            ? accessorMember.targetSegmentIndex
            : 0;
          if (targetSegmentIndex === 0 && accessorMember.owner === "this") {
            const thisContexts = await getThisContextsFromRepeatChain(
              document,
              position,
              templateTarget,
              classRange
            );
            const thisDeclarationCandidates = [];
            const seen = new Set();
            for (const context of thisContexts) {
              const declarationRanges = findMemberDeclarations(context.document, accessorMember.name, context.classRange);
              for (const range of declarationRanges) {
                const key = `${context.document.uri.toString()}::${range.start.line}:${range.start.character}`;
                if (seen.has(key)) {
                  continue;
                }
                seen.add(key);
                thisDeclarationCandidates.push(new vscode.Location(context.document.uri, range));
              }
            }
            if (thisDeclarationCandidates.length) {
              return thisDeclarationCandidates;
            }

            const repeatMemberDefinitions = findThisRepeatMemberDefinitions(
              document,
              position,
              templateTarget,
              accessorMember.name,
              classRange
            );
            if (repeatMemberDefinitions.length) {
              return repeatMemberDefinitions.map((range) => new vscode.Location(document.uri, range));
            }
          }
        }

      const letMember = getLetMemberAtPosition(document, position, templateTarget);
      if (letMember) {
        return [new vscode.Location(document.uri, letMember.declarationRange)];
      }

        const wordRange = getWordRangeAtPosition(document, position);
        if (!wordRange) {
          return null;
        }

        const fallbackWord = document.getText(wordRange);
        if (RE_IDENTIFIER.test(fallbackWord)) {
          const declarations = findMemberDeclarations(document, fallbackWord, classRange);
          if (declarations.length) {
            return declarations.map((range) => new vscode.Location(document.uri, range));
          }
        }

        const lineText = document.lineAt(position.line).text;
        if (!isTagContext(lineText, wordRange.start.character)) {
          return null;
        }

        const tagName = document.getText(wordRange).toLowerCase();
        return findSelectorLocations(tagName);
      } catch {
        return null;
      }
    }
  });

  const referenceProvider = vscode.languages.registerReferenceProvider(selector, {
    provideReferences(document, position) {
      const currentIndentSize = getIndentSize();
      const templateTarget = getTemplateTargetAtPosition(document, position, currentIndentSize);
      if (!templateTarget) {
        return null;
      }

      const classRange = findEnclosingClassRange(document, templateTarget.range.start);
      const rootMember = getRootMemberAtPosition(document, position, templateTarget);
      if (!rootMember) {
        return null;
      }

      const declarationRanges = findMemberDeclarations(document, rootMember.name, classRange);
      const templateRanges = collectTemplateRootMemberOccurrences(document, rootMember.name, currentIndentSize);
      const ranges = [...declarationRanges, ...templateRanges];

      if (!ranges.length) {
        return null;
      }

      return ranges.map((range) => new vscode.Location(document.uri, range));
    }
  });

  const renameProvider = vscode.languages.registerRenameProvider(selector, {
    prepareRename(document, position) {
      const templateTarget = getTemplateTargetAtPosition(document, position, getIndentSize());
      if (!templateTarget) {
        throw new Error("Rename is available only for Cruzo expressions in template literals.");
      }

      const rootMember = getRootMemberAtPosition(document, position, templateTarget);
      if (!rootMember) {
        throw new Error("Place cursor on a root.* member inside Cruzo template.");
      }

      return rootMember.wordRange;
    },
    async provideRenameEdits(document, position, newName) {
      const currentIndentSize = getIndentSize();
      const templateTarget = getTemplateTargetAtPosition(document, position, currentIndentSize);
      if (!templateTarget) {
        return null;
      }

      const classRange = findEnclosingClassRange(document, templateTarget.range.start);
      const rootMember = getRootMemberAtPosition(document, position, templateTarget);
      if (!rootMember) {
        return null;
      }

      const declarationRanges = findMemberDeclarations(document, rootMember.name, classRange);
      const workspaceEdit = new vscode.WorkspaceEdit();
      const templateRanges = collectTemplateRootMemberOccurrences(document, rootMember.name, currentIndentSize);
      for (const range of templateRanges) {
        workspaceEdit.replace(document.uri, range, newName);
      }

      if (!declarationRanges.length) {
        return workspaceEdit;
      }

      const declarationPosition = declarationRanges[0].start;
      try {
        const tsRenameEdit = await vscode.commands.executeCommand(
          "vscode.executeDocumentRenameProvider",
          document.uri,
          declarationPosition,
          newName
        );
        if (tsRenameEdit) {
          for (const [uri, edits] of tsRenameEdit.entries()) {
            for (const edit of edits) {
              workspaceEdit.replace(uri, edit.range, edit.newText);
            }
          }
        }
      } catch {
        for (const range of declarationRanges) {
          workspaceEdit.replace(document.uri, range, newName);
        }
      }

      return workspaceEdit;
    }
  });

  const completionProvider = vscode.languages.registerCompletionItemProvider(
    selector,
    {
      async provideCompletionItems(document, position) {
        const templateTarget = getTemplateTargetAtPosition(document, position, getIndentSize());
        if (!templateTarget) {
          return null;
        }
        const classRange = findEnclosingClassRange(document, templateTarget.range.start);

        const ownerMember = getCompletionOwnerMemberForPosition(document, position);
        if (ownerMember) {
          let nestedMembers = [];
          if (ownerMember.owner === "this") {
            const thisContexts = await getThisContextsFromRepeatChain(document, position, templateTarget, classRange);
            const nestedContexts = await resolveMemberSegmentsFromContexts(thisContexts, ownerMember.segments);
            nestedMembers = collectMembersFromContexts(nestedContexts);
          } else {
            nestedMembers = await collectMemberTypeMembers(document, ownerMember.segments, classRange);
          }
          if (nestedMembers.length) {
            return nestedMembers.map((member) => {
              const item = new vscode.CompletionItem(member.name, member.kind);
              item.detail = `${ownerMember.owner} member class property`;
              return item;
            });
          }
        }

        const owner = getExpressionOwnerForCompletion(document, position);
        if (owner === "root") {
          const members = collectComponentMembers(document);
          return members.map((member) => {
            const item = new vscode.CompletionItem(member.name, member.kind);
            item.detail = "Cruzo component member";
            return item;
          });
        } else if (owner === "this") {
          const thisContexts = await getThisContextsFromRepeatChain(document, position, templateTarget, classRange);
          const thisMembers = collectMembersFromContexts(thisContexts);
          if (thisMembers.length) {
            return thisMembers.map((member) => {
              const item = new vscode.CompletionItem(member.name, member.kind);
              item.detail = "Cruzo context member";
              return item;
            });
          }
        }        

        const lineText = document.lineAt(position.line).text.slice(0, position.character);
        if (RE_ATTR_CONTEXT.test(lineText)) {
          return buildCruzoAttributeCompletions();
        }

        return buildCruzoKeywordCompletions();
      }
    },
    ".", ":", "-", "$"
  );

  const hoverProvider = vscode.languages.registerHoverProvider(selector, {
    async provideHover(document, position) {
      const templateTarget = getTemplateTargetAtPosition(document, position, getIndentSize());
      if (!templateTarget) {
        return null;
      }

      const classRange = findEnclosingClassRange(document, templateTarget.range.start);
      const accessorMember = getTemplateAccessorMemberAtPosition(document, position, templateTarget);
      if (accessorMember) {
        const declarationCandidates = await resolveAccessorSegmentDeclarations(
          document,
          accessorMember,
          classRange
        );
        const targetSegmentIndex = typeof accessorMember.targetSegmentIndex === "number"
          ? accessorMember.targetSegmentIndex
          : 0;

        for (const candidate of declarationCandidates) {
          const typeHover = await getTypeHoverAtLocation(candidate.document.uri, candidate.range.start);
          if (typeHover) {
            return typeHover;
          }
        }

        if (targetSegmentIndex === 0 && accessorMember.owner === "this") {
          const thisContexts = await getThisContextsFromRepeatChain(
            document,
            position,
            templateTarget,
            classRange
          );
          for (const context of thisContexts) {
            const declarations = findMemberDeclarations(context.document, accessorMember.name, context.classRange);
            for (const declaration of declarations) {
              const typeHover = await getTypeHoverAtLocation(context.document.uri, declaration.start);
              if (typeHover) {
                return typeHover;
              }
            }
          }

          const repeatMemberDefinitions = findThisRepeatMemberDefinitions(
            document,
            position,
            templateTarget,
            accessorMember.name,
            classRange
          );
          if (repeatMemberDefinitions.length) {
            const declarationLine = document.lineAt(repeatMemberDefinitions[0].start.line).text.trim();
            return new vscode.Hover(
              new vscode.MarkdownString(`Repeat item field \`${accessorMember.name}\`\n\n\`${declarationLine}\``)
            );
          }
        }
      }

      const letAttribute = getLetAttributeAtPosition(document, position, templateTarget);
      if (letAttribute) {
        return new vscode.Hover(
          new vscode.MarkdownString(
            `Lexical Cruzo variable declaration via \`let-${letAttribute.name}\`.`
          )
        );
      }

      const letMember = getLetMemberAtPosition(document, position, templateTarget);
      if (letMember) {
        const declarationLine = document.lineAt(letMember.declarationRange.start.line).text.trim();
        return new vscode.Hover(
          new vscode.MarkdownString(`Cruzo lexical variable \`${letMember.name}\`\n\n\`${declarationLine}\``)
        );
      }

      const line = document.lineAt(position.line).text;
      const index = position.character;
      if (line.slice(Math.max(0, index - 4), index + 1).includes("::rx")) {
        return getCruzoHoverForWord("::rx");
      }
      if (line.slice(Math.max(0, index - 8), index + 1).includes("once::")) {
        return getCruzoHoverForWord("once::");
      }

      const wordRange = document.getWordRangeAtPosition(position, RE_HOVER_WORD);
      if (!wordRange) {
        return null;
      }
      const word = document.getText(wordRange);
      return getCruzoHoverForWord(word);
    }
  });

  context.subscriptions.push(
    formatCurrentFileCommand,
    formatWorkspaceCommand,
    definitionProvider,
    referenceProvider,
    renameProvider,
    completionProvider,
    hoverProvider
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("cruzo.format.indentSize")) {
        indentSize = readIndentSize();
        invalidateAnalysisCaches();
      }
    }),
    vscode.workspace.onDidCloseTextDocument(() => {
      invalidateAnalysisCaches();
    }),
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (supportedLanguageIds.has(doc.languageId)) {
        invalidateSelectorCache();
        invalidateAnalysisCaches();
      }
    }),
    vscode.workspace.onDidCreateFiles(() => {
      invalidateSelectorCache();
      invalidateAnalysisCaches();
    }),
    vscode.workspace.onDidDeleteFiles(() => {
      invalidateSelectorCache();
      invalidateAnalysisCaches();
    }),
    vscode.workspace.onDidRenameFiles(() => {
      invalidateSelectorCache();
      invalidateAnalysisCaches();
    })
  );
}

function deactivate() {}

module.exports = {
  activate,
  deactivate
};
