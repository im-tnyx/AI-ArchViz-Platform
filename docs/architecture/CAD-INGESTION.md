# CAD Ingestion (cad-document-v0.1)

## 1. Why this document exists

Technical Spike 10A starts the upstream input side of the platform: a real
CAD source file becomes deterministic, normalized, hash-identified **source
evidence**. It deliberately stops there:

```text
DXF source bytes
  -> source safety checks (size, binary, UTF-8)
  -> project-owned DXF adapter
  -> normalized CAD document (millimeters)
  -> cad-document-v0.1 schema validation
  -> RFC 8785 semantic document hash + extraction evidence
```

It does **not** perform CAD -> walls/doors/windows/rooms -> SceneSpec. That
semantic interpretation belongs to a later, separately authorized spike (see
section 13). The same exact DXF bytes always produce the same normalized
document, the same raw `sourceHash`, and the same `cadDocumentHash`,
independent of OS, source path, working directory, or user name.

## 2. Why DXF first

ASCII DXF is an openly documented text interchange format that AutoCAD and
most CAD tools export. It can be read deterministically with no CAD process,
no licensed SDK, and no binary reverse engineering. DWG, DGN, PDF, IFC,
Revit, and SketchUp are out of scope for 10A; binary DXF is rejected.

## 3. Package boundary

`packages/cad-parser/` (`@ai-archviz/cad-parser`) is pure: it never touches
3ds Max, pymxs, Corona, renderers, AI providers, the network, child
processes, environment variables, or source paths. Its only imports are
`node:crypto` (byte hash), `node:fs` (reading its own schema file), `ajv`,
and its own modules; a static unit guard enforces this.

| File | Responsibility |
| --- | --- |
| `src/types.ts` | cad-document-v0.1 types, `CadSourceError`, `CadSourceAdapter` |
| `src/units.ts` | `$INSUNITS` table and millimeter conversion |
| `src/dxf-adapter.ts` | `DxfSourceAdapter`: the only code that knows DXF group codes |
| `src/normalize.ts` | format-independent sorting, summary, document assembly |
| `schema/cad-document-v0.1.schema.json` | the normative contract |

## 4. Adapter boundary and dependency decision

```ts
interface CadSourceAdapter {
  readonly sourceFormat: "dxf";
  parse(input: { bytes: Uint8Array }): CadDocument;
}
```

Adapters receive already-loaded bytes, never a path. `DxfSourceAdapter` is
the only adapter in 10A; a future trusted DWG adapter must produce the same
`cad-document-v0.1` and reuse `assembleCadDocument()`.

**No third-party DXF parser is used.** An ASCII DXF file is a flat sequence
of (group code, value) line pairs, and 10A needs only the HEADER variables,
the LAYER table, the BLOCKS inventory, and four entity types. A small
project-owned, strict reader is more auditable than a library and avoids
known library behaviors that conflict with this contract (silently skipping
unknown entity types, console logging, loose numeric parsing). No dependency
was added: the package uses only `ajv`/`ajv-formats`, already pinned
through the workspace catalog. The raw pair/record shapes stay private to
`dxf-adapter.ts`; downstream code only sees `cad-document-v0.1`.

## 5. Source safety

Checks run in this order, before any tokenizing:

| Check | Failure code |
| --- | --- |
| byte length > 10 MiB (`CAD_SOURCE_MAX_BYTES`; callers may only lower it) | `CAD_SOURCE_TOO_LARGE` |
| `AutoCAD Binary DXF` signature, or any NUL byte | `CAD_BINARY_DXF_UNSUPPORTED` |
| not valid UTF-8 (a BOM is allowed and stripped) | `CAD_DXF_PARSE_FAILED` |

Legacy code-page bytes are rejected, never guessed; `$DWGCODEPAGE` is
recorded as provenance only. There is no decompression, no archive handling,
and no loading of XREFs, images, fonts, SHX files, plugins, or network
resources.

Every structural or value error (truncated pair, invalid group code,
missing `EOF`, unterminated section/table/block, records after `EOF`,
duplicate section/header variable/layer/block, non-decimal number,
missing required group, a group repeated in one record, vertex-count
mismatch, unbalanced `102` application group) maps to the single
project-owned code `CAD_DXF_PARSE_FAILED` with a safe diagnostic message.
A number that is non-finite, before or after unit conversion, fails with
`CAD_NUMERIC_NON_FINITE`. No partial document is ever returned.

## 6. Two different hashes

| Hash | Input | Algorithm |
| --- | --- | --- |
| `sourceHash` | raw source **bytes** exactly as read | `sha256:` + lowercase hex SHA-256 |
| `cadDocumentHash` | the normalized cad-document JSON | `semanticJsonHash` (RFC 8785 canonical JSON, SHA-256) |

They are never conflated. A one-byte source change always changes
`sourceHash`. Two equivalent sources in different units have different
`sourceHash` values (and different header/unit metadata) but identical
normalized geometry. Changing only line endings changes `sourceHash` and
nothing else. `.gitattributes` marks `*.dxf` as `-text` so checkout never
alters fixture bytes.

## 7. No source path

No absolute or relative path, user name, or workspace location appears in
cad-document-v0.1 or its evidence. The path is execution metadata only;
canonical identity is content hashes. An XREF block's referenced path is
likewise never recorded (it may be machine-specific) and never followed.

## 8. Units

`$INSUNITS` is the single v0.1 unit authority:

| Code | Name | Scale to mm |
| --- | --- | --- |
| 1 | inches | 25.4 |
| 2 | feet | 304.8 |
| 4 | millimeters | 1 |
| 5 | centimeters | 10 |
| 6 | meters | 1000 |

- absent or `0` (unitless): `CAD_UNITS_UNSPECIFIED`
- any other code: `CAD_UNITS_UNSUPPORTED` (the raw code is in the details)

Units are never inferred from extents, dimension text, layer names, typical
room sizes, file names, or AI. Human unit confirmation belongs to a later
ingestion workflow.

Every length is converted by one multiplication by the exact scale, with no
rounding; negative zero is normalized to zero. Dimensionless values (bulge,
INSERT scale factors) and angles are never scaled. Coordinates stay in DXF
WCS: no axis swap, Y flip, recentering, origin move, or rotation.

## 9. cad-document-v0.1

```json
{
  "cadDocumentVersion": "0.1.0",
  "sourceFormat": "dxf",
  "sourceHash": "sha256:...",
  "header": { "acadVersion": "AC1027", "insunitsCode": 4, "dwgCodePage": "ANSI_1252" },
  "sourceUnits": { "insunitsCode": 4, "name": "millimeters", "scaleToMillimeters": 1 },
  "canonicalUnits": "millimeters",
  "layers": [],
  "blocks": [],
  "entities": [],
  "unsupportedEntities": [],
  "summary": {
    "layerCount": 0, "blockCount": 0, "entityCount": 0,
    "supportedEntityCount": 0, "unsupportedEntityCount": 0,
    "entityTypeCounts": {}
  }
}
```

Header values are raw; `$ACADVER` and `$DWGCODEPAGE` are `null` when absent,
never invented.

- **Layers**: `name` (exact spelling), `colorIndex`, `lineType`, `flags`
  (`null` when absent), sorted by Unicode code-point order of `name` —
  independent of table order. Layer names carry no meaning in 10A.
- **Blocks**: an inventory only (`name`, `flags`, `basePoint` mm,
  `externalReference`, `entityCount`), code-point sorted. Definitions are
  never exploded.
- **Entities**: kept in source order. Every record in the `ENTITIES` section
  gets a zero-based `sourceOrdinal` and appears in exactly one of `entities`
  or `unsupportedEntities`; none disappear. `sourceHandle` is the raw group
  5 handle or `null`; it is provenance, never a SceneSpec logical ID.
  `layer` (group 8) is required.
- **summary**: counts plus `entityTypeCounts` over all source entity types.
  No wall, door, room, or other architectural count exists.

Where DXF defines a default for an omitted optional group, that default is
applied (Z = 0, bulge = 0, elevation = 0, INSERT scale = 1, rotation = 0,
justification = 0). Required groups are never defaulted.

## 10. Supported entities

| Type | Normalized fields |
| --- | --- |
| `LINE` | `start`, `end` as `[x, y, z]` mm (WCS) |
| `LWPOLYLINE` | `closed` (flag bit 1), raw `flags`, `elevation` mm, `vertices[{x, y, bulge}]` |
| `INSERT` | `blockName`, `insertionPoint` mm, dimensionless `scale`, `rotationDegrees`, `hasAttributes` |
| `TEXT` | inert `text`, `insertionPoint`, `alignmentPoint` (or `null`), `height` mm (or `null`), `rotationDegrees`, justification codes |

LWPOLYLINE bulges are preserved per vertex and never flattened into line
segments. TEXT content (including control codes such as `%%c`) is inert
data and is never interpreted or evaluated. Widths, thickness, text style,
width factor, and oblique angle are not extracted in v0.1.

## 11. Unsupported entities

Everything else is recorded in `unsupportedEntities` with `sourceOrdinal`,
`sourceHandle`, `type`, `layer`, and `reason`:

- `UNSUPPORTED_ENTITY_TYPE`: any other type, including `MTEXT` (its inline
  formatting is not parsed in v0.1), `DIMENSION` (dimension semantics are
  out of scope; rendered dimension text is never used), `ARC`, `CIRCLE`,
  `HATCH`, `IMAGE`, and the `ATTRIB`/`VERTEX`/`SEQEND` records that follow
  an INSERT or legacy POLYLINE (each is its own source record).
- `UNSUPPORTED_OCS_EXTRUSION`: a LWPOLYLINE/INSERT/TEXT whose extrusion is
  not exactly `(0, 0, 1)`. Its coordinates are in an object coordinate
  system, and no OCS-to-WCS transform is guessed in v0.1.
- `UNSUPPORTED_INSERT_ARRAY`: an INSERT with row/column counts (MINSERT).

## 12. Worker boundary and evidence

`apps/worker/src/cad-extraction.ts`:

- `extractCadDocument({ repositoryRoot, sourcePath })` resolves a
  root-relative `.dxf` path that is contained both lexically and
  physically (section 12.1), requires a regular file, checks its size
  before reading, reads the bytes from the verified physical path, and runs
  the pure adapter.
- The document is validated against `cad-document-v0.1`, hashed with
  `semanticJsonHash`, and summarized as `cad-extraction-evidence-v0.1`
  (`packages/worker-contracts`): `evidenceVersion`, `sourceFormat`,
  `sourceHash`, `cadDocumentVersion`, `cadDocumentHash`, `sourceUnits`,
  `canonicalUnits`, `summary`, and `status: "PASS"`. The evidence has no
  path and no entity array; the full document is the extraction artifact.
- `writeCadExtraction()` writes `<name>.json` and `<name>.evidence.json`
  under the worker-owned output root. Output paths must be root-relative
  and end in `.json`, and may never escape the root (lexically or
  physically, section 12.1) or overwrite the source.

### 12.1 Path containment (lexical + physical)

Lexical containment (`resolveWithinRoot()`: non-empty, relative, no `..`
escape, no absolute path) is kept and always runs first. It cannot see a
symbolic link or Windows directory junction/reparse point *inside* the
root that redirects *outside* it, so the CAD boundary adds a physical check
through two helpers in `apps/worker/src/paths.ts`
(`resolveExistingFileWithinRoot`, `resolveOutputPathWithinRoot`). Both
compare the filesystem `realpath` (`fs.realpathSync.native`) of the
trusted root with the `realpath` of the target, so any link type the OS
resolves (POSIX symlinks, Windows symlinks, junctions) is covered without
enumerating reparse tags, and a root that is itself reached through a link
or an OS canonical path is compared as its real location.

- **Source:** the final entry must exist and be a regular file; the real
  source path must lie inside the real root. A parent link or junction
  that escapes is `CAD_SOURCE_PATH_INVALID`, and the outside bytes are
  never read. Reads use the verified physical path.
- **Final source link:** a source whose final entry is itself a link is
  rejected (`CAD_SOURCE_PATH_INVALID`) even if its target is inside the
  root; it is never followed.
- **Intermediate links:** allowed only when the physical result stays
  inside the physical root. The invariant is "no physical root escape",
  identical on every OS.
- **Broken links:** a route that traverses a link whose target does not
  resolve is `CAD_SOURCE_PATH_INVALID`; a plain missing file is
  `CAD_SOURCE_NOT_FOUND`.
- **Output:** destinations normally do not exist yet, so the check resolves
  the nearest existing ancestor physically and appends the not-yet-existing
  tail (which no link can redirect). The result must stay inside the
  physical output root. An existing final output entry must be a regular
  file, never a link. Both the document and evidence destinations are
  validated before either is written, so a rejected write creates nothing
  (no partial write, no outside file). Missing directories are created
  only after validation. The output root is trusted configuration
  (`config.workspaceRoot`) and cannot be chosen by the command argument.
- **Errors:** filesystem failures surface only as the product-owned
  `CAD_SOURCE_PATH_INVALID` / `CAD_SOURCE_NOT_FOUND` /
  `CAD_OUTPUT_PATH_INVALID`; raw `ENOENT`/`ELOOP`/`EPERM` are never
  public codes.
- **TOCTOU:** validation runs immediately before the read or write. A
  local process that swaps a directory for a link between validation and
  access is outside this local-worker trust boundary (this is not a
  hostile multi-tenant filesystem), so no platform-specific secure-open
  layer exists.

`resolveWithinRoot()` itself is unchanged, so its historical (DCC, revision,
render, ingestion) callers keep their existing semantics.

CLI:

```bash
pnpm worker extract-cad tests/fixtures/cad/dxf/simple-room-mm.dxf cad/simple-room-mm.json
```

The source is repository-relative; the output is relative to the configured
worker workspace root (`.workspace/` by default). No DCC is involved, so
this command needs no DCC authorization.

## 13. Explicit non-goals and future boundaries

- **No SceneSpec inference.** 10A never produces a wall, space, room, door,
  window, floor, ceiling, circulation route, or asset placement, even when
  a layer is named `A-WALL`.
- **No AI**, OCR, semantic classification, or confidence scoring.
- **No AutoCAD, Core Console, RealDWG, ODA, or 3ds Max process.**
- **No block explosion and no XREF loading.**
- **Future DWG adapter:** a trusted adapter that emits the same
  `cad-document-v0.1` through `CadSourceAdapter`.
- **Future CAD -> SceneSpec interpretation:** a later spike maps normalized
  source evidence (with explicit layer mapping) to human-verifiable wall,
  opening, and space candidates. Its provenance chain will extend
  `source bytes -> sourceHash -> sourceOrdinal/sourceHandle -> layer ->
  normalized entity` into architectural elements; 10A stops at the
  normalized entity.
