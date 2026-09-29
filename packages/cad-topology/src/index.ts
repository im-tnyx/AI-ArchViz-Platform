export {
  analyzeArchitecturalTopology,
  type DetectedSharedBoundary,
  detectSharedBoundaries,
} from "./analyze.js";
export { type CollinearOverlap, collinearOverlap, comparePoints } from "./geometry.js";
export * from "./types.js";
export {
  architecturalTopologySchema,
  type TopologyContractError,
  type TopologyValidationResult,
  validateArchitecturalTopology,
} from "./validate.js";
