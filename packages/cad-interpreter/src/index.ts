export {
  distance,
  isOnBoundary,
  isStrictlyInside,
  polygonDefect,
  polygonsOverlap,
  projectOntoSegment,
  signedArea,
} from "./geometry.js";
export { interpretCadDocument, semanticHash } from "./interpret.js";
export {
  architecturalExtractionSchema,
  cadInterpretationProfileSchema,
  type InterpretationContractError,
  type InterpretationValidationResult,
  validateArchitecturalExtraction,
  validateCadInterpretationProfile,
} from "./profile.js";
export * from "./types.js";
