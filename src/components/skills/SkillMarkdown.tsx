import type { ReactNode } from "react";

export function splitSkillMarkdown(raw: string): {
  yaml: string;
  body: string;
  hasYaml: boolean;
} {
  const text = raw.replace(/\r\n/g, "\n");
  if (!text.startsWith("---\n") && text !== "---") {
    return { yaml: "", body: text, hasYaml: false };
  }
  const after = text.startsWith("---\n") ? text.slice(4) : "";
  const match = after.match(/\n---[ \t]*(?:\n|$)/);
  if (!match || match.index === undefined) {
    return { yaml: "", body: text, hasYaml: false };
  }
  return {
    yaml: after.slice(0, match.index).replace(/\s+$/, ""),
    body: after.slice(match.index + match[0].length),
    hasYaml: true,
  };
}

export function unwrapQuotePrefix(line: string): string | null {
  if (!line.startsWith(">")) return null;
  if (line.startsWith("> ")) return line.slice(2);
  return line.slice(1);
}

function renderInline(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern =
    /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)|(\[[^\]]+\]\([^)]+\))/g;
  let last = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  while ((match = pattern.exec(text))) {
    if (match.index > last) {
      nodes.push(text.slice(last, match.index));
    }
    const token = match[0];
    if (token.startsWith("`")) {
      nodes.push(
        <code
          key={key++}
          className="rounded-[3px] bg-muted px-1 py-px font-mono text-[12.35px] leading-[1.3]"
        >
          {token.slice(1, -1)}
        </code>,
      );
    } else if (token.startsWith("**")) {
      nodes.push(<strong key={key++}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith("*")) {
      nodes.push(<em key={key++}>{token.slice(1, -1)}</em>);
    } else {
      const link = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      if (link) {
        nodes.push(
          <a
            key={key++}
            href={link[2]}
            target="_blank"
            rel="noreferrer"
            className="text-blue-500 underline-offset-2 hover:underline"
          >
            {link[1]}
          </a>,
        );
      }
    }
    last = match.index + token.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

function parseBlocks(
  lines: string[],
  keyStart = 0,
): { nodes: ReactNode[]; nextKey: number } {
  const blocks: ReactNode[] = [];
  let i = 0;
  let key = keyStart;

  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "") {
      i += 1;
      continue;
    }
    if (line.trim() === "---" || line.trim() === "***") {
      blocks.push(<hr key={key++} className="my-2 border-border-default" />);
      i += 1;
      continue;
    }
    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      const level = heading[1].length;
      const className =
        level === 1
          ? "mt-3 mb-1 text-[13.5px] font-semibold leading-[1.3]"
          : level === 2
            ? "mt-2 mb-1 text-[13px] font-semibold leading-[1.3]"
            : "mt-2 mb-0.5 text-[12.35px] font-semibold leading-[1.3]";
      const content = renderInline(heading[2]);
      blocks.push(
        level === 1 ? (
          <h1 key={key++} className={className}>
            {content}
          </h1>
        ) : level === 2 ? (
          <h2 key={key++} className={className}>
            {content}
          </h2>
        ) : level === 3 ? (
          <h3 key={key++} className={className}>
            {content}
          </h3>
        ) : (
          <h4 key={key++} className={className}>
            {content}
          </h4>
        ),
      );
      i += 1;
      continue;
    }
    if (line.startsWith("```")) {
      i += 1;
      const code: string[] = [];
      while (i < lines.length && !lines[i].startsWith("```")) {
        code.push(lines[i]);
        i += 1;
      }
      if (i < lines.length) i += 1;
      blocks.push(
        <pre
          key={key++}
          className="mb-2 overflow-x-auto rounded-[4px] bg-muted px-2 py-1.5 font-mono text-[11.5px] leading-[1.4]"
        >
          {code.join("\n")}
        </pre>,
      );
      continue;
    }
    if (/^\s*[-*]\s+/.test(line) || /^\s*\d+\.\s+/.test(line)) {
      const ordered = /^\s*\d+\.\s+/.test(line);
      const items: string[] = [];
      while (
        i < lines.length &&
        (ordered ? /^\s*\d+\.\s+/ : /^\s*[-*]\s+/).test(lines[i])
      ) {
        items.push(lines[i].replace(/^\s*(?:[-*]|\d+\.)\s+/, ""));
        i += 1;
      }
      const List = ordered ? "ol" : "ul";
      blocks.push(
        <List
          key={key++}
          className={
            ordered
              ? "mb-2 list-decimal space-y-0.5 pl-4 text-[12.35px] leading-[1.3]"
              : "mb-2 list-disc space-y-0.5 pl-4 text-[12.35px] leading-[1.3]"
          }
        >
          {items.map((item, index) => (
            <li key={index}>{renderInline(item)}</li>
          ))}
        </List>,
      );
      continue;
    }
    if (unwrapQuotePrefix(line) !== null) {
      const inner: string[] = [];
      while (i < lines.length) {
        const stripped = unwrapQuotePrefix(lines[i]);
        if (stripped === null) break;
        inner.push(stripped);
        i += 1;
      }
      const nested = parseBlocks(inner, key + 1);
      key = nested.nextKey;
      blocks.push(
        <blockquote
          key={key++}
          className="mb-2 border-l-2 border-border-default pl-2 text-[12.35px] leading-[1.3] text-muted-foreground"
        >
          {nested.nodes}
        </blockquote>,
      );
      continue;
    }
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !lines[i].startsWith("#") &&
      !lines[i].startsWith("```") &&
      !/^\s*[-*]\s+/.test(lines[i]) &&
      !/^\s*\d+\.\s+/.test(lines[i]) &&
      unwrapQuotePrefix(lines[i]) === null
    ) {
      para.push(lines[i]);
      i += 1;
    }
    blocks.push(
      <p
        key={key++}
        className="mb-1.5 text-[12.35px] leading-[1.3] text-foreground"
      >
        {renderInline(para.join(" "))}
      </p>,
    );
  }

  return { nodes: blocks, nextKey: key };
}

export function SkillMarkdownBody({ source }: { source: string }) {
  const lines = source.replace(/\n$/, "").split("\n");
  return <div className="skill-md">{parseBlocks(lines).nodes}</div>;
}
