/**
 * Lightweight structural scanner for Verse source. It is NOT a parser: it
 * recovers just enough structure (lines with comments stripped, indentation,
 * enclosing function and block) for doctor rules. Rules built on it are
 * heuristics and say so in their messages.
 */
export interface VerseLine {
  /** 1-based line number. */
  number: number;
  raw: string;
  /** Code with comments and string contents removed. */
  code: string;
  indent: number;
  /** Rule ids suppressed on this line via `# devtools-ignore ID[, ID]`. */
  ignores: Set<string>;
}

export interface VerseFunction {
  name: string;
  line: number;
  indent: number;
  /** Line numbers (inclusive) of the body. */
  bodyStart: number;
  bodyEnd: number;
  effects: string[];
}

export interface VerseBlock {
  kind: "loop" | "for" | "spawn" | "race" | "sync" | "branch" | "block";
  line: number;
  indent: number;
  bodyStart: number;
  bodyEnd: number;
}

export interface VerseFile {
  path: string;
  lines: VerseLine[];
  functions: VerseFunction[];
  blocks: VerseBlock[];
  /** Mixed tab/space indentation, by line. */
  mixedIndent: number[];
}

const IGNORE = /#\s*devtools-ignore\s+([A-Z0-9_,\s-]+)/;

function stripStrings(code: string): string {
  // String contents are already dropped; char literals go the same way.
  return code.replace(/'(?:[^'\\]|\\.)'/g, "''");
}

/** Body extent: following lines indented deeper than `indent` (blank lines included). */
function bodyEnd(lines: VerseLine[], index: number, indent: number): number {
  let end = lines[index]!.number;
  for (let j = index + 1; j < lines.length; j++) {
    const l = lines[j]!;
    if (l.code.trim() === "") continue;
    if (l.indent <= indent) break;
    end = l.number;
  }
  return end;
}

// `Name<spec>(params)<effects>:type =` with the body on following lines or
// inline (`= {}`). The return type may not contain `=`, which keeps
// comparisons like `Foo() = 3` from matching.
const FUNCTION_HEADER = /^([A-Za-z_][A-Za-z0-9_]*)(?:<[^>()]*>)*\s*\(([^)]*)\)\s*((?:<[^>]*>\s*)*):\s*[^=:]+?\s*=(?!=)(.*)$/;
const KEYWORDS = new Set(["if", "for", "loop", "case", "set", "return", "spawn", "race", "sync", "rush", "branch", "block", "then", "else", "not", "and", "or", "do", "while", "break", "defer"]);
const BLOCK_HEADER: [RegExp, VerseBlock["kind"]][] = [
  [/^loop\s*:\s*$/, "loop"],
  [/^for\s*\(.*\)\s*(?:do)?\s*:\s*$/, "for"],
  [/^spawn\s*[:{]/, "spawn"],
  [/^race\s*:\s*$/, "race"],
  [/^sync\s*:\s*$/, "sync"],
  [/^branch\s*:\s*$/, "branch"],
  [/^block\s*:\s*$/, "block"],
];

export function scanVerse(path: string, source: string): VerseFile {
  const rawLines = source.split(/\r?\n/);
  const lines: VerseLine[] = [];
  const mixedIndent: number[] = [];
  let blockCommentDepth = 0;
  for (let i = 0; i < rawLines.length; i++) {
    const raw = rawLines[i]!;
    // One pass with string and comment state: `<# #>` block comments (which
    // nest and span lines), `#` line comments, and "strings" that may
    // contain either.
    let code = "";
    let inString = false;
    for (let k = 0; k < raw.length; k++) {
      const c = raw[k]!;
      if (blockCommentDepth > 0) {
        if (raw.startsWith("<#", k)) {
          blockCommentDepth++;
          k++;
        } else if (raw.startsWith("#>", k)) {
          blockCommentDepth--;
          k++;
        }
        continue;
      }
      if (inString) {
        if (c === "\\") k++;
        else if (c === "{") {
          // Interpolated expressions are code: "{Score}" reads Score.
          const close = raw.indexOf("}", k + 1);
          const end = close < 0 ? raw.length : close;
          code += `(${raw.slice(k + 1, end)})`;
          k = end;
        } else if (c === '"') {
          inString = false;
          code += '"';
        }
        continue;
      }
      if (c === '"') {
        inString = true;
        code += '"';
        continue;
      }
      if (raw.startsWith("<#", k)) {
        blockCommentDepth++;
        k++;
        continue;
      }
      if (c === "#") break;
      code += c;
    }
    const ignoreMatch = IGNORE.exec(raw);
    code = stripStrings(code);
    const leading = /^[\t ]*/.exec(raw)![0];
    if (leading.includes("\t") && leading.includes(" ")) mixedIndent.push(i + 1);
    lines.push({
      number: i + 1,
      raw,
      code: code.trimEnd(),
      indent: leading.replace(/\t/g, "    ").length,
      ignores: new Set(ignoreMatch ? ignoreMatch[1]!.split(/[\s,]+/).filter(Boolean) : []),
    });
  }

  const functions: VerseFunction[] = [];
  const blocks: VerseBlock[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    const text = l.code.trim();
    if (!text) continue;
    const fn = FUNCTION_HEADER.exec(text);
    if (fn && !KEYWORDS.has(fn[1]!)) {
      functions.push({
        name: fn[1]!,
        line: l.number,
        indent: l.indent,
        bodyStart: l.number + 1,
        bodyEnd: bodyEnd(lines, i, l.indent),
        effects: [...(fn[3] ?? "").matchAll(/<([^>]*)>/g)].map((m) => m[1]!.trim()),
      });
      continue;
    }
    for (const [re, kind] of BLOCK_HEADER) {
      if (re.test(text)) {
        blocks.push({ kind, line: l.number, indent: l.indent, bodyStart: l.number + 1, bodyEnd: bodyEnd(lines, i, l.indent) });
        break;
      }
    }
  }
  return { path, lines, functions, blocks, mixedIndent };
}

/** Innermost function containing `line`. */
export function enclosingFunction(file: VerseFile, line: number): VerseFunction | undefined {
  let best: VerseFunction | undefined;
  for (const f of file.functions) {
    if (line >= f.bodyStart && line <= f.bodyEnd && (!best || f.indent > best.indent)) best = f;
  }
  return best;
}

export function blocksContaining(file: VerseFile, line: number): VerseBlock[] {
  return file.blocks.filter((b) => line >= b.bodyStart && line <= b.bodyEnd);
}

export function bodyLines(file: VerseFile, start: number, end: number): VerseLine[] {
  return file.lines.slice(start - 1, end);
}
