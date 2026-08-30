import { type SceneSpec, validateSceneSpec } from "@ai-archviz/scene-spec";
import { validateRenderJobV02 } from "@ai-archviz/worker-contracts";
import {
  type BuildPlanNode,
  compileGoldenBuildPlan,
  type OpeningMarker,
  type WallSegment,
} from "./build-plan.js";
import { deriveCameraFovRadians } from "./camera-policy.js";
import {
  coronaCanonicalAreaLightWidthMm,
  coronaCanonicalIntensityScale,
  isSupportedCanonicalCoronaLightType,
  sortCanonicalCoronaLights,
} from "./corona-renderer-policy.js";
import type { RendererAdapter } from "./renderer-adapter.js";

/** Re-exported for backward compatibility; the canonical definition now lives in camera-policy.ts. */
export { deriveCameraFovRadians };

export type Vector3 = [number, number, number];

export const coronaAdapterResolution = { width: 320, height: 240 } as const;
export const coronaAdapterPassLimit = 4;
export const coronaAdapterMaterialDefaults = {
  roughness: 0.45,
  nonMetalMode: true,
} as const;
export const coronaAdapterAreaLightDefaults = {
  widthMm: coronaCanonicalAreaLightWidthMm,
  intensityScale: coronaCanonicalIntensityScale,
} as const;

export type CoronaAdapterErrorCode =
  | "SCENE_SPEC_INVALID"
  | "RENDER_JOB_INVALID"
  | "RENDERER_NOT_REQUIRED"
  | "WRONG_RENDERER_ADAPTER"
  | "RENDER_MODE_UNSUPPORTED"
  | "CAMERA_NOT_FOUND"
  | "CAMERA_ID_AMBIGUOUS"
  | "MATERIAL_ID_DUPLICATE"
  | "MATERIAL_ASSIGNMENT_MATERIAL_MISSING"
  | "MATERIAL_ASSIGNMENT_TARGET_MISSING"
  | "MATERIAL_ASSIGNMENT_TARGET_AMBIGUOUS"
  | "MATERIAL_ASSIGNMENT_DUPLICATE_TARGET"
  | "RENDERER_LIGHT_TYPE_UNSUPPORTED"
  | "LIGHT_ID_DUPLICATE";

export class CoronaAdapterCompileError extends Error {
  constructor(
    readonly code: CoronaAdapterErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "CoronaAdapterCompileError";
  }
}

export interface CoronaExecutionMaterial {
  materialId: string;
  baseColorRgb: Vector3;
}

export interface CoronaExecutionMaterialAssignment {
  assignmentId: string;
  targetId: string;
  materialId: string;
}

export interface CoronaExecutionLight {
  logicalId: string;
  type: "area";
  position: Vector3;
  rotationEuler: Vector3;
  canonicalIntensity: number;
  mappedIntensity: number;
  widthMm: number;
}

export interface CoronaExecutionCamera {
  logicalId: string;
  position: Vector3;
  target: Vector3;
  focalLengthMm: number;
  sensorWidthMm: number;
  fovRadians: number;
}

export interface CoronaExecutionGeometry {
  nodes: BuildPlanNode[];
  wallSegments: WallSegment[];
  openingMarkers: OpeningMarker[];
}

export interface CoronaExecutionPlan {
  planVersion: "0.1.0";
  engine: "corona";
  projectId: string;
  sceneId: string;
  revisionId: string;
  coordinateSystem: {
    linearUnit: "mm";
    angularUnit: "degree";
    upAxis: "Z";
    handedness: "right";
  };
  geometry: CoronaExecutionGeometry;
  materials: CoronaExecutionMaterial[];
  materialAssignments: CoronaExecutionMaterialAssignment[];
  lights: CoronaExecutionLight[];
  camera: CoronaExecutionCamera;
  render: {
    mode: "preview";
    resolution: typeof coronaAdapterResolution;
    termination: { type: "pass_limit"; value: typeof coronaAdapterPassLimit };
  };
  adapterDefaults: {
    /**
     * Legacy/v0.2-compatibility realization defaults. SceneSpec v0.2 carries
     * no material appearance, so plan v0.1 fills roughness/non-metal in from
     * here. These never apply to a v0.3 canonical-appearance material
     * (`CoronaExecutionPlanV02`), whose roughness/metalness always come
     * directly from SceneSpec.
     */
    material: typeof coronaAdapterMaterialDefaults;
    areaLight: typeof coronaAdapterAreaLightDefaults;
  };
}

export interface CoronaExecutionMaterialV02 extends CoronaExecutionMaterial {
  roughness: number;
  metalness: number;
}

/**
 * Corona execution plan v0.2: canonical material appearance (Spike 8F). Used
 * only for a SceneSpec v0.3 source; v0.1 remains the plan produced by
 * `compile()` for v0.2 SceneSpecs and is unchanged.
 */
export interface CoronaExecutionPlanV02 {
  planVersion: "0.2.0";
  engine: "corona";
  projectId: string;
  sceneId: string;
  revisionId: string;
  coordinateSystem: CoronaExecutionPlan["coordinateSystem"];
  geometry: CoronaExecutionGeometry;
  materials: CoronaExecutionMaterialV02[];
  materialAssignments: CoronaExecutionMaterialAssignment[];
  lights: CoronaExecutionLight[];
  camera: CoronaExecutionCamera;
  render: CoronaExecutionPlan["render"];
  adapterDefaults: {
    areaLight: typeof coronaAdapterAreaLightDefaults;
  };
}

const goldenLivingCoronaPreviewLight = Object.freeze({
  id: "preview_key_area",
  type: "area" as const,
  position: Object.freeze([3000, 1600, 2800]) as unknown as Vector3,
  rotationEuler: Object.freeze([-35, 0, 0]) as unknown as Vector3,
  intensity: 1.25,
});

export const goldenLivingCoronaPreviewProfile = Object.freeze({
  profileVersion: "0.1.0",
  profileId: "golden_living_corona_preview_v1",
  engine: "corona",
  mode: "preview",
  lightRig: Object.freeze([goldenLivingCoronaPreviewLight]),
} as const);

export interface GoldenCoronaPreviewPlan {
  planVersion: "0.1.0";
  engine: "corona";
  intentSource: "trusted_diagnostic_profile";
  profileId: typeof goldenLivingCoronaPreviewProfile.profileId;
  source: {
    projectId: "project_golden_living_001";
    sceneId: "scene_golden_living_001";
    revisionId: "rev_golden_0008";
    sceneSpecHash: string;
    artifactHash: string;
  };
  materials: CoronaExecutionMaterial[];
  materialAssignments: CoronaExecutionMaterialAssignment[];
  camera: CoronaExecutionCamera;
  temporaryLight: CoronaExecutionLight & { executionOnlyName: "AVZ_PREVIEW_CORONA_KEY" };
  render: CoronaExecutionPlan["render"];
  adapterDefaults: CoronaExecutionPlan["adapterDefaults"];
}

interface TransformInput {
  position: Vector3;
  rotationEuler: Vector3;
}

interface MaterialInput {
  id: string;
  baseColorRgb: Vector3;
}

interface MaterialInputV03 extends MaterialInput {
  roughness: number;
  metalness: number;
}

interface MaterialAssignmentInput {
  id: string;
  targetId: string;
  materialId: string;
}

interface CameraInput {
  id: string;
  transform: TransformInput;
  target: Vector3;
  focalLengthMm: number;
  sensorWidthMm: number;
}

interface LightInput {
  id: string;
  type: string;
  transform: TransformInput;
  intensity: number;
}

interface SceneSpecSubset {
  sceneSpecVersion?: string;
  project: { id: string };
  scene: { id: string; revisionId: string };
  render: { engine: string; mode: string };
  geometry: Array<{ id: string }>;
  openings: Array<{ id: string }>;
  assets: Array<{ id: string }>;
  materials?: MaterialInput[];
  materialAssignments?: MaterialAssignmentInput[];
  lights?: LightInput[];
  cameras: CameraInput[];
}

interface SceneSpecSubsetV03 extends Omit<SceneSpecSubset, "materials"> {
  materials?: MaterialInputV03[];
}

function copyVector(value: Vector3): Vector3 {
  return [value[0], value[1], value[2]];
}

function sortedById<T extends { id: string }>(values: readonly T[]): T[] {
  return [...values].sort((left, right) => left.id.localeCompare(right.id));
}

function fail(code: CoronaAdapterErrorCode, message: string): never {
  throw new CoronaAdapterCompileError(code, message);
}

function assertUniqueIds(values: readonly { id: string }[], code: CoronaAdapterErrorCode): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value.id)) fail(code, `Duplicate canonical id: ${value.id}`);
    seen.add(value.id);
  }
}

function validateSemanticIntent(scene: SceneSpecSubset, renderJob: Record<string, unknown>): void {
  if (scene.render.engine === "none") {
    fail(
      "RENDERER_NOT_REQUIRED",
      "SceneSpec render.engine=none must not invoke a renderer adapter",
    );
  }
  if (scene.render.engine !== "corona") {
    fail("WRONG_RENDERER_ADAPTER", "Corona adapter accepts only SceneSpec render.engine=corona");
  }
  if (scene.render.mode !== "preview") {
    fail("RENDER_MODE_UNSUPPORTED", "Corona adapter supports SceneSpec preview mode only");
  }
  if (renderJob.engine !== "corona") {
    fail("WRONG_RENDERER_ADAPTER", "Corona adapter accepts only Corona render jobs");
  }
  if (renderJob.mode !== "preview") {
    fail("RENDER_MODE_UNSUPPORTED", "Corona adapter supports preview render jobs only");
  }
}

function resolveCamera(
  scene: SceneSpecSubset,
  renderJob: Record<string, unknown>,
): CoronaExecutionCamera {
  const cameraId = String(renderJob.cameraId);
  const matches = scene.cameras.filter((camera) => camera.id === cameraId);
  if (matches.length === 0) fail("CAMERA_NOT_FOUND", `Render camera is missing: ${cameraId}`);
  if (matches.length !== 1) fail("CAMERA_ID_AMBIGUOUS", `Render camera is ambiguous: ${cameraId}`);
  const camera = matches[0] as CameraInput;
  return {
    logicalId: camera.id,
    position: copyVector(camera.transform.position),
    target: copyVector(camera.target),
    focalLengthMm: camera.focalLengthMm,
    sensorWidthMm: camera.sensorWidthMm,
    fovRadians: deriveCameraFovRadians(camera.focalLengthMm, camera.sensorWidthMm),
  };
}

/**
 * Shared material-assignment validation for both plan v0.1 (`MaterialInput`)
 * and plan v0.2 (`MaterialInputV03`) sources. Identity is always `materialId`;
 * this never compares appearance values, so distinct IDs with identical
 * appearance stay distinct (see `resolveMaterialsV03`'s deduplication proof).
 */
function resolveMaterialAssignments<M extends MaterialInput>(
  scene: Pick<SceneSpecSubset, "geometry" | "openings" | "assets" | "materialAssignments">,
  inputs: readonly M[],
): { assignments: CoronaExecutionMaterialAssignment[]; usedMaterialIds: Set<string> } {
  assertUniqueIds(inputs, "MATERIAL_ID_DUPLICATE");
  const byId = new Map(inputs.map((material) => [material.id, material]));
  const targetCounts = new Map<string, number>();
  for (const target of [...scene.geometry, ...scene.openings, ...scene.assets]) {
    targetCounts.set(target.id, (targetCounts.get(target.id) ?? 0) + 1);
  }

  const assignments = scene.materialAssignments ?? [];
  const assignedTargets = new Set<string>();
  for (const assignment of assignments) {
    if (!byId.has(assignment.materialId)) {
      fail(
        "MATERIAL_ASSIGNMENT_MATERIAL_MISSING",
        `Assignment ${assignment.id} references missing material ${assignment.materialId}`,
      );
    }
    const targetCount = targetCounts.get(assignment.targetId) ?? 0;
    if (targetCount === 0) {
      fail(
        "MATERIAL_ASSIGNMENT_TARGET_MISSING",
        `Assignment ${assignment.id} references missing target ${assignment.targetId}`,
      );
    }
    if (targetCount !== 1) {
      fail(
        "MATERIAL_ASSIGNMENT_TARGET_AMBIGUOUS",
        `Assignment ${assignment.id} references ambiguous target ${assignment.targetId}`,
      );
    }
    if (assignedTargets.has(assignment.targetId)) {
      fail(
        "MATERIAL_ASSIGNMENT_DUPLICATE_TARGET",
        `Multiple assignments target ${assignment.targetId}`,
      );
    }
    assignedTargets.add(assignment.targetId);
  }

  return {
    assignments: [...assignments]
      .sort((left, right) => left.targetId.localeCompare(right.targetId))
      .map((assignment) => ({
        assignmentId: assignment.id,
        targetId: assignment.targetId,
        materialId: assignment.materialId,
      })),
    usedMaterialIds: new Set(assignments.map((assignment) => assignment.materialId)),
  };
}

function resolveMaterials(scene: SceneSpecSubset): {
  materials: CoronaExecutionMaterial[];
  assignments: CoronaExecutionMaterialAssignment[];
} {
  const inputs = scene.materials ?? [];
  const { assignments, usedMaterialIds } = resolveMaterialAssignments(scene, inputs);
  return {
    materials: sortedById(inputs)
      .filter((material) => usedMaterialIds.has(material.id))
      .map((material) => ({
        materialId: material.id,
        baseColorRgb: copyVector(material.baseColorRgb),
      })),
    assignments,
  };
}

/** Canonical roughness/metalness come only from SceneSpec v0.3; no adapter default applies. */
function resolveMaterialsV03(scene: SceneSpecSubsetV03): {
  materials: CoronaExecutionMaterialV02[];
  assignments: CoronaExecutionMaterialAssignment[];
} {
  const inputs = scene.materials ?? [];
  const { assignments, usedMaterialIds } = resolveMaterialAssignments(scene, inputs);
  return {
    materials: sortedById(inputs)
      .filter((material) => usedMaterialIds.has(material.id))
      .map((material) => ({
        materialId: material.id,
        baseColorRgb: copyVector(material.baseColorRgb),
        roughness: material.roughness,
        metalness: material.metalness,
      })),
    assignments,
  };
}

function resolveLights(scene: SceneSpecSubset): CoronaExecutionLight[] {
  const inputs = scene.lights ?? [];
  assertUniqueIds(inputs, "LIGHT_ID_DUPLICATE");
  return sortCanonicalCoronaLights(inputs).map((light) => {
    if (!isSupportedCanonicalCoronaLightType(light.type)) {
      fail(
        "RENDERER_LIGHT_TYPE_UNSUPPORTED",
        `Corona adapter supports SceneSpec area lights only: ${light.id}`,
      );
    }
    return {
      logicalId: light.id,
      type: "area",
      position: copyVector(light.transform.position),
      rotationEuler: copyVector(light.transform.rotationEuler),
      canonicalIntensity: light.intensity,
      mappedIntensity: light.intensity * coronaAdapterAreaLightDefaults.intensityScale,
      widthMm: coronaAdapterAreaLightDefaults.widthMm,
    };
  });
}

/** Pure SceneSpec-to-Corona plan compiler; DCC/plugin work begins only after this succeeds. */
export class CoronaRendererAdapter implements RendererAdapter<CoronaExecutionPlan> {
  readonly engine = "corona" as const;

  compile(sceneSpec: SceneSpec, renderJob: unknown): CoronaExecutionPlan {
    const sceneValidation = validateSceneSpec(sceneSpec);
    if (!sceneValidation.ok) {
      fail("SCENE_SPEC_INVALID", JSON.stringify(sceneValidation.errors));
    }
    const jobValidation = validateRenderJobV02(renderJob);
    if (!jobValidation.ok) {
      fail("RENDER_JOB_INVALID", JSON.stringify(jobValidation.errors));
    }
    const scene = sceneValidation.value as unknown as SceneSpecSubset;
    const job = jobValidation.value as Record<string, unknown>;
    validateSemanticIntent(scene, job);
    const camera = resolveCamera(scene, job);
    const materialResolution = resolveMaterials(scene);
    const lights = resolveLights(scene);
    const buildPlan = compileGoldenBuildPlan(sceneSpec);

    return {
      planVersion: "0.1.0",
      engine: "corona",
      projectId: scene.project.id,
      sceneId: scene.scene.id,
      revisionId: scene.scene.revisionId,
      coordinateSystem: structuredClone(buildPlan.coordinateSystem),
      geometry: {
        nodes: buildPlan.nodes.map(
          ({ materialId: _materialId, materialBaseColorRgb: _materialBaseColorRgb, ...node }) =>
            structuredClone(node),
        ),
        wallSegments: structuredClone(buildPlan.wallSegments),
        openingMarkers: structuredClone(buildPlan.openingMarkers),
      },
      materials: materialResolution.materials,
      materialAssignments: materialResolution.assignments,
      lights,
      camera,
      render: {
        mode: "preview",
        resolution: coronaAdapterResolution,
        termination: { type: "pass_limit", value: coronaAdapterPassLimit },
      },
      adapterDefaults: {
        material: coronaAdapterMaterialDefaults,
        areaLight: coronaAdapterAreaLightDefaults,
      },
    };
  }

  /**
   * Compiles a SceneSpec v0.3 canonical material-appearance source into plan
   * v0.2. Deliberately separate from `compile`: it accepts only v0.3 and its
   * material roughness/metalness always come from SceneSpec, never an
   * adapter default (Technical Spike 8F).
   */
  compileCanonicalMaterialAppearance(
    sceneSpec: SceneSpec,
    renderJob: unknown,
  ): CoronaExecutionPlanV02 {
    const sceneValidation = validateSceneSpec(sceneSpec);
    if (!sceneValidation.ok) {
      fail("SCENE_SPEC_INVALID", JSON.stringify(sceneValidation.errors));
    }
    const scene = sceneValidation.value as unknown as SceneSpecSubsetV03;
    if (scene.sceneSpecVersion !== "0.3.0") {
      fail("SCENE_SPEC_INVALID", "Canonical material appearance requires a SceneSpec v0.3 source");
    }
    const jobValidation = validateRenderJobV02(renderJob);
    if (!jobValidation.ok) {
      fail("RENDER_JOB_INVALID", JSON.stringify(jobValidation.errors));
    }
    const job = jobValidation.value as Record<string, unknown>;
    validateSemanticIntent(scene, job);
    const camera = resolveCamera(scene, job);
    const materialResolution = resolveMaterialsV03(scene);
    const lights = resolveLights(scene);
    const buildPlan = compileGoldenBuildPlan(sceneSpec);

    return {
      planVersion: "0.2.0",
      engine: "corona",
      projectId: scene.project.id,
      sceneId: scene.scene.id,
      revisionId: scene.scene.revisionId,
      coordinateSystem: structuredClone(buildPlan.coordinateSystem),
      geometry: {
        nodes: buildPlan.nodes.map(
          ({ materialId: _materialId, materialBaseColorRgb: _materialBaseColorRgb, ...node }) =>
            structuredClone(node),
        ),
        wallSegments: structuredClone(buildPlan.wallSegments),
        openingMarkers: structuredClone(buildPlan.openingMarkers),
      },
      materials: materialResolution.materials,
      materialAssignments: materialResolution.assignments,
      lights,
      camera,
      render: {
        mode: "preview",
        resolution: coronaAdapterResolution,
        termination: { type: "pass_limit", value: coronaAdapterPassLimit },
      },
      adapterDefaults: {
        areaLight: coronaAdapterAreaLightDefaults,
      },
    };
  }

  /**
   * Compiles only the repository-owned Golden rev8 diagnostic preview. This is
   * deliberately separate from `compile`: rev8 retains `render.engine=none`
   * and no user/job input can substitute the temporary preview profile.
   */
  compileDiagnosticPreview(
    sceneSpec: SceneSpec,
    source: { artifactHash: string; sceneSpecHash: string },
  ): GoldenCoronaPreviewPlan {
    const sceneValidation = validateSceneSpec(sceneSpec);
    if (!sceneValidation.ok) {
      fail("SCENE_SPEC_INVALID", JSON.stringify(sceneValidation.errors));
    }
    const scene = sceneValidation.value as unknown as SceneSpecSubset;
    if (
      scene.project.id !== "project_golden_living_001" ||
      scene.scene.id !== "scene_golden_living_001" ||
      scene.scene.revisionId !== "rev_golden_0008" ||
      scene.render.engine !== "none" ||
      scene.render.mode !== "build_only"
    ) {
      fail(
        "RENDERER_NOT_REQUIRED",
        "Diagnostic preview accepts only the canonical Golden rev8 build-only SceneSpec",
      );
    }
    if (!/^sha256:[0-9a-f]{64}$/u.test(source.artifactHash)) {
      fail("SCENE_SPEC_INVALID", "Diagnostic preview requires a raw SHA-256 source artifact hash");
    }
    if (!/^sha256:[0-9a-f]{64}$/u.test(source.sceneSpecHash)) {
      fail("SCENE_SPEC_INVALID", "Diagnostic preview requires an RFC8785 SceneSpec hash");
    }
    const camera = resolveCamera(scene, { cameraId: "camera_living_a" });
    const materialResolution = resolveMaterials(scene);
    const profileLight = goldenLivingCoronaPreviewProfile.lightRig[0];
    if (!profileLight) {
      fail("SCENE_SPEC_INVALID", "Trusted diagnostic preview profile is incomplete");
    }
    return {
      planVersion: "0.1.0",
      engine: "corona",
      intentSource: "trusted_diagnostic_profile",
      profileId: goldenLivingCoronaPreviewProfile.profileId,
      source: {
        projectId: "project_golden_living_001",
        sceneId: "scene_golden_living_001",
        revisionId: "rev_golden_0008",
        sceneSpecHash: source.sceneSpecHash,
        artifactHash: source.artifactHash,
      },
      materials: materialResolution.materials,
      materialAssignments: materialResolution.assignments,
      camera,
      temporaryLight: {
        logicalId: profileLight.id,
        type: "area",
        position: copyVector(profileLight.position),
        rotationEuler: copyVector(profileLight.rotationEuler),
        canonicalIntensity: profileLight.intensity,
        mappedIntensity: profileLight.intensity * coronaAdapterAreaLightDefaults.intensityScale,
        widthMm: coronaAdapterAreaLightDefaults.widthMm,
        executionOnlyName: "AVZ_PREVIEW_CORONA_KEY",
      },
      render: {
        mode: "preview",
        resolution: coronaAdapterResolution,
        termination: { type: "pass_limit", value: coronaAdapterPassLimit },
      },
      adapterDefaults: {
        material: coronaAdapterMaterialDefaults,
        areaLight: coronaAdapterAreaLightDefaults,
      },
    };
  }
}
