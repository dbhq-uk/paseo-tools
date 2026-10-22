import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import { mkdtemp, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { MAX_OFFICE_BYTES, readDocument, readRows, readSheetList } from "../server/office.js";
import type { Block, Run } from "../shared/contracts.js";

const fixtures = new URL("./fixtures/", import.meta.url).pathname;
const at = (name: string) => join(fixtures, name);
const text = (runs: Run[]) => runs.map((r) => r.text).join("");
const only = <T extends Block["type"]>(blocks: Block[], type: T) =>
  blocks.filter((b) => b.type === type) as Extract<Block, { type: T }>[];

describe("readDocument", () => {
  it("maps headings with their level", async () => {
    const blocks = await readDocument(at("contract.docx"));
    const levels = only(blocks, "heading").map((h) => h.level);
    assert.deepEqual(levels.slice(0, 4), [1, 2, 3, 3]);
  });

  it("preserves bold and italic", async () => {
    const runs = only(await readDocument(at("contract.docx")), "paragraph").flatMap((p) => p.runs);
    assert.ok(runs.some((r) => r.bold && r.text.includes("Between")), "expected a bold run");
    assert.ok(runs.some((r) => r.italic && r.text.includes("and")), "expected an italic run");
  });

  it("keeps hyperlinks, which a run without link would silently drop", async () => {
    const runs = only(await readDocument(at("contract.docx")), "paragraph").flatMap((p) => p.runs);
    const links = runs.filter((r) => r.link);
    assert.equal(links.length, 1);
    assert.equal(links[0].link, "https://example.com/terms");
    assert.equal(links[0].text, "example.com");
  });

  it("distinguishes ordered from unordered lists", async () => {
    const lists = only(await readDocument(at("contract.docx")), "list");
    assert.equal(lists.length, 2);
    assert.deepEqual(lists.map((l) => l.ordered), [false, true]);
    assert.equal(lists[0].items.length, 3);
    assert.equal(text(lists[1].items[1]), "Schedule A");
  });

  it("maps a table to rows of cells of runs", async () => {
    const [table] = only(await readDocument(at("contract.docx")), "table");
    assert.ok(table, "expected a table block");
    assert.equal(table.rows[0].length, 3);
    assert.equal(text(table.rows[1][0]), "Standard day");
    assert.equal(text(table.rows[1][1]), "550");
  });

  it("decodes HTML entities rather than leaking the escape", async () => {
    const blocks = await readDocument(at("contract.docx"));
    const flat = blocks.map((b) => (b.type === "table" ? b.rows.flat().map(text).join(" ") : "")).join(" ");
    assert.ok(flat.includes("Travel & expenses"), "expected a decoded ampersand");
    assert.ok(!flat.includes("&amp;"), "entity leaked through undecoded");
  });

  it("merges adjacent runs that share styling within a block", async () => {
    // Merging is per block; runs from different paragraphs are unrelated.
    for (const para of only(await readDocument(at("contract.docx")), "paragraph")) {
      for (let i = 1; i < para.runs.length; i += 1) {
        const a = para.runs[i - 1];
        const b = para.runs[i];
        const same = a.bold === b.bold && a.italic === b.italic && a.link === b.link;
        assert.ok(!same, `unmerged adjacent runs in one paragraph: "${a.text}" + "${b.text}"`);
      }
    }
  });

  it("returns image blocks for a document that is only a pasted screenshot", async () => {
    // The regression this exists for: with no image block type, such a file
    // renders as a completely blank page.
    const blocks = await readDocument(at("scanned-report.docx"));
    const images = only(blocks, "image");
    assert.ok(images.length >= 1, "expected at least one image block");
    assert.match(images[0].dataUri, /^data:image\/\w+;base64,/);
  });

  it("refuses a legacy .doc with a clear message", async () => {
    await assert.rejects(() => readDocument(at("legacy-format.docx")), /Legacy Office format/);
  });
});

describe("readSheetList", () => {
  it("returns every sheet by name and in order", async () => {
    const sheets = await readSheetList(at("invoices.xlsx"));
    assert.deepEqual(sheets.map((s) => s.name), ["Summary", "Invoices", "Notes"]);
    assert.ok(sheets[0].rowCount >= 3);
    assert.ok(sheets[0].colCount >= 4);
  });

  it("refuses a file that is not a workbook at all", async () => {
    await assert.rejects(() => readSheetList(at("not-really.xlsx")), /not a valid Office document/);
  });
});

describe("readRows", () => {
  it("returns a window of cells as text", async () => {
    const { rows, total } = await readRows(at("invoices.xlsx"), "Summary", 0, 10);
    assert.equal(total, 3);
    assert.deepEqual(rows[0].slice(0, 4), ["Period", "Invoiced", "Paid", "Outstanding"]);
    assert.deepEqual(rows[1].slice(0, 4), ["Q1", "24000", "24000", "0"]);
  });

  it("honours offset and limit", async () => {
    const { rows, total } = await readRows(at("invoices.xlsx"), "Summary", 2, 1);
    assert.equal(total, 3);
    assert.equal(rows.length, 1);
    assert.equal(rows[0][0], "Q2");
  });

  it("returns an empty window past the end rather than failing", async () => {
    const { rows } = await readRows(at("invoices.xlsx"), "Summary", 99, 10);
    assert.equal(rows.length, 0);
  });

  it("shows an uncached formula as its expression, not a blank cell", async () => {
    const { rows } = await readRows(at("invoices.xlsx"), "Summary", 0, 10);
    assert.equal(rows[1][4], "=B2-C2");
  });

  it("renders a date cell as a plain date", async () => {
    const { rows } = await readRows(at("invoices.xlsx"), "Invoices", 0, 10);
    assert.equal(rows[1][2], "2026-01-14");
  });

  it("renders an empty cell as an empty string, keeping columns aligned", async () => {
    const { rows } = await readRows(at("invoices.xlsx"), "Invoices", 0, 10);
    assert.equal(rows[3][4], "");
    assert.equal(rows[3].length, rows[1].length);
  });

  it("handles a single-row sheet", async () => {
    const { rows, total } = await readRows(at("invoices.xlsx"), "Notes", 0, 10);
    assert.equal(total, 1);
    assert.equal(rows[0][0], "No notes this period");
  });

  it("rejects an unknown sheet by name", async () => {
    await assert.rejects(() => readRows(at("invoices.xlsx"), "Nope", 0, 10), /No sheet named/);
  });
});

describe("limits on Office files", () => {
  it("refuses a file over the size cap before reading it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fv-big-"));
    for (const name of ["huge.docx", "huge.xlsx"]) {
      const file = join(dir, name);
      await writeFile(file, "");
      await truncate(file, MAX_OFFICE_BYTES + 1); // sparse: no real disk used
      const open = name.endsWith("docx") ? readDocument(file) : readSheetList(file);
      await assert.rejects(open, /opens Office files up to 50 MB/);
    }
  });

  it("counts only rows and columns that hold something, not styled empty cells", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fv-extent-"));
    const file = join(dir, "styled.xlsx");
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Data");
    ws.getCell("A1").value = "name";
    ws.getCell("B2").value = 42;
    // Formatting far from the data, as a whole-column or whole-row style leaves behind.
    ws.getCell("Z1000").fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFF0000" } };
    await wb.xlsx.writeFile(file);

    assert.deepEqual(await readSheetList(file), [{ name: "Data", rowCount: 2, colCount: 2 }]);
    const window = await readRows(file, "Data", 0, 500);
    assert.equal(window.total, 2);
    assert.deepEqual(window.rows, [["name", ""], ["", "42"]]);
  });

  it("reads a later window of rows without losing the earlier ones", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fv-window-"));
    const file = join(dir, "long.xlsx");
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Long");
    for (let n = 1; n <= 450; n += 1) ws.addRow([`row ${n}`]);
    await wb.xlsx.writeFile(file);

    const first = await readRows(file, "Long", 0, 200);
    const second = await readRows(file, "Long", 200, 200);
    const third = await readRows(file, "Long", 400, 200);
    assert.deepEqual([first.rows.length, second.rows.length, third.rows.length], [200, 200, 50]);
    assert.equal(second.rows[0][0], "row 201");
    assert.equal(third.rows.at(-1)?.[0], "row 450");
    assert.equal(third.total, 450);
  });
});
