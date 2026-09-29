import {
  analyzeCirculation,
  analyzeCirculationV02,
  CIRCULATION_POLICY_VERSION,
  CIRCULATION_POLICY_VERSION_V02,
  type CirculationAnalysisResult,
  type CirculationAnalysisResultV02,
  type CirculationRouteQuery,
  type CirculationRouteResult,
  type CirculationRouteResultV02,
  type CirculationViolationCode,
  findCirculationRoute,
  findCirculationRouteV02,
} from "./circulation.js";
import { SPATIAL_POLICY_VERSION } from "./geometry.js";
import type { Point2 } from "./types.js";
import { SPATIAL_POLICY_VERSION_V02 } from "./validate-multispace.js";

export type CirculationRequirementEndpoint =
  | { kind: "door_portal"; openingId: string }
  | { kind: "point"; pointXY: Point2 };

/**
 * SceneSpec v0.4/v0.5 `circulationRequirements[]` entry (only
 * `same_space_route` exists). v0.4 pins circulation-policy-v0.1; v0.5 pins
 * circulation-policy-v0.2.
 */
export interface CirculationRequirement {
  id: string;
  type: "same_space_route";
  spaceId: string;
  evaluationPolicy: typeof CIRCULATION_POLICY_VERSION | typeof CIRCULATION_POLICY_VERSION_V02;
  start: CirculationRequirementEndpoint;
  end: CirculationRequirementEndpoint;
}

export interface CirculationRequirementResult {
  requirementId: string;
  spaceId: string;
  startKind: CirculationRequirementEndpoint["kind"];
  endKind: CirculationRequirementEndpoint["kind"];
  resolvedStartXY: Point2 | null;
  resolvedEndXY: Point2 | null;
  status: "SATISFIED" | "UNSATISFIED";
  startNodeId: string | null;
  endNodeId: string | null;
  distanceMm: number | null;
  orthogonalStepCount: number | null;
  diagonalStepCount: number | null;
  failureCode: CirculationViolationCode | null;
  /** The exact 9B route result for a SATISFIED requirement (hashed at the worker layer); otherwise null. */
  route: CirculationRouteResult | null;
}

export interface CirculationRequirementEvaluation {
  circulationPolicyVersion: typeof CIRCULATION_POLICY_VERSION;
  spatialPolicyVersion: typeof SPATIAL_POLICY_VERSION;
  sceneSpecVersion: string;
  projectId: string;
  sceneId: string;
  revisionId: string;
  status: "PASS" | "FAILED";
  requirements: CirculationRequirementResult[];
  /** The 9B analysis the requirements were resolved against (source of `graphSemanticHash`). */
  analysis: CirculationAnalysisResult;
}

export interface CirculationRequirementResultV02
  extends Omit<CirculationRequirementResult, "route"> {
  route: CirculationRouteResultV02 | null;
}

export interface CirculationRequirementEvaluationV02
  extends Omit<
    CirculationRequirementEvaluation,
    "circulationPolicyVersion" | "spatialPolicyVersion" | "requirements" | "analysis"
  > {
  circulationPolicyVersion: typeof CIRCULATION_POLICY_VERSION_V02;
  spatialPolicyVersion: typeof SPATIAL_POLICY_VERSION_V02;
  requirements: CirculationRequirementResultV02[];
  analysis: CirculationAnalysisResultV02;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function unsatisfied(
  requirement: CirculationRequirement,
  failureCode: CirculationViolationCode,
  resolved: { start: Point2 | null; end: Point2 | null },
  nodes: { start: string | null; end: string | null } = { start: null, end: null },
): CirculationRequirementResult {
  return {
    requirementId: requirement.id,
    spaceId: requirement.spaceId,
    startKind: requirement.start.kind,
    endKind: requirement.end.kind,
    resolvedStartXY: resolved.start,
    resolvedEndXY: resolved.end,
    status: "UNSATISFIED",
    startNodeId: nodes.start,
    endNodeId: nodes.end,
    distanceMm: null,
    orthogonalStepCount: null,
    diagonalStepCount: null,
    failureCode,
    route: null,
  };
}

/**
 * Pure evaluation of SceneSpec v0.4 canonical circulation requirements under
 * circulation-policy-v0.1. Expects a SceneSpec that already passed
 * `validateSceneSpec` (v0.4). 9B is the only route authority: door portals
 * come from `analyzeCirculation()` and routes from `findCirculationRoute()`;
 * no grid, portal formula, clearance rule, or pathfinder is reimplemented.
 * Each requirement depends only on its own endpoints and route, so an
 * unrelated blocked door portal never fails it.
 */
export function evaluateCirculationRequirements(
  sceneSpec: Record<string, unknown>,
): CirculationRequirementEvaluation | CirculationRequirementEvaluationV02 {
  // Explicit policy dispatch by SceneSpec version; never "latest available".
  if (sceneSpec.sceneSpecVersion === "0.5.0") {
    return evaluateWith(sceneSpec, {
      circulationPolicyVersion: CIRCULATION_POLICY_VERSION_V02,
      spatialPolicyVersion: SPATIAL_POLICY_VERSION_V02,
      analyze: analyzeCirculationV02,
      route: findCirculationRouteV02,
      sceneSpecVersion: "v0.5",
    }) as unknown as CirculationRequirementEvaluationV02;
  }
  return evaluateWith(sceneSpec, {
    circulationPolicyVersion: CIRCULATION_POLICY_VERSION,
    spatialPolicyVersion: SPATIAL_POLICY_VERSION,
    analyze: analyzeCirculation,
    route: findCirculationRoute,
    sceneSpecVersion: "v0.4",
  }) as CirculationRequirementEvaluation;
}

interface RequirementPolicy {
  circulationPolicyVersion: string;
  spatialPolicyVersion: string;
  analyze(
    sceneSpec: Record<string, unknown>,
  ): CirculationAnalysisResult | CirculationAnalysisResultV02;
  route(
    sceneSpec: Record<string, unknown>,
    query: CirculationRouteQuery,
  ): CirculationRouteResult | CirculationRouteResultV02;
  sceneSpecVersion: string;
}

function evaluateWith(sceneSpec: Record<string, unknown>, policy: RequirementPolicy) {
  const requirements = [
    ...((sceneSpec.circulationRequirements as CirculationRequirement[] | undefined) ?? []),
  ].sort((left, right) => compareText(left.id, right.id));
  const analysis = policy.analyze(sceneSpec);

  const results = requirements.map((requirement): CirculationRequirementResult => {
    if (analysis.spatialValidationStatus !== "PASS") {
      return unsatisfied(requirement, "CIRCULATION_SOURCE_SPATIAL_INVALID", {
        start: null,
        end: null,
      });
    }
    // The requirement's own space selects the portal: a shared door has one per connected space.
    const space = analysis.spaces.find((entry) => entry.spaceId === requirement.spaceId);
    const resolve = (endpoint: CirculationRequirementEndpoint) => {
      if (endpoint.kind === "point") {
        return { xy: [endpoint.pointXY[0], endpoint.pointXY[1]] as Point2, blocked: false };
      }
      const portal = space?.doorPortals.find((entry) => entry.openingId === endpoint.openingId);
      if (!portal) {
        throw new Error(
          `Requirement ${requirement.id} references door ${endpoint.openingId} with no portal in ${requirement.spaceId}; validate SceneSpec ${policy.sceneSpecVersion} first`,
        );
      }
      return { xy: portal.portalXY, blocked: portal.status === "BLOCKED" };
    };
    const start = resolve(requirement.start);
    const end = resolve(requirement.end);
    if (start.blocked || end.blocked) {
      return unsatisfied(requirement, "CIRCULATION_PORTAL_BLOCKED", {
        start: start.xy,
        end: end.xy,
      });
    }

    const route = policy.route(sceneSpec, {
      spaceId: requirement.spaceId,
      startXY: start.xy,
      endXY: end.xy,
    });
    if (route.status !== "PASS") {
      return unsatisfied(
        requirement,
        route.violations[0]?.code ?? "CIRCULATION_NO_ROUTE",
        { start: start.xy, end: end.xy },
        { start: route.startNodeId, end: route.endNodeId },
      );
    }
    return {
      requirementId: requirement.id,
      spaceId: requirement.spaceId,
      startKind: requirement.start.kind,
      endKind: requirement.end.kind,
      resolvedStartXY: start.xy,
      resolvedEndXY: end.xy,
      status: "SATISFIED",
      startNodeId: route.startNodeId,
      endNodeId: route.endNodeId,
      distanceMm: route.distanceMm,
      orthogonalStepCount: route.orthogonalStepCount,
      diagonalStepCount: route.diagonalStepCount,
      failureCode: null,
      route: route as CirculationRouteResult,
    };
  });

  return {
    circulationPolicyVersion: policy.circulationPolicyVersion,
    spatialPolicyVersion: policy.spatialPolicyVersion,
    sceneSpecVersion: analysis.sceneSpecVersion,
    projectId: analysis.projectId,
    sceneId: analysis.sceneId,
    revisionId: analysis.revisionId,
    // An invalid 9A source fails closed even when no requirement is declared.
    status:
      analysis.spatialValidationStatus === "PASS" &&
      results.every((result) => result.status === "SATISFIED")
        ? "PASS"
        : "FAILED",
    requirements: results,
    analysis,
  };
}
