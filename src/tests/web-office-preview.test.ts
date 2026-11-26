/// <reference lib="dom" />
import { afterAll, expect, test } from "bun:test";
import { build } from "bun";
import { existsSync, statSync } from "node:fs";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import * as XLSX from "xlsx";
import { OfficePreviewError, sanitizeCss, sanitizeRendered } from "../web/office-viewer";

const root = path.resolve(import.meta.dir, "../..");
const browserModule = process.env.CHAT_UI_BROWSER_MODULE;
const fixtureDir = process.env.CHAT_OFFICE_FIXTURE_DIR;
const defaultPptx = path.join(root, "fixtures/office/sample-rich.pptx");
const pptxFixture = fixtureDir
  ? ["reference.pptx", "sample-rich.pptx", "test.pptx"].map((name) => path.join(fixtureDir, name)).find((file) => existsSync(file)) || defaultPptx
  : defaultPptx;
const PAGE = '<!doctype html><meta charset="utf-8"><body><div id="box"></div><div id="crafted"></div>' +
  '<script src="/assets/dompurify-3.4.7.js"></script></body>';

const DOCX_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

async function makeDocx(): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file("_rels/.rels", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file("word/document.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="${DOCX_NS}"><w:body>` +
    '<w:p><w:r><w:t>Office DOCX fixture</w:t></w:r></w:p>' +
    '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Cell A</w:t></w:r></w:p></w:tc>' +
    '<w:tc><w:p><w:r><w:t>Cell B</w:t></w:r></w:p></w:tc></w:tr>' +
    '<w:tr><w:tc><w:p><w:r><w:t>&lt;img src=x onerror=alert(1)&gt;</w:t></w:r></w:p></w:tc>' +
    '<w:tc><w:p><w:r><w:t>safe</w:t></w:r></w:p></w:tc></w:tr></w:tbl>' +
    '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>' +
    "</w:body></w:document>");
  return zip.generateAsync({ type: "uint8array" });
}

function makeXlsx(): Uint8Array {
  const first = XLSX.utils.aoa_to_sheet([["Name", "Value"], ["<script>window.__xss=1</script>", 42], ["Merged", "cell"], ["Total", 44]]);
  first["!merges"] = [{ s: { r: 2, c: 0 }, e: { r: 2, c: 1 } }];
  const second = XLSX.utils.aoa_to_sheet([["Second sheet"], ["=1+1"]]);
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, first, "First & Sheet");
  XLSX.utils.book_append_sheet(book, second, "Second");
  return XLSX.write(book, { type: "array", bookType: "xlsx" });
}

async function makeSanitizerBundle(dir: string) {
  const entry = path.join(dir, "sanitize-entry.ts");
  await writeFile(entry, "export { sanitizeCss, sanitizeRendered, OfficePreviewError } from " +
    `${JSON.stringify(path.join(root, "src/web/office-viewer.ts"))};\n`);
  const result = await build({
    entrypoints: [entry], outdir: dir, naming: "sanitize.js",
    target: "browser", format: "esm", splitting: false,
  });
  expect(result.success).toBe(true);
}

function serve(fixtures: string) {
  const assets = path.join(root, "server/assets");
  const requests: string[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      requests.push(url.pathname);
      if (url.pathname === "/") return new Response(PAGE, { headers: { "content-type": "text/html" } });
      const asset = url.pathname.startsWith("/assets/");
      if (!asset && !url.pathname.startsWith("/fixtures/")) return new Response("not found", { status: 404 });
      const relative = decodeURIComponent(url.pathname.slice(asset ? "/assets/".length : "/fixtures/".length));
      const data = await readFile(path.join(asset ? assets : fixtures, relative)).catch(() => null);
      if (!data) return new Response("not found", { status: 404 });
      return new Response(data, { headers: { "content-type": relative.endsWith(".js") ? "text/javascript" : "application/octet-stream" } });
    },
  });
  return { server, requests, origin: `http://127.0.0.1:${server.port}` };
}

test("sanitizeCss removes imports and remote resources but keeps layout", () => {
  const css = sanitizeCss('@import url("https://example.invalid/a.css"); .docx { color: red; background: url("data:image/png;base64,AAA"); ' +
    'src: url(data:font/woff2;base64,BBB); cursor: url(blob:abc); mask: url(https://example.invalid/x.svg); ' +
    "filter: url(\\68 ttps://example.invalid/y.svg); }");
  expect(css).not.toContain("@import");
  expect(css).not.toContain("https://");
  expect(css).toContain("color: red");
  expect(css).toContain("data:image/png;base64,AAA");
  expect(css).toContain("data:font/woff2;base64,BBB");
  expect(css).toContain("blob:abc");
  expect(css).toContain("mask: none");
  expect(css).toContain("filter: none");
  expect(sanitizeCss("clip-path: url(#cut); mask: url('#cut')")).toContain("#cut");
});

test("Office sanitizers fail closed without DOMPurify", () => {
  const holder = globalThis as { DOMPurify?: unknown };
  const saved = holder.DOMPurify;
  delete holder.DOMPurify;
  try {
    let failure: unknown;
    try { sanitizeRendered({} as HTMLElement); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(OfficePreviewError);
    expect((failure as Error).name).toBe("OfficePreviewError");
    expect((failure as Error).message).toContain("sanitizer");
  } finally {
    if (saved) holder.DOMPurify = saved;
  }
});

test("Office bundles are self-hosted and their notices are packed", async () => {
  for (const kind of ["docx", "xlsx", "pptx"]) {
    const file = path.join(root, "server/assets/office", `${kind}.bundle.js`);
    expect(statSync(file).size).toBeGreaterThan(10_000);
    expect(statSync(file).size).toBeLessThan(4 * 1024 * 1024);
    expect(await readFile(file, "utf8")).not.toContain("sourceMappingURL");
  }
  const notice = await readFile(path.join(root, "server/assets/office/THIRD-PARTY-NOTICES.txt"), "utf8");
  for (const name of ["docx-preview", "xlsx", "pptx-preview", "echarts"]) expect(notice).toContain(name);
});

test.skipIf(!browserModule)("docx and xlsx render locally through lazy sanitized bundles", async () => {
  const { chromium } = await import(pathToFileURL(browserModule!).href);
  const dir = await mkdtemp(path.join(os.tmpdir(), "chat-office-"));
  const { server, requests, origin } = serve(dir);
  const pageErrors: string[] = [];
  let browser: any;
  try {
    await writeFile(path.join(dir, "sample.docx"), await makeDocx());
    await writeFile(path.join(dir, "sample.xlsx"), makeXlsx());
    await copyFile(path.join(root, "fixtures/office/sample-rich.docx"), path.join(dir, "rich.docx"));
    await copyFile(path.join(root, "fixtures/office/sample-rich.xlsx"), path.join(dir, "rich.xlsx"));
    await makeSanitizerBundle(dir);
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHAT_UI_BROWSER_EXECUTABLE });
    const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
    page.setDefaultTimeout(20000);
    page.on("pageerror", (error: Error) => pageErrors.push(error.message));
    await page.goto(origin);

    const docx = await page.evaluate(async (url: string) => {
      const { renderOffice } = await import("/assets/chat/office-preview.js" as string);
      const box = document.getElementById("box")!;
      await renderOffice("docx", await (await fetch(url)).blob(), box);
      return {
        text: box.textContent || "",
        tables: box.querySelectorAll("table").length,
        scripts: box.querySelectorAll("script").length,
        handlers: Array.from(box.querySelectorAll("*")).flatMap((node) =>
          Array.from(node.attributes).filter((attr) => attr.name.startsWith("on"))).length,
        styles: Array.from(box.querySelectorAll("style")).map((node) => node.textContent || "").join("\n"),
      };
    }, "/fixtures/sample.docx");
    expect(docx.text).toContain("Office DOCX fixture");
    expect(docx.text).toContain("Cell A");
    expect(docx.text).toContain("<img src=x onerror=alert(1)>");
    expect(docx.tables).toBeGreaterThan(0);
    expect(docx.scripts).toBe(0);
    expect(docx.handlers).toBe(0);
    expect(docx.styles).not.toContain("@import");
    expect(docx.styles).not.toContain("https://");
    expect(requests.some((request) => request.endsWith("/office/docx.bundle.js"))).toBe(true);
    expect(requests.some((request) => request.endsWith("/office/xlsx.bundle.js"))).toBe(false);
    expect(requests.some((request) => request.endsWith("/office/pptx.bundle.js"))).toBe(false);

    const xlsx = await page.evaluate(async (url: string) => {
      const { renderOffice } = await import("/assets/chat/office-preview.js" as string);
      const box = document.getElementById("box")!;
      await renderOffice("xlsx", await (await fetch(url)).blob(), box);
      const tabs = Array.from(box.querySelectorAll<HTMLButtonElement>(".office-xlsx-tab"));
      const first = {
        text: box.textContent || "",
        tabs: tabs.length,
        selected: tabs.map((tab) => tab.getAttribute("aria-selected")),
        scripts: box.querySelectorAll("script").length,
        merges: Array.from(box.querySelectorAll("td[colspan]")).map((cell) => cell.getAttribute("colspan")),
      };
      tabs[1]?.click();
      return { ...first, second: box.textContent || "", xss: (window as any).__xss };
    }, "/fixtures/sample.xlsx");
    expect(xlsx.tabs).toBe(2);
    expect(xlsx.selected).toEqual(["true", "false"]);
    expect(xlsx.text).toContain("<script>window.__xss=1</script>");
    expect(xlsx.scripts).toBe(0);
    expect(xlsx.merges).toContain("2");
    expect(xlsx.second).toContain("Second sheet");
    expect(xlsx.xss).toBeUndefined();
    expect(requests.some((request) => request.endsWith("/office/xlsx.bundle.js"))).toBe(true);
    expect(requests.some((request) => request.endsWith("/office/pptx.bundle.js"))).toBe(false);

    const richDocx = await page.evaluate(async (url: string) => {
      const { renderOffice } = await import("/assets/chat/office-preview.js" as string);
      const box = document.getElementById("box")!;
      await renderOffice("docx", await (await fetch(url)).blob(), box);
      const table = box.querySelector("table");
      const image = box.querySelector("img");
      return {
        text: box.textContent || "",
        rows: table?.rows.length || 0,
        merged: table?.querySelectorAll('td[colspan="2"]').length || 0,
        image: image ? { src: (image.getAttribute("src") || "").slice(0, 22), width: (image as HTMLImageElement).naturalWidth } : null,
      };
    }, "/fixtures/rich.docx");
    expect(richDocx.text).toContain("ChatRoom Office fixture");
    expect(richDocx.text).toContain("First list item");
    expect(richDocx.text).toContain("Nested item");
    expect(richDocx.rows).toBe(3);
    expect(richDocx.merged).toBeGreaterThan(0);
    expect(richDocx.image?.src).toBe("data:image/png;base64,");
    expect(richDocx.image?.width).toBeGreaterThan(0);

    const richXlsx = await page.evaluate(async (url: string) => {
      const { renderOffice } = await import("/assets/chat/office-preview.js" as string);
      const box = document.getElementById("box")!;
      await renderOffice("xlsx", await (await fetch(url)).blob(), box);
      const tabs = Array.from(box.querySelectorAll<HTMLButtonElement>(".office-xlsx-tab"));
      const table = () => box.querySelector<HTMLTableElement>("table")!;
      const cell = (row: number, column: number) => table().rows[row]?.cells[column]?.textContent || "";
      const summary = { title: cell(0, 0), titleSpan: table().rows[0]?.cells[0]?.colSpan, d5: cell(4, 3), d9: cell(8, 3) };
      tabs[1]?.click();
      return { tabs: tabs.map((tab) => tab.textContent), summary, dataRows: table().rows.length, dataD13: cell(12, 3) };
    }, "/fixtures/rich.xlsx");
    expect(richXlsx.tabs).toEqual(["Summary", "Data"]);
    expect(richXlsx.summary.title).toBe("ChatRoom Office fixture");
    expect(richXlsx.summary.titleSpan).toBe(4);
    expect(richXlsx.summary.d5).toBe("25.00");
    expect(richXlsx.summary.d9).toBe("161.25");
    expect(richXlsx.dataRows).toBe(13);
    expect(richXlsx.dataD13).toBe("9");

    const failures = await page.evaluate(async () => {
      const bridge = await import("/assets/chat/office-preview.js" as string);
      const box = document.getElementById("box")!;
      box.innerHTML = "<b>stale</b>";
      let parse: any;
      try { await bridge.renderOffice("xlsx", new Blob([new Uint8Array([0x50, 0x4b, 3, 4, 0, 0, 0, 0])]), box); } catch (error) { parse = error; }
      let size: any;
      try { await bridge.renderOffice("xlsx", new Blob([new Uint8Array(20 * 1024 * 1024 + 1)]), box); } catch (error) { size = error; }
      return {
        parse: { name: parse?.name, message: parse?.message, typed: parse instanceof bridge.OfficePreviewError, html: box.innerHTML },
        size: { name: size?.name, message: size?.message, typed: size instanceof bridge.OfficePreviewError },
      };
    });
    expect(failures.parse.typed).toBe(true);
    expect(failures.parse.name).toBe("OfficePreviewError");
    expect(failures.parse.message).toContain("Could not preview");
    expect(failures.parse.html).toBe("");
    expect(failures.size.typed).toBe(true);
    expect(failures.size.message).toContain("20 MiB");

    const sanitized = await page.evaluate(async () => {
      const { sanitizeRendered } = await import("/fixtures/sanitize.js" as string);
      const area = document.getElementById("crafted")!;
      area.innerHTML = '<script>window.__xss = 2</script><iframe src="https://evil.invalid/f"></iframe>' +
        '<form action="https://evil.invalid/a"><input name="x"><button onclick="window.__xss=3">go</button></form>' +
        '<img id="remote" src="https://evil.invalid/x.png" onerror="window.__xss=4">' +
        '<img id="embedded" src="data:image/png;base64,iVBORw0KGgo=">' +
        '<a id="script" href="javascript:window.__xss=5">js</a><a id="web" href="https://example.invalid/page">web</a>' +
        '<a id="relative" href="/rooms/x">relative</a><a id="hash" href="#local">hash</a>' +
        '<div id="styled" style="background: url(https://evil.invalid/a.png); color: red">styled</div>' +
        '<canvas id="canvas" width="12" height="12"></canvas><svg id="svg"><text>Hi</text>' +
        '<image id="svgImage" href="https://evil.invalid/a.png"></image></svg>' +
        "<style>@import url(https://evil.invalid/a.css); .x { background: url(https://evil.invalid/b.png); color: blue }</style>";
      const canvas = document.getElementById("canvas") as HTMLCanvasElement;
      const context = canvas.getContext("2d")!;
      context.fillStyle = "#f00";
      context.fillRect(0, 0, 1, 1);
      sanitizeRendered(area);
      const get = (id: string) => document.getElementById(id);
      return {
        removed: ["script", "iframe", "form", "input", "button", "link", "meta", "base"].filter((tag) => area.querySelector(tag)),
        handlers: Array.from(area.querySelectorAll("*")).flatMap((node) =>
          Array.from(node.attributes).filter((attr) => attr.name.startsWith("on"))).length,
        remote: get("remote")?.getAttribute("src"),
        embedded: get("embedded")?.getAttribute("src")?.slice(0, 20),
        script: get("script")?.getAttribute("href"),
        web: get("web")?.getAttribute("href"),
        relative: get("relative")?.getAttribute("href"),
        hash: get("hash")?.getAttribute("href"),
        styled: get("styled")?.getAttribute("style"),
        styleSheet: area.querySelector("style")?.textContent,
        canvasWidth: (get("canvas") as HTMLCanvasElement)?.width,
        canvasPixel: Array.from(context.getImageData(0, 0, 1, 1).data),
        svgText: get("svg")?.textContent,
        svgImage: get("svgImage")?.getAttribute("href"),
        xss: (window as any).__xss,
      };
    });
    expect(sanitized.removed).toEqual([]);
    expect(sanitized.handlers).toBe(0);
    expect(sanitized.remote).toBeNull();
    expect(sanitized.embedded).toBe("data:image/png;base6");
    expect(sanitized.script).toBeNull();
    expect(sanitized.web).toBe("https://example.invalid/page");
    expect(sanitized.relative).toBeNull();
    expect(sanitized.hash).toBe("#local");
    expect(sanitized.styled).toContain("background: none");
    expect(sanitized.styled).toContain("color: red");
    expect(sanitized.styleSheet).not.toContain("https://");
    expect(sanitized.canvasWidth).toBe(12);
    expect(sanitized.canvasPixel).toEqual([255, 0, 0, 255]);
    expect(sanitized.svgText).toBe("Hi");
    expect(sanitized.svgImage).toBeNull();
    expect(sanitized.xss).toBeUndefined();

    const closed = await page.evaluate(async () => {
      const { renderOffice } = await import("/assets/chat/office-preview.js" as string);
      const box = document.getElementById("box")!;
      box.innerHTML = "<b>stale</b>";
      const saved = (window as any).DOMPurify;
      delete (window as any).DOMPurify;
      try {
        await renderOffice("docx", new Blob([new Uint8Array([80, 75, 3, 4])]), box);
        return { missing: true };
      } catch (error: any) {
        return { name: error.name, message: error.message, html: box.innerHTML };
      } finally {
        (window as any).DOMPurify = saved;
      }
    });
    expect(closed.name).toBe("OfficePreviewError");
    expect(closed.message).toContain("sanitizer");
    expect(closed.html).toBe("");
    expect(pageErrors).toEqual([]);
  } finally {
    await browser?.close();
    server.stop(true);
    await rm(dir, { recursive: true, force: true });
  }
});

test.skipIf(!browserModule)("pptx slides render and are scrubbed in place", async () => {
  const { chromium } = await import(pathToFileURL(browserModule!).href);
  const dir = await mkdtemp(path.join(os.tmpdir(), "chat-office-pptx-"));
  const { server, requests, origin } = serve(dir);
  const pageErrors: string[] = [];
  let browser: any;
  try {
    await copyFile(pptxFixture, path.join(dir, "deck.pptx"));
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHAT_UI_BROWSER_EXECUTABLE });
    const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
    page.setDefaultTimeout(20000);
    page.on("pageerror", (error: Error) => pageErrors.push(error.message));
    await page.goto(origin);
    const result = await page.evaluate(async (url: string) => {
      const { renderOffice } = await import("/assets/chat/office-preview.js" as string);
      const box = document.getElementById("box")!;
      await renderOffice("pptx", await (await fetch(url)).blob(), box, { width: 900 });
      const media = Array.from(box.querySelectorAll("img,source,video,audio,track"));
      return {
        wrapper: Boolean(box.querySelector(".pptx-preview-wrapper")),
        slides: Array.from(box.querySelectorAll(".pptx-preview-slide-wrapper")).map((slide) =>
          (slide.textContent || "").replace(/\s+/g, " ").trim()),
        removed: ["script", "iframe", "object", "embed", "form", "input", "button", "link", "meta", "base"].filter((tag) => box.querySelector(tag)),
        handlers: Array.from(box.querySelectorAll("*")).flatMap((node) =>
          Array.from(node.attributes).filter((attr) => attr.name.startsWith("on"))).length,
        remoteMedia: media.map((node) => node.getAttribute("src")).filter((src) => src && !/^(?:data:|blob:)/i.test(src)),
        remoteImages: Array.from(box.querySelectorAll("image[href],use[href]")).map((node) => node.getAttribute("href"))
          .filter((href) => href && !/^(?:#|data:|blob:)/i.test(href)),
      };
    }, "/fixtures/deck.pptx");
    expect(result.wrapper).toBe(true);
    expect(result.slides).toHaveLength(3);
    expect(result.slides[0]).toContain("ChatRoom Office fixture");
    expect(result.slides[0]).toContain("PPTX multi-slide and placeholder layout");
    expect(result.slides[1]).toContain("Rendering checks");
    expect(result.slides[1]).toContain("Bullet text and layout inheritance");
    expect(result.slides[2]).toContain("Two content layout");
    expect(result.slides[2]).toContain("Nested layout content");
    expect(result.removed).toEqual([]);
    expect(result.handlers).toBe(0);
    expect(result.remoteMedia).toEqual([]);
    expect(result.remoteImages).toEqual([]);
    expect(requests.some((request) => request.endsWith("/office/pptx.bundle.js"))).toBe(true);
    expect(requests.some((request) => request.endsWith("/office/docx.bundle.js"))).toBe(false);
    expect(requests.some((request) => request.endsWith("/office/xlsx.bundle.js"))).toBe(false);
    expect(pageErrors).toEqual([]);
  } finally {
    await browser?.close();
    server.stop(true);
    await rm(dir, { recursive: true, force: true });
  }
});

afterAll(() => {
  if (!browserModule) console.log("CHAT_UI_BROWSER_MODULE is unset: browser Office tests skipped.");
});