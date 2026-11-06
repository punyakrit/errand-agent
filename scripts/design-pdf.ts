import { execFileSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

// Renders docs/DESIGN.md to docs/DESIGN.pdf with headless Chrome, then reports
// the page count. The design note must fit on one page.
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

function inline(text: string): string {
  return text
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
}

// Just enough Markdown for this one document.
function toHtml(markdown: string): string {
  const html: string[] = [];
  let inCode = false;
  let inList = false;
  for (const line of markdown.split("\n")) {
    if (line.startsWith("```")) {
      html.push(inCode ? "</pre>" : "<pre>");
      inCode = !inCode;
    } else if (inCode) {
      html.push(line.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;"));
    } else if (line.startsWith("- ")) {
      if (!inList) html.push("<ul>");
      inList = true;
      html.push(`<li>${inline(line.slice(2))}</li>`);
    } else {
      if (inList) html.push("</ul>");
      inList = false;
      if (line.startsWith("## ")) html.push(`<h2>${inline(line.slice(3))}</h2>`);
      else if (line.startsWith("# ")) html.push(`<h1>${inline(line.slice(2))}</h1>`);
      else if (line.trim()) html.push(`<p>${inline(line)}</p>`);
    }
  }
  if (inList) html.push("</ul>");
  return html.join("\n");
}

const STYLE = `
  @page { size: A4; margin: 10mm 12mm; }
  body { font: 8.3pt/1.27 -apple-system, Helvetica, Arial, sans-serif; color: #111; margin: 0; }
  h1 { font-size: 12.5pt; margin: 0 0 2pt; }
  h2 { font-size: 8.8pt; margin: 4.5pt 0 1pt; }
  p { margin: 0 0 2pt; }
  ul { margin: 0 0 2pt; padding-left: 11pt; }
  code, pre { font: 7.1pt/1.22 Menlo, monospace; }
  pre { margin: 2pt 0; padding: 3pt 4pt; background: #f2f2f2; white-space: pre-wrap; }
`;

const html = `<!doctype html><meta charset="utf-8"><style>${STYLE}</style>${toHtml(readFileSync("docs/DESIGN.md", "utf8"))}`;
const page = resolve("docs/.design.html");
writeFileSync(page, html);
execFileSync(CHROME, ["--headless=new", "--disable-gpu", "--no-pdf-header-footer", `--print-to-pdf=${resolve("docs/DESIGN.pdf")}`, `file://${page}`], { stdio: "ignore" });
rmSync(page);

const info = execFileSync("pdfinfo", ["docs/DESIGN.pdf"], { encoding: "utf8" });
const pages = Number(/Pages:\s+(\d+)/.exec(info)?.[1]);
console.log(`docs/DESIGN.pdf: ${pages} page(s)`);
process.exit(pages === 1 ? 0 : 1);
