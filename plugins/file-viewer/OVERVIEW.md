Opens the files Paseo's own file panel cannot show: PDFs, images, Word documents and spreadsheets.

Paseo's files panel renders text and code. A signed contract, a bank statement, an architecture diagram or a workbook with 33 sheets shows as binary noise there, and on a phone, where Paseo is often the only way in to the machine, those files cannot be read at all. This plugin adds a Viewer panel to the workspace that lists the viewable files in the workspace and opens them.

## What it opens

- **PDF:** shown as page images, one page at a time as you scroll, with a zoom control (Fit, 100% and 150%).
- **Images:** PNG, JPEG, WebP, GIF, BMP, SVG and AVIF. Formats a phone cannot show directly are converted first.
- **Word (.docx):** shown as reflowable text with headings, lists, tables, links and embedded images. Exact page layout is not kept, so fonts, positioning and page numbers are lost. If layout matters, open the PDF.
- **Excel (.xlsx):** a sheet picker and a scrollable table, loaded in windows of rows. Formulas show their last calculated value, or the formula itself when the file holds none.

Old `.doc`, `.xls` and `.ppt` files are recognised and refused with a clear message.

## Setup

Needs Paseo 0.8 or later, with plugins turned on for the daemon. The daemon machine needs `poppler-utils`, `imagemagick` and `librsvg2-bin`. Node.js with npm must be available to the daemon.

## What it reads and where things go

It reads files inside the current workspace only. The workspace folder is looked up on the daemon, not taken from the app, and every path is resolved through symlinks and refused if it leaves the workspace. Nothing is sent to any service. Rendered PDF and image pages are cached on the daemon host in `~/.cache/paseo-file-viewer`, a private folder (mode 0700), and are cleared when the cache passes 500 MB.

Workspace files are often downloads, so they are treated as untrusted. Images are decoded by the format their extension names, Office files over 50 MB are refused, and `.docx` images that point to a web address are dropped. The daemon runs the PDF and image tools with a 30 second time limit but no memory limit, so a hostile file could still use a lot of memory.

## Limits

Links in Word documents are shown as links but cannot be tapped yet. The scan of a workspace stops at 5,000 viewable files or 100,000 entries.
