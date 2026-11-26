# Office preview fixtures

Small real OOXML files for local renderers and independent verification. They are
not part of the npm package or the Docker image.

## Basic fixtures

- `sample.docx`, `sample.xlsx`: from the MIT-licensed `gabriel-vasile/mimetype`
  test data (`testdata/docx.docx`, `testdata/xlsx.xlsx`). See `MIMETYPE-LICENSE`.
- `sample.pptx`: python-pptx's default presentation template plus one slide with
  absolute text boxes. See `PYTHON-PPTX-LICENSE`.

## Rich fixtures

- `sample-rich.docx`: generated locally from `sample.docx`; adds a heading, a merged
  table header, a table with two rows, an embedded PNG, and a nested bullet list.
- `sample-rich.xlsx`: generated with openpyxl; two sheets, merged cells, bold and
  filled headers, formulas with cached values, frozen panes, and per-column formats.
- `sample-rich.pptx`: generated from python-pptx's default template; three slides
  using Title, Title and Content, and Two Content layouts with inherited
  placeholders.

These files contain no personal data.