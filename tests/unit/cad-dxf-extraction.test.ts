import { createHash } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  CAD_SOURCE_MAX_BYTES,
  type CadDocument,
  CadSourceError,
  DxfSourceAdapter,
  parseDxfSource,
  validateCadDocument,
} from "@ai-archviz/cad-parser";
import { semanticJsonHash, validateCadExtractionEvidence } from "@ai-archviz/worker-contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
  CadExtractionError,
  extractCadDocument,
  extractCadDocumentFromBytes,
  writeCadExtraction,
} from "../../apps/worker/src/cad-extraction.js";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const fixtureDirectory = join(repositoryRoot, "tests/fixtures/cad/dxf");
const fixturePath = join(fixtureDirectory, "simple-room-mm.dxf");
const fixtureBytes = () => new Uint8Array(readFileSync(fixturePath));
const expectedDocument = JSON.parse(
  readFileSync(join(fixtureDirectory, "expected-cad-document-v0.1.json"), "utf8"),
) as CadDocument;

const FROZEN_SOURCE_HASH =
  "sha256:f761c38d250e167bdd98a29befd8a4bb9a21a1190ebedfe9848192668489156f";
const FROZEN_DOCUMENT_HASH =
  "sha256:95f0c90d70a52f03c1cf627137d81880d30bb1ab7f03e7d9c39054149ad98b70";

type Pair = [number, string | number];

interface MiniDxfOptions {
  insunits?: number | null;
  acadVersion?: string | null;
  layers?: string[];
  blockBase?: [number, number, number];
  entities: Pair[][];
}

/** Small generated ASCII DXF sources (LF) for focused cases. */
function miniDxf(options: MiniDxfOptions): string {
  const pairs: Pair[] = [
    [0, "SECTION"],
    [2, "HEADER"],
  ];
  if (options.acadVersion !== null)
    pairs.push([9, "$ACADVER"], [1, options.acadVersion ?? "AC1027"]);
  if (options.insunits !== null) pairs.push([9, "$INSUNITS"], [70, options.insunits ?? 4]);
  pairs.push([0, "ENDSEC"], [0, "SECTION"], [2, "TABLES"], [0, "TABLE"], [2, "LAYER"]);
  for (const name of options.layers ?? ["0"]) pairs.push([0, "LAYER"], [2, name], [70, 0], [62, 7]);
  pairs.push([0, "ENDTAB"], [0, "ENDSEC"], [0, "SECTION"], [2, "BLOCKS"]);
  const base = options.blockBase ?? [0, 0, 0];
  pairs.push(
    [0, "BLOCK"],
    [8, "0"],
    [2, "B"],
    [70, 0],
    [10, base[0]],
    [20, base[1]],
    [30, base[2]],
  );
  pairs.push([0, "ENDBLK"], [8, "0"], [0, "ENDSEC"], [0, "SECTION"], [2, "ENTITIES"]);
  for (const entity of options.entities) pairs.push(...entity);
  pairs.push([0, "ENDSEC"], [0, "EOF"]);
  return `${pairs.map(([code, value]) => `${code}\n${value}`).join("\n")}\n`;
}

const encode = (text: string) => new TextEncoder().encode(text);
const parseText = (text: string) => parseDxfSource(encode(text));

function expectCadError(action: () => unknown, code: string): CadSourceError {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(CadSourceError);
    expect((error as CadSourceError).code).toBe(code);
    return error as CadSourceError;
  }
  throw new Error(`expected ${code}`);
}

/** Geometry-only projection (drops source header/unit metadata and hashes). */
function geometryProjection(document: CadDocument) {
  return {
    blocks: document.blocks,
    entities: document.entities,
    unsupportedEntities: document.unsupportedEntities,
    layers: document.layers,
  };
}

describe("cad-document-v0.1 synthetic DXF Golden", () => {
  it("parses the synthetic DXF to exactly the frozen expected extraction", () => {
    const document = parseDxfSource(fixtureBytes());
    expect(document).toEqual(expectedDocument);
    expect(validateCadDocument(document).ok).toBe(true);
    expect(validateCadDocument(expectedDocument).ok).toBe(true);
  });

  it("records a raw byte SHA-256 sourceHash distinct from the semantic document hash", () => {
    const bytes = fixtureBytes();
    const document = parseDxfSource(bytes);
    const byteHash = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    expect(document.sourceHash).toBe(byteHash);
    expect(document.sourceHash).toBe(FROZEN_SOURCE_HASH);
    expect(semanticJsonHash(document)).toBe(FROZEN_DOCUMENT_HASH);
    expect(semanticJsonHash(document)).not.toBe(document.sourceHash);
  });

  it("changes sourceHash when a single source byte changes", () => {
    const bytes = fixtureBytes();
    const text = new TextDecoder().decode(bytes);
    const changed = parseText(text.replace("LIVING ROOM", "LIVING ROON"));
    expect(changed.sourceHash).not.toBe(FROZEN_SOURCE_HASH);
    expect(semanticJsonHash(changed)).not.toBe(FROZEN_DOCUMENT_HASH);
  });

  it("extracts header provenance without inventing missing values", () => {
    expect(expectedDocument.header).toEqual({
      acadVersion: "AC1027",
      insunitsCode: 4,
      dwgCodePage: "ANSI_1252",
    });
    const minimal = parseText(miniDxf({ acadVersion: null, entities: [] }));
    expect(minimal.header).toEqual({ acadVersion: null, insunitsCode: 4, dwgCodePage: null });
  });

  it("normalizes layers by code-point name order with exact spelling and attributes", () => {
    expect(expectedDocument.layers.map((layer) => layer.name)).toEqual([
      "0",
      "A-ANNO",
      "A-DOOR",
      "A-WALL",
      "A-\u00c9TUDE",
      "a-notes",
    ]);
    expect(expectedDocument.layers.find((layer) => layer.name === "a-notes")).toEqual({
      name: "a-notes",
      colorIndex: 1,
      lineType: null,
      flags: 0,
    });
  });

  it("normalizes LINE in WCS millimeters with handle, layer, ordinal, and Z", () => {
    const [first, second] = expectedDocument.entities.filter((entity) => entity.type === "LINE");
    expect(first).toEqual({
      sourceOrdinal: 1,
      sourceHandle: "1F1",
      layer: "A-WALL",
      type: "LINE",
      start: [3000, 0, 0],
      end: [3000, 1200.5, 0],
    });
    expect(second).toMatchObject({ sourceOrdinal: 7, sourceHandle: null, end: [0, 0, 2700] });
  });

  it("normalizes LWPOLYLINE with closed flag, elevation, and per-vertex bulge preserved", () => {
    const polylines = expectedDocument.entities.filter((entity) => entity.type === "LWPOLYLINE");
    expect(polylines.map((polyline) => polyline.closed)).toEqual([true, false]);
    expect(polylines[1]).toMatchObject({
      flags: 128,
      elevation: 0,
      vertices: [
        { x: 6000, y: 1000, bulge: 0.414213562373095 },
        { x: 6500, y: 1500, bulge: 0 },
        { x: 6000, y: 2000, bulge: 0 },
      ],
    });
  });

  it("preserves INSERT without exploding the referenced block", () => {
    const inserts = expectedDocument.entities.filter((entity) => entity.type === "INSERT");
    expect(inserts).toEqual([
      {
        sourceOrdinal: 2,
        sourceHandle: "1F2",
        layer: "A-DOOR",
        type: "INSERT",
        blockName: "DOOR_900",
        insertionPoint: [900, 0, 0],
        scale: [1, 1, 1],
        rotationDegrees: 90,
        hasAttributes: false,
      },
      expect.objectContaining({ scale: [-1, 1, 1], rotationDegrees: 270, hasAttributes: true }),
    ]);
    // The block's LINE + ARC are inventoried, never emitted as entities.
    expect(expectedDocument.blocks.find((block) => block.name === "DOOR_900")?.entityCount).toBe(2);
    expect(expectedDocument.summary.entityCount).toBe(13);
    expect(expectedDocument.unsupportedEntities.some((entity) => entity.type === "ARC")).toBe(
      false,
    );
  });

  it("keeps TEXT content as inert data and records MTEXT/DIMENSION as unsupported", () => {
    const texts = expectedDocument.entities.filter((entity) => entity.type === "TEXT");
    expect(texts.map((text) => text.text)).toEqual([
      "LIVING ROOM",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal shell syntax is the inert-data fixture
      "\u00d8 %%c100 ${HOME} && rm -rf / ; =1+1",
    ]);
    expect(texts[1]).toMatchObject({
      alignmentPoint: [1500, 100, 0],
      height: 100,
      rotationDegrees: 15,
      horizontalJustification: 1,
      verticalJustification: 2,
    });
    expect(expectedDocument.unsupportedEntities).toEqual([
      {
        sourceOrdinal: 5,
        sourceHandle: "1F5",
        layer: "A-ANNO",
        type: "MTEXT",
        reason: "UNSUPPORTED_ENTITY_TYPE",
      },
      {
        sourceOrdinal: 6,
        sourceHandle: "1F6",
        layer: "A-ANNO",
        type: "DIMENSION",
        reason: "UNSUPPORTED_ENTITY_TYPE",
      },
      {
        sourceOrdinal: 10,
        sourceHandle: "1FA",
        layer: "A-DOOR",
        type: "ATTRIB",
        reason: "UNSUPPORTED_ENTITY_TYPE",
      },
      {
        sourceOrdinal: 11,
        sourceHandle: "1FB",
        layer: "A-DOOR",
        type: "SEQEND",
        reason: "UNSUPPORTED_ENTITY_TYPE",
      },
      {
        sourceOrdinal: 12,
        sourceHandle: "1FC",
        layer: "a-notes",
        type: "CIRCLE",
        reason: "UNSUPPORTED_ENTITY_TYPE",
      },
    ]);
  });

  it("assigns every source entity exactly one ordinal; none disappear", () => {
    const ordinals = [
      ...expectedDocument.entities.map((entity) => entity.sourceOrdinal),
      ...expectedDocument.unsupportedEntities.map((entity) => entity.sourceOrdinal),
    ].sort((left, right) => left - right);
    expect(ordinals).toEqual([...Array(13).keys()]);
    expect(expectedDocument.summary).toEqual({
      layerCount: 6,
      blockCount: 3,
      entityCount: 13,
      supportedEntityCount: 8,
      unsupportedEntityCount: 5,
      entityTypeCounts: {
        ATTRIB: 1,
        CIRCLE: 1,
        DIMENSION: 1,
        INSERT: 2,
        LINE: 2,
        LWPOLYLINE: 2,
        MTEXT: 1,
        SEQEND: 1,
        TEXT: 2,
      },
    });
  });

  it("records XREF existence without recording or following its path", () => {
    expect(expectedDocument.blocks.find((block) => block.name === "XREF_SITE")).toEqual({
      name: "XREF_SITE",
      flags: 4,
      basePoint: [0, 0, 0],
      externalReference: true,
      entityCount: 0,
    });
    const serialized = JSON.stringify(expectedDocument);
    expect(serialized).not.toContain("secret-site");
    expect(serialized).not.toMatch(/[A-Za-z]:\\|\/home\/|Users/);
  });

  it("derives no architectural meaning (no wall/room/door/space keys or counts)", () => {
    const keys = new Set<string>();
    const visit = (value: unknown) => {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === "object") {
        for (const [key, child] of Object.entries(value)) {
          if (key !== "entityTypeCounts") keys.add(key);
          visit(child);
        }
      }
    };
    visit(expectedDocument);
    for (const key of keys) {
      expect(key).not.toMatch(/wall|room|door|window|space|floor|ceiling|scene|confidence/i);
    }
  });
});

describe("cad-document-v0.1 determinism and provenance", () => {
  it("produces deep-equal documents and identical hashes on repeated extraction", () => {
    const results = [0, 1, 2].map(() => extractCadDocumentFromBytes(fixtureBytes()));
    for (const result of results) {
      expect(result.cadDocument).toEqual(results[0]?.cadDocument);
      expect(result.cadDocumentHash).toBe(FROZEN_DOCUMENT_HASH);
      expect(result.evidence).toEqual(results[0]?.evidence);
    }
  });

  it("never mutates caller-owned input bytes", () => {
    const bytes = fixtureBytes();
    const snapshot = Uint8Array.from(bytes);
    parseDxfSource(bytes);
    new DxfSourceAdapter().parse({ bytes });
    expect(bytes).toEqual(snapshot);
  });

  it("is independent of line-ending convention apart from the byte hash", () => {
    const lf = new TextDecoder().decode(fixtureBytes()).replace(/\r\n/g, "\n");
    const document = parseText(lf);
    expect(document.sourceHash).not.toBe(FROZEN_SOURCE_HASH);
    expect({ ...document, sourceHash: FROZEN_SOURCE_HASH }).toEqual(expectedDocument);
  });

  it("changes ordinals, order, and semantic hash when source entity order changes", () => {
    const line: Pair[] = [
      [0, "LINE"],
      [5, "A1"],
      [8, "0"],
      [10, 0],
      [20, 0],
      [11, 1000],
      [21, 0],
    ];
    const text: Pair[] = [
      [0, "TEXT"],
      [5, "A2"],
      [8, "0"],
      [10, 5],
      [20, 5],
      [40, 100],
      [1, "T"],
    ];
    const forward = parseText(miniDxf({ entities: [line, text] }));
    const reversed = parseText(miniDxf({ entities: [text, line] }));
    expect(forward.entities.map((entity) => [entity.sourceOrdinal, entity.type])).toEqual([
      [0, "LINE"],
      [1, "TEXT"],
    ]);
    expect(reversed.entities.map((entity) => [entity.sourceOrdinal, entity.type])).toEqual([
      [0, "TEXT"],
      [1, "LINE"],
    ]);
    expect(semanticJsonHash(forward)).not.toBe(semanticJsonHash(reversed));
    expect(parseText(miniDxf({ entities: [line, text] }))).toEqual(forward);
  });

  it("normalizes reordered layer-table declarations identically without reordering entities", () => {
    const entities: Pair[][] = [
      [
        [0, "LINE"],
        [8, "Z-LAST"],
        [10, 0],
        [20, 0],
        [11, 1],
        [21, 1],
      ],
      [
        [0, "LINE"],
        [8, "A-FIRST"],
        [10, 2],
        [20, 2],
        [11, 3],
        [21, 3],
      ],
    ];
    const ordered = parseText(miniDxf({ layers: ["A-FIRST", "M-MID", "Z-LAST"], entities }));
    const shuffled = parseText(miniDxf({ layers: ["Z-LAST", "A-FIRST", "M-MID"], entities }));
    expect(shuffled.sourceHash).not.toBe(ordered.sourceHash);
    expect({ ...shuffled, sourceHash: ordered.sourceHash }).toEqual(ordered);
    expect(ordered.layers.map((layer) => layer.name)).toEqual(["A-FIRST", "M-MID", "Z-LAST"]);
    expect(ordered.entities.map((entity) => entity.layer)).toEqual(["Z-LAST", "A-FIRST"]);
  });

  describe("path independence", () => {
    const roots: string[] = [];
    afterEach(() => {
      for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
    });

    it("extracts deep-equal documents and evidence from two different source paths", () => {
      const results = ["alice-project", "bob workspace"].map((name) => {
        const root = mkdtempSync(join(tmpdir(), "avz-cad-10a-"));
        roots.push(root);
        mkdirSync(join(root, name, "drawings"), { recursive: true });
        copyFileSync(fixturePath, join(root, name, "drawings", `${name}.dxf`));
        return {
          root,
          name,
          result: extractCadDocument({
            repositoryRoot: root,
            sourcePath: `${name}/drawings/${name}.dxf`,
          }),
        };
      });
      const [first, second] = results;
      expect(first?.result.cadDocument).toEqual(second?.result.cadDocument);
      expect(first?.result.evidence).toEqual(second?.result.evidence);
      expect(first?.result.cadDocument).toEqual(expectedDocument);
      for (const { root, name, result } of results) {
        const serialized = JSON.stringify([result.cadDocument, result.evidence]);
        expect(serialized).not.toContain(name);
        expect(serialized).not.toContain(root);
        expect(serialized).not.toContain(tmpdir());
      }
    });
  });
});

describe("cad-document-v0.1 unit authority", () => {
  const units: [string, number, number][] = [
    ["inches", 1, 25.4],
    ["feet", 2, 304.8],
    ["millimeters", 4, 1],
    ["centimeters", 5, 10],
    ["meters", 6, 1000],
  ];

  /** One geometry expressed in each unit; mm values are exactly representable in all. */
  function unitSource(code: number, scale: number): string {
    const v = (millimeters: number) => String(Number((millimeters / scale).toPrecision(12)));
    return miniDxf({
      insunits: code,
      blockBase: [Number(v(1524)), 0, 0],
      entities: [
        [
          [0, "LINE"],
          [5, "10"],
          [8, "0"],
          [10, v(0)],
          [20, v(1524)],
          [30, v(0)],
          [11, v(6096)],
          [21, v(3048)],
          [31, v(1524)],
        ],
        [
          [0, "LWPOLYLINE"],
          [5, "11"],
          [8, "0"],
          [90, 3],
          [70, 1],
          [38, v(3048)],
          [10, v(0)],
          [20, v(0)],
          [42, "0.5"],
          [10, v(9144)],
          [20, v(0)],
          [10, v(9144)],
          [20, v(6096)],
        ],
        [
          [0, "INSERT"],
          [5, "12"],
          [8, "0"],
          [2, "B"],
          [10, v(3048)],
          [20, v(1524)],
          [30, v(0)],
          [41, "2"],
          [50, "45"],
        ],
        [
          [0, "TEXT"],
          [5, "13"],
          [8, "0"],
          [10, v(1524)],
          [20, v(1524)],
          [40, v(1524)],
          [1, "UNIT"],
        ],
        [
          [0, "ARC"],
          [5, "14"],
          [8, "0"],
          [10, v(0)],
          [20, v(0)],
          [40, v(1524)],
        ],
      ],
    });
  }

  const millimeterDocument = parseText(unitSource(4, 1));

  it.each(units)(
    "normalizes %s (INSUNITS %i, x%d) to the exact millimeter geometry",
    (name, code, scale) => {
      const document = parseText(unitSource(code, scale));
      expect(document.sourceUnits).toEqual({ insunitsCode: code, name, scaleToMillimeters: scale });
      expect(document.header.insunitsCode).toBe(code);
      expect(document.canonicalUnits).toBe("millimeters");
      expect(geometryProjection(document)).toEqual(geometryProjection(millimeterDocument));
      if (code !== 4) expect(document.sourceHash).not.toBe(millimeterDocument.sourceHash);
    },
  );

  it("keeps bulge, rotation, and INSERT scale dimensionless (never unit-scaled)", () => {
    const inches = parseText(unitSource(1, 25.4));
    const polyline = inches.entities.find((entity) => entity.type === "LWPOLYLINE");
    const insert = inches.entities.find((entity) => entity.type === "INSERT");
    expect(polyline).toMatchObject({
      elevation: 3048,
      vertices: [{ bulge: 0.5 }, { bulge: 0 }, { bulge: 0 }],
    });
    expect(insert).toMatchObject({
      scale: [2, 1, 1],
      rotationDegrees: 45,
      insertionPoint: [3048, 1524, 0],
    });
  });

  it("fails closed with CAD_UNITS_UNSPECIFIED when $INSUNITS is absent or 0", () => {
    expectCadError(
      () => parseText(miniDxf({ insunits: null, entities: [] })),
      "CAD_UNITS_UNSPECIFIED",
    );
    expectCadError(
      () => parseText(miniDxf({ insunits: 0, entities: [] })),
      "CAD_UNITS_UNSPECIFIED",
    );
    const noHeader = "0\nSECTION\n2\nENTITIES\n0\nENDSEC\n0\nEOF\n";
    expectCadError(() => parseText(noHeader), "CAD_UNITS_UNSPECIFIED");
  });

  it("fails closed with CAD_UNITS_UNSUPPORTED and reports the raw code", () => {
    for (const code of [3, 7, 14, 21, -1]) {
      const error = expectCadError(
        () => parseText(miniDxf({ insunits: code, entities: [] })),
        "CAD_UNITS_UNSUPPORTED",
      );
      expect(error.details.insunitsCode).toBe(code);
    }
  });
});

describe("cad-document-v0.1 fail-closed source safety", () => {
  const line: Pair[] = [
    [0, "LINE"],
    [8, "0"],
    [10, 0],
    [20, 0],
    [11, 1],
    [21, 1],
  ];

  it.each([
    ["truncated pair", miniDxf({ entities: [line] }).replace(/\nEOF\n$/, "\n")],
    ["missing EOF", miniDxf({ entities: [line] }).replace(/0\nEOF\n$/, "")],
    ["records after EOF", `${miniDxf({ entities: [line] })}0\nLINE\n`],
    ["invalid group code", miniDxf({ entities: [line] }).replace("0\nLINE", "X\nLINE")],
    ["unterminated section", miniDxf({ entities: [line] }).replace("0\nENDSEC\n0\nEOF", "0\nEOF")],
    [
      "non-numeric coordinate",
      miniDxf({
        entities: [
          [
            [0, "LINE"],
            [8, "0"],
            [10, "abc"],
            [20, 0],
            [11, 1],
            [21, 1],
          ],
        ],
      }),
    ],
    [
      "missing required Y",
      miniDxf({
        entities: [
          [
            [0, "LINE"],
            [8, "0"],
            [10, 0],
            [11, 1],
            [21, 1],
          ],
        ],
      }),
    ],
    [
      "duplicate group",
      miniDxf({
        entities: [
          [
            [0, "LINE"],
            [8, "0"],
            [10, 0],
            [10, 1],
            [20, 0],
            [11, 1],
            [21, 1],
          ],
        ],
      }),
    ],
    [
      "missing layer",
      miniDxf({
        entities: [
          [
            [0, "CIRCLE"],
            [10, 0],
            [20, 0],
            [40, 1],
          ],
        ],
      }),
    ],
    [
      "vertex count mismatch",
      miniDxf({
        entities: [
          [
            [0, "LWPOLYLINE"],
            [8, "0"],
            [90, 3],
            [10, 0],
            [20, 0],
            [10, 1],
            [20, 1],
          ],
        ],
      }),
    ],
    [
      "bulge before vertex",
      miniDxf({
        entities: [
          [
            [0, "LWPOLYLINE"],
            [8, "0"],
            [90, 1],
            [42, 1],
            [10, 0],
            [20, 0],
          ],
        ],
      }),
    ],
    ["duplicate layer", miniDxf({ layers: ["0", "0"], entities: [] })],
    [
      "unbalanced 102 group",
      miniDxf({
        entities: [
          [
            [0, "LINE"],
            [102, "{ACAD"],
            [8, "0"],
            [10, 0],
            [20, 0],
            [11, 1],
            [21, 1],
          ],
        ],
      }),
    ],
  ])("rejects %s with CAD_DXF_PARSE_FAILED and no document", (_name, source) => {
    expectCadError(() => parseText(source), "CAD_DXF_PARSE_FAILED");
  });

  it("rejects invalid UTF-8 text rather than guessing a code page", () => {
    const bytes = encode(
      miniDxf({
        entities: [
          [
            [0, "TEXT"],
            [8, "0"],
            [10, 0],
            [20, 0],
            [1, "X"],
          ],
        ],
      }),
    );
    const index = bytes.indexOf("X".charCodeAt(0), bytes.length - 40);
    const invalid = Uint8Array.from(bytes);
    invalid[index] = 0xff;
    expectCadError(() => parseDxfSource(invalid), "CAD_DXF_PARSE_FAILED");
  });

  it("rejects non-finite numbers, including after unit conversion", () => {
    const overflow = miniDxf({
      entities: [
        [
          [0, "LINE"],
          [8, "0"],
          [10, "1e999"],
          [20, 0],
          [11, 1],
          [21, 1],
        ],
      ],
    });
    expectCadError(() => parseText(overflow), "CAD_NUMERIC_NON_FINITE");
    for (const token of ["NaN", "Infinity", "-inf"]) {
      const source = miniDxf({
        entities: [
          [
            [0, "LINE"],
            [8, "0"],
            [10, token],
            [20, 0],
            [11, 1],
            [21, 1],
          ],
        ],
      });
      expectCadError(() => parseText(source), "CAD_DXF_PARSE_FAILED");
    }
    const scaled = miniDxf({
      insunits: 6,
      entities: [
        [
          [0, "LINE"],
          [8, "0"],
          [10, "1e306"],
          [20, 0],
          [11, 1],
          [21, 1],
        ],
      ],
    });
    expectCadError(() => parseText(scaled), "CAD_NUMERIC_NON_FINITE");
  });

  it("rejects binary DXF by signature and NUL content before parsing", () => {
    const sentinel = encode("AutoCAD Binary DXF\r\n\u001a\u0000 garbage that would never parse");
    expectCadError(() => parseDxfSource(sentinel), "CAD_BINARY_DXF_UNSUPPORTED");
    const withNul = Uint8Array.from(fixtureBytes());
    withNul[withNul.length - 2] = 0;
    expectCadError(() => parseDxfSource(withNul), "CAD_BINARY_DXF_UNSUPPORTED");
  });

  it("rejects oversized input before any parsing (garbage content is never inspected)", () => {
    const garbage = new Uint8Array(CAD_SOURCE_MAX_BYTES + 1).fill(0);
    expectCadError(() => parseDxfSource(garbage), "CAD_SOURCE_TOO_LARGE");
    expectCadError(
      () => parseDxfSource(fixtureBytes(), { maxSourceBytes: 1024 }),
      "CAD_SOURCE_TOO_LARGE",
    );
    expect(() => new DxfSourceAdapter({ maxSourceBytes: CAD_SOURCE_MAX_BYTES + 1 })).toThrow(
      RangeError,
    );
  });

  it("marks non-default OCS extrusion and INSERT arrays unsupported instead of guessing", () => {
    const document = parseText(
      miniDxf({
        entities: [
          [
            [0, "LWPOLYLINE"],
            [5, "E1"],
            [8, "0"],
            [90, 1],
            [10, 0],
            [20, 0],
            [210, 0],
            [220, 0],
            [230, -1],
          ],
          [
            [0, "INSERT"],
            [5, "E2"],
            [8, "0"],
            [2, "B"],
            [10, 0],
            [20, 0],
            [70, 2],
            [44, 100],
          ],
          [
            [0, "TEXT"],
            [5, "E3"],
            [8, "0"],
            [10, 0],
            [20, 0],
            [1, "X"],
            [230, 1],
          ],
        ],
      }),
    );
    expect(document.unsupportedEntities).toEqual([
      {
        sourceOrdinal: 0,
        sourceHandle: "E1",
        layer: "0",
        type: "LWPOLYLINE",
        reason: "UNSUPPORTED_OCS_EXTRUSION",
      },
      {
        sourceOrdinal: 1,
        sourceHandle: "E2",
        layer: "0",
        type: "INSERT",
        reason: "UNSUPPORTED_INSERT_ARRAY",
      },
    ]);
    expect(document.entities).toMatchObject([{ sourceOrdinal: 2, type: "TEXT", height: null }]);
  });
});

describe("cad-extraction-evidence-v0.1 and worker boundary", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });
  const tempRoot = () => {
    const root = mkdtempSync(join(tmpdir(), "avz-cad-10a-"));
    roots.push(root);
    return root;
  };

  it("builds valid evidence with byte sourceHash and semantic cadDocumentHash only", () => {
    const { cadDocument, cadDocumentHash, evidence } = extractCadDocumentFromBytes(fixtureBytes());
    expect(cadDocumentHash).toBe(semanticJsonHash(cadDocument));
    expect(evidence).toEqual({
      evidenceVersion: "0.1.0",
      sourceFormat: "dxf",
      sourceHash: FROZEN_SOURCE_HASH,
      cadDocumentVersion: "0.1.0",
      cadDocumentHash: FROZEN_DOCUMENT_HASH,
      sourceUnits: { insunitsCode: 4, name: "millimeters", scaleToMillimeters: 1 },
      canonicalUnits: "millimeters",
      summary: expectedDocument.summary,
      status: "PASS",
    });
    expect(validateCadExtractionEvidence(evidence).ok).toBe(true);
    expect(validateCadExtractionEvidence({ ...evidence, sourcePath: "C:/x.dxf" }).ok).toBe(false);
    expect(validateCadExtractionEvidence({ ...evidence, entities: [] }).ok).toBe(false);
    expect(validateCadExtractionEvidence({ ...evidence, status: "FAILED" }).ok).toBe(false);
  });

  it("maps adapter failures to the same project-owned codes at the worker boundary", () => {
    try {
      extractCadDocumentFromBytes(encode(miniDxf({ insunits: 0, entities: [] })));
      throw new Error("expected failure");
    } catch (error) {
      expect(error).toBeInstanceOf(CadExtractionError);
      expect((error as CadExtractionError).code).toBe("CAD_UNITS_UNSPECIFIED");
    }
  });

  it("enforces the trusted source path policy", () => {
    const root = tempRoot();
    mkdirSync(join(root, "folder.dxf"));
    writeFileSync(join(root, "notes.txt"), "0\nEOF\n");
    const codeFor = (sourcePath: string) => {
      try {
        extractCadDocument({ repositoryRoot: root, sourcePath });
        return "PASS";
      } catch (error) {
        return (error as CadExtractionError).code;
      }
    };
    expect(codeFor("../outside.dxf")).toBe("CAD_SOURCE_PATH_INVALID");
    expect(codeFor(resolve(root, "absolute.dxf"))).toBe("CAD_SOURCE_PATH_INVALID");
    expect(codeFor("")).toBe("CAD_SOURCE_PATH_INVALID");
    expect(codeFor("notes.txt")).toBe("CAD_SOURCE_PATH_INVALID");
    expect(codeFor("folder.dxf")).toBe("CAD_SOURCE_PATH_INVALID");
    expect(codeFor("missing.dxf")).toBe("CAD_SOURCE_NOT_FOUND");
  });

  it("rejects an oversized source file by size before reading it", () => {
    const root = tempRoot();
    writeFileSync(join(root, "big.dxf"), Buffer.alloc(2048, 0x41));
    expect(() =>
      extractCadDocument({ repositoryRoot: root, sourcePath: "big.dxf", maxSourceBytes: 1024 }),
    ).toThrow(expect.objectContaining({ code: "CAD_SOURCE_TOO_LARGE" }));
  });

  it("writes deterministic document + evidence under the output root and never escapes it", () => {
    const root = tempRoot();
    copyFileSync(fixturePath, join(root, "plan.dxf"));
    const extraction = extractCadDocument({ repositoryRoot: root, sourcePath: "plan.dxf" });
    const outputRoot = join(root, "out");
    const paths = writeCadExtraction(extraction, outputRoot, "cad/plan.json");
    expect(paths.documentPath).toBe(join(outputRoot, "cad", "plan.json"));
    expect(paths.evidencePath).toBe(join(outputRoot, "cad", "plan.evidence.json"));
    expect(JSON.parse(readFileSync(paths.documentPath, "utf8"))).toEqual(expectedDocument);
    expect(readFileSync(paths.documentPath, "utf8")).toBe(
      `${JSON.stringify(expectedDocument, null, 2)}\n`,
    );
    expect(JSON.parse(readFileSync(paths.evidencePath, "utf8"))).toEqual(extraction.evidence);
    expect(readFileSync(join(root, "plan.dxf"))).toEqual(readFileSync(fixturePath));
    for (const bad of [
      "../escape.json",
      resolve(root, "abs.json"),
      "plan.dxf",
      "x.evidence.json",
      "",
    ]) {
      expect(() => writeCadExtraction(extraction, outputRoot, bad)).toThrow(
        expect.objectContaining({ code: "CAD_OUTPUT_PATH_INVALID" }),
      );
    }
    expect(readdirSync(root).sort()).toEqual(["out", "plan.dxf"]);
  });
});

describe("Spike 10A static boundary guards", () => {
  const cadParserSource = join(repositoryRoot, "packages/cad-parser/src");
  const sources = readdirSync(cadParserSource)
    .filter((file) => file.endsWith(".ts"))
    .map((file) => ({ file, text: readFileSync(join(cadParserSource, file), "utf8") }));
  const importsOf = (text: string) =>
    [...text.matchAll(/(?:from|import)\s*\(?\s*"([^"]+)"/g)].map((match) => match[1] as string);

  it("keeps cad-parser pure: only node:crypto, node:fs (own schema), ajv, and local modules", () => {
    const allowed = new Set(["node:crypto", "node:fs", "ajv/dist/2020.js", "ajv-formats"]);
    for (const { file, text } of sources) {
      for (const specifier of importsOf(text)) {
        expect(
          allowed.has(specifier) || /^\.\/[a-z-]+\.js$/.test(specifier),
          `${file}: ${specifier}`,
        ).toBe(true);
      }
    }
  });

  it("contains no process, network, eval, environment, DCC, renderer, or AI hooks", () => {
    const forbidden =
      /child_process|node:http|node:https|node:net|node:dgram|\bfetch\(|XMLHttpRequest|WebSocket|process\.env|\beval\(|new Function|require\(|@ai-archviz\/worker|apps\/worker|pymxs|3dsmax|corona|openai|anthropic|acad\.exe|accoreconsole/i;
    for (const { file, text } of sources) expect(text, file).not.toMatch(forbidden);
    // Only the dxf adapter knows the raw DXF group-code shape.
    for (const { file, text } of sources.filter((source) => source.file !== "dxf-adapter.ts")) {
      expect(text, file).not.toMatch(/DxfPair|DxfRecord|group code/);
    }
  });

  it("keeps the worker CAD boundary free of DCC execution modules", () => {
    const text = readFileSync(join(repositoryRoot, "apps/worker/src/cad-extraction.ts"), "utf8");
    expect(importsOf(text).sort()).toEqual([
      "./paths.js",
      "./workspace.js",
      "@ai-archviz/cad-parser",
      "@ai-archviz/worker-contracts",
      "node:fs",
      "node:path",
    ]);
    expect(text).not.toMatch(/child_process|process\.env|scene-spec|spatial-engine|dcc-|probe\.js/);
  });
});
