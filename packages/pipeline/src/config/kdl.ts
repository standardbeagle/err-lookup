/**
 * Minimal KDL parser for the errlookup.config.kdl subset (§4.1).
 *
 * Supports: nodes with string / number / boolean bareword arguments, nested
 * node blocks, line comments (slash-slash), block comments (slash-star),
 * and double-quoted strings. Newline-aware: a bareword at the start of a
 * line is a node name; mid-line barewords are values. Sufficient for the
 * config grammar, not full KDL.
 */

export type KdlValue = string | number | boolean;
export interface KdlNode {
  name: string;
  values: KdlValue[];
  children: KdlNode[];
}
export interface KdlDocument {
  nodes: KdlNode[];
}

type Token =
  | { type: "newline" }
  | { type: "lbrace" }
  | { type: "rbrace" }
  | { type: "string"; value: string }
  | { type: "word"; value: string }
  | { type: "eof" };

class Tokenizer {
  private pos = 0;
  private tokens: Token[] = [];

  constructor(private readonly src: string) {}

  tokenize(): Token[] {
    let atLineStart = true;
    while (this.pos < this.src.length) {
      const c = this.src[this.pos]!;
      if (c === "\n") {
        this.tokens.push({ type: "newline" });
        this.pos++;
        atLineStart = true;
        continue;
      }
      if (c === "\r") {
        this.pos++;
        continue;
      }
      if (c === " " || c === "\t") {
        this.pos++;
        continue;
      }
      if (c === "/" && this.src[this.pos + 1] === "/") {
        while (this.pos < this.src.length && this.src[this.pos] !== "\n") this.pos++;
        continue;
      }
      if (c === "/" && this.src[this.pos + 1] === "*") {
        this.pos += 2;
        while (
          this.pos < this.src.length &&
          !(this.src[this.pos] === "*" && this.src[this.pos + 1] === "/")
        ) {
          this.pos++;
        }
        this.pos += 2;
        continue;
      }
      // Non-whitespace: emit a newline boundary if we transitioned from line start
      // and there's content on the same logical line. (We push newlines for actual
      // \n only; collapsing is done by the parser.)
      if (c === "{") {
        this.tokens.push({ type: "lbrace" });
        this.pos++;
        atLineStart = false;
        continue;
      }
      if (c === "}") {
        this.tokens.push({ type: "rbrace" });
        this.pos++;
        atLineStart = false;
        continue;
      }
      if (c === '"' || c === "'") {
        const value = this.readString();
        this.tokens.push({ type: "string", value });
        atLineStart = false;
        continue;
      }
      // bareword
      const word = this.readBareword();
      this.tokens.push({ type: "word", value: word });
      atLineStart = false;
    }
    this.tokens.push({ type: "eof" });
    return this.tokens;
  }

  private readString(): string {
    const quote = this.src[this.pos]!;
    this.pos++;
    let out = "";
    while (this.pos < this.src.length) {
      const c = this.src[this.pos]!;
      if (c === "\\" && this.pos + 1 < this.src.length) {
        const next = this.src[this.pos + 1]!;
        const map: Record<string, string> = { n: "\n", t: "\t", r: "\r", "\\": "\\", '"': '"', "/": "/" };
        out += map[next] ?? next;
        this.pos += 2;
        continue;
      }
      if (c === quote) {
        this.pos++;
        return out;
      }
      out += c;
      this.pos++;
    }
    throw new SyntaxError("unterminated string");
  }

  private readBareword(): string {
    let out = "";
    while (this.pos < this.src.length) {
      const c = this.src[this.pos]!;
      if (/\s/.test(c) || c === "{" || c === "}" || c === '"' || c === "'") break;
      out += c;
      this.pos++;
    }
    return out;
  }
}

function coerce(word: string): KdlValue {
  if (word === "true") return true;
  if (word === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(word)) return Number(word);
  return word;
}

class Parser {
  private pos = 0;
  constructor(private readonly tokens: Token[]) {}

  private peek(): Token {
    return this.tokens[this.pos] ?? { type: "eof" };
  }

  private skipNewlines(): void {
    while (this.peek().type === "newline") this.pos++;
  }

  parseDocument(): KdlDocument {
    const nodes: KdlNode[] = [];
    this.skipNewlines();
    while (this.peek().type !== "eof") {
      const node = this.parseNode();
      if (node) nodes.push(node);
      this.skipNewlines();
    }
    return { nodes };
  }

  private parseNode(): KdlNode | null {
    const head = this.peek();
    if (head.type !== "word") return null;
    this.pos++;
    const name = head.value;
    const values: KdlValue[] = [];
    const children: KdlNode[] = [];

    while (true) {
      const t = this.peek();
      if (t.type === "eof") break;
      if (t.type === "newline") {
        // end of this node's header line; may be followed by a block or next node
        this.pos++;
        this.skipNewlines();
        // if next is a lbrace, the block belongs to this node
        if (this.peek().type === "lbrace") {
          this.parseBlock(children);
        }
        break;
      }
      if (t.type === "rbrace") break;
      if (t.type === "lbrace") {
        this.parseBlock(children);
        break;
      }
      if (t.type === "string") {
        values.push(t.value);
        this.pos++;
        continue;
      }
      if (t.type === "word") {
        // A bareword mid-line is a value; at line start it would be a new node
        // (but we already consumed the name, so this is always a value here).
        values.push(coerce(t.value));
        this.pos++;
        continue;
      }
      throw new SyntaxError("unexpected token in KDL block");
    }

    return { name, values, children };
  }

  private parseBlock(children: KdlNode[]): void {
    // assumes peek is lbrace
    this.pos++; // consume {
    this.skipNewlines();
    while (true) {
      const t = this.peek();
      if (t.type === "eof") throw new SyntaxError("unterminated block");
      if (t.type === "rbrace") {
        this.pos++;
        break;
      }
      const child = this.parseNode();
      if (child) children.push(child);
      this.skipNewlines();
    }
  }
}

export function parseKdl(src: string): KdlDocument {
  const tokens = new Tokenizer(src).tokenize();
  return new Parser(tokens).parseDocument();
}
