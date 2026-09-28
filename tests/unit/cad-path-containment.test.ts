import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { CadDocument } from "@ai-archviz/cad-parser";
import { semanticJsonHash } from "@ai-archviz/worker-contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type CadExtraction,
  CadExtractionError,
  extractCadDocument,
  writeCadExtraction,
} from "../../apps/worker/src/cad-extraction.js";

/*
 * Post-10A physical path containment. Every escape here uses a REAL
 * filesystem link: a directory junction on Windows (creatable without
 * elevation, and a reparse point exactly like the audit scenario) and a
 * directory symlink elsewhere. None of these tests are skipped on Windows.
 */

const repositoryRoot = resolve(import.meta.dirname, "../..");
const fixturePath = join(repositoryRoot, "tests/fixtures/cad/dxf/simple-room-mm.dxf");
const expectedDocument = JSON.parse(
  readFileSync(
    join(repositoryRoot, "tests/fixtures/cad/dxf/expected-cad-document-v0.1.json"),
    "utf8",
  ),
) as CadDocument;
const FROZEN_SOURCE_HASH =
  "sha256:f761c38d250e167bdd98a29befd8a4bb9a21a1190ebedfe9848192668489156f";
const FROZEN_DOCUMENT_HASH =
  "sha256:95f0c90d70a52f03c1cf627137d81880d30bb1ab7f03e7d9c39054149ad98b70";

/** Real directory link: junction on Windows, directory symlink on POSIX. */
function linkDirectory(target: string, linkPath: string): void {
  symlinkSync(target, linkPath, process.platform === "win32" ? "junction" : "dir");
}

/**
 * Final-entry link. A file symlink where the OS permits it; unelevated
 * Windows without Developer Mode refuses file symlinks (EPERM), so the
 * final entry is then a junction reparse point instead — still a link that
 * must never be followed.
 */
function linkFinalEntry(fileTarget: string, directoryTarget: string, linkPath: string): string {
  try {
    symlinkSync(fileTarget, linkPath, "file");
    return "file-symlink";
  } catch (error) {
    if (process.platform !== "win32" || (error as NodeJS.ErrnoException).code !== "EPERM") {
      throw error;
    }
    symlinkSync(directoryTarget, linkPath, "junction");
    return "junction";
  }
}

let base: string;
let root: string;
let outside: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "avz-cad-containment-"));
  root = join(base, "root");
  outside = join(base, "outside");
  mkdirSync(root);
  mkdirSync(outside);
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

function failureOf(action: () => unknown): { code: string; reason: unknown; message: string } {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(CadExtractionError);
    const cadError = error as CadExtractionError;
    return { code: cadError.code, reason: cadError.details.reason, message: cadError.message };
  }
  throw new Error("expected a CadExtractionError");
}

function extractFixtureAt(sourceRoot: string, relative: string): CadExtraction {
  mkdirSync(join(sourceRoot, relative, ".."), { recursive: true });
  copyFileSync(fixturePath, join(sourceRoot, relative));
  return extractCadDocument({ repositoryRoot: sourceRoot, sourcePath: relative });
}

describe("CAD source physical containment", () => {
  it("still accepts an ordinary nested real directory hierarchy", () => {
    const extraction = extractFixtureAt(root, "projects/a/drawings/plan.dxf");
    expect(extraction.cadDocument).toEqual(expectedDocument);
    expect(extraction.cadDocument.sourceHash).toBe(FROZEN_SOURCE_HASH);
    expect(extraction.cadDocumentHash).toBe(FROZEN_DOCUMENT_HASH);
    expect(extraction.sourceAbsolutePath).toBe(
      realpathSync.native(join(root, "projects/a/drawings/plan.dxf")),
    );
  });

  it("rejects a source reached through a parent link that escapes the root", () => {
    copyFileSync(fixturePath, join(outside, "plan.dxf"));
    linkDirectory(outside, join(root, "linked-source"));
    // Lexically the path is inside the root; physically it is not.
    expect(existsSync(join(root, "linked-source", "plan.dxf"))).toBe(true);
    const failure = failureOf(() =>
      extractCadDocument({ repositoryRoot: root, sourcePath: "linked-source/plan.dxf" }),
    );
    expect(failure).toMatchObject({ code: "CAD_SOURCE_PATH_INVALID", reason: "PHYSICAL_ESCAPE" });
  });

  it("never hands outside bytes to the parser (garbage outside yields PATH_INVALID, not a parse error)", () => {
    writeFileSync(join(outside, "plan.dxf"), "this is not DXF at all\n");
    linkDirectory(outside, join(root, "linked-source"));
    const failure = failureOf(() =>
      extractCadDocument({ repositoryRoot: root, sourcePath: "linked-source/plan.dxf" }),
    );
    expect(failure.code).toBe("CAD_SOURCE_PATH_INVALID");
  });

  it("rejects an escape through a deeper intermediate link", () => {
    mkdirSync(join(outside, "c"), { recursive: true });
    copyFileSync(fixturePath, join(outside, "c", "plan.dxf"));
    mkdirSync(join(root, "a"));
    linkDirectory(outside, join(root, "a", "b"));
    const failure = failureOf(() =>
      extractCadDocument({ repositoryRoot: root, sourcePath: "a/b/c/plan.dxf" }),
    );
    expect(failure).toMatchObject({ code: "CAD_SOURCE_PATH_INVALID", reason: "PHYSICAL_ESCAPE" });
  });

  it("allows an intermediate link whose physical target stays inside the root", () => {
    extractFixtureAt(root, "projects/plan.dxf");
    linkDirectory(join(root, "projects"), join(root, "alias"));
    const extraction = extractCadDocument({ repositoryRoot: root, sourcePath: "alias/plan.dxf" });
    expect(extraction.cadDocument).toEqual(expectedDocument);
    expect(extraction.sourceAbsolutePath).toBe(
      realpathSync.native(join(root, "projects/plan.dxf")),
    );
  });

  it("compares against the trusted root's realpath when the root itself is reached through a link", () => {
    extractFixtureAt(root, "plan.dxf");
    const rootAlias = join(base, "root-alias");
    linkDirectory(root, rootAlias);
    const extraction = extractCadDocument({ repositoryRoot: rootAlias, sourcePath: "plan.dxf" });
    expect(extraction.cadDocumentHash).toBe(FROZEN_DOCUMENT_HASH);
  });

  it("rejects a source whose FINAL entry is a link, even to an inside target", () => {
    copyFileSync(fixturePath, join(root, "real.dxf"));
    mkdirSync(join(root, "inside-dir"));
    const kind = linkFinalEntry(
      join(root, "real.dxf"),
      join(root, "inside-dir"),
      join(root, "link.dxf"),
    );
    expect(["file-symlink", "junction"]).toContain(kind);
    const failure = failureOf(() =>
      extractCadDocument({ repositoryRoot: root, sourcePath: "link.dxf" }),
    );
    expect(failure).toMatchObject({ code: "CAD_SOURCE_PATH_INVALID", reason: "NOT_REGULAR_FILE" });
  });

  it("fails closed on a broken link in the source route, distinct from a plain missing file", () => {
    linkDirectory(join(base, "does-not-exist"), join(root, "broken"));
    expect(
      failureOf(() => extractCadDocument({ repositoryRoot: root, sourcePath: "broken/plan.dxf" })),
    ).toMatchObject({ code: "CAD_SOURCE_PATH_INVALID", reason: "BROKEN_LINK_TRAVERSAL" });
    expect(
      failureOf(() => extractCadDocument({ repositoryRoot: root, sourcePath: "nope/plan.dxf" })),
    ).toMatchObject({ code: "CAD_SOURCE_NOT_FOUND" });
  });

  it("keeps the lexical checks in front of the physical ones", () => {
    copyFileSync(fixturePath, join(outside, "plan.dxf"));
    for (const sourcePath of ["../outside/plan.dxf", join(outside, "plan.dxf"), ""]) {
      expect(
        failureOf(() => extractCadDocument({ repositoryRoot: root, sourcePath })),
      ).toMatchObject({
        code: "CAD_SOURCE_PATH_INVALID",
      });
    }
  });
});

describe("CAD output physical containment", () => {
  let extraction: CadExtraction;
  let outputRoot: string;

  beforeEach(() => {
    extraction = extractFixtureAt(root, "plan.dxf");
    outputRoot = join(root, ".workspace");
  });

  it("creates a previously nonexistent nested output (and output root) normally", () => {
    expect(existsSync(outputRoot)).toBe(false);
    const paths = writeCadExtraction(extraction, outputRoot, "projects/a/cad/plan.json");
    expect(paths.documentPath).toBe(
      realpathSync.native(join(outputRoot, "projects/a/cad/plan.json")),
    );
    expect(paths.evidencePath).toBe(
      realpathSync.native(join(outputRoot, "projects/a/cad/plan.evidence.json")),
    );
    expect(JSON.parse(readFileSync(paths.documentPath, "utf8"))).toEqual(expectedDocument);
    expect(semanticJsonHash(JSON.parse(readFileSync(paths.documentPath, "utf8")))).toBe(
      FROZEN_DOCUMENT_HASH,
    );
    expect(JSON.parse(readFileSync(paths.evidencePath, "utf8"))).toEqual(extraction.evidence);
    // Re-running over the existing regular output files is allowed.
    expect(writeCadExtraction(extraction, outputRoot, "projects/a/cad/plan.json")).toEqual(paths);
  });

  it("rejects an output whose existing parent link escapes the root and creates nothing outside", () => {
    const target = join(outside, "target");
    mkdirSync(target);
    mkdirSync(outputRoot);
    linkDirectory(target, join(outputRoot, "linked-output"));
    for (const outputPath of ["linked-output/result.json", "linked-output/sub/result.json"]) {
      expect(failureOf(() => writeCadExtraction(extraction, outputRoot, outputPath))).toMatchObject(
        {
          code: "CAD_OUTPUT_PATH_INVALID",
          reason: "PHYSICAL_ESCAPE",
        },
      );
    }
    expect(existsSync(join(target, "result.json"))).toBe(false);
    expect(existsSync(join(target, "result.evidence.json"))).toBe(false);
    expect(readdirSync(target)).toEqual([]);
    expect(readdirSync(outside)).toEqual(["target"]);
  });

  it("rejects an escape through the output root's own subdirectory link chain", () => {
    mkdirSync(join(outputRoot, "a"), { recursive: true });
    linkDirectory(outside, join(outputRoot, "a", "b"));
    expect(
      failureOf(() => writeCadExtraction(extraction, outputRoot, "a/b/c/result.json")),
    ).toMatchObject({ code: "CAD_OUTPUT_PATH_INVALID" });
    expect(readdirSync(outside)).toEqual([]);
  });

  it("validates the evidence destination too, so there is no partial write", () => {
    mkdirSync(join(outputRoot, "cad"), { recursive: true });
    // An existing link where the evidence file would go.
    linkDirectory(outside, join(outputRoot, "cad", "plan.evidence.json"));
    expect(
      failureOf(() => writeCadExtraction(extraction, outputRoot, "cad/plan.json")),
    ).toMatchObject({ code: "CAD_OUTPUT_PATH_INVALID" });
    expect(existsSync(join(outputRoot, "cad", "plan.json"))).toBe(false);
    expect(readdirSync(outside)).toEqual([]);
  });

  it("allows an output link whose physical target stays inside the output root", () => {
    mkdirSync(join(outputRoot, "real"), { recursive: true });
    linkDirectory(join(outputRoot, "real"), join(outputRoot, "alias"));
    const paths = writeCadExtraction(extraction, outputRoot, "alias/plan.json");
    expect(paths.documentPath).toBe(realpathSync.native(join(outputRoot, "real", "plan.json")));
    expect(readdirSync(join(outputRoot, "real")).sort()).toEqual([
      "plan.evidence.json",
      "plan.json",
    ]);
  });

  it("keeps lexical output checks and never overwrites the source", () => {
    for (const outputPath of [
      "../escape.json",
      resolve(outputRoot, "abs.json"),
      "x.evidence.json",
      "",
    ]) {
      expect(failureOf(() => writeCadExtraction(extraction, outputRoot, outputPath)).code).toBe(
        "CAD_OUTPUT_PATH_INVALID",
      );
    }
    expect(readFileSync(join(root, "plan.dxf"))).toEqual(readFileSync(fixturePath));
    expect(readdirSync(base).sort()).toEqual(["outside", "root"]);
  });

  it("exposes only product-owned error codes, never raw filesystem errno codes", () => {
    linkDirectory(join(base, "gone"), join(root, "broken"));
    mkdirSync(outputRoot);
    linkDirectory(join(base, "gone"), join(outputRoot, "broken"));
    const failures = [
      failureOf(() => extractCadDocument({ repositoryRoot: root, sourcePath: "broken/x.dxf" })),
      failureOf(() => writeCadExtraction(extraction, outputRoot, "broken/x.json")),
    ];
    for (const failure of failures) {
      expect(failure.code).toMatch(/^CAD_(SOURCE|OUTPUT)_PATH_INVALID$/);
      expect(failure.message).not.toMatch(/ENOENT|ELOOP|EPERM|EACCES|ENOTDIR/);
    }
  });
});
