export {
  distance,
  isOnBoundary,
  isStrictlyInside,
  polygonDefect,
  polygonsOverlap,
  projectOntoSegment,
  type SegmentProjection,
  signedArea,
} from "./geometry.js";
export {
  buildOpeningCandidate,
  type CadSpaceWallStage,
  deriveSpaceWallStage,
  findOpeningHosts,
  interpretCadDocument,
  type OpeningHost,
  type OpeningSource,
  openingCenter,
  resolveOpeningRule,
  semanticHash,
} from "./interpret.js";
export {
  architecturalExtractionSchema,
  cadInterpretationProfileSchema,
  type InterpretationContractError,
  type InterpretationValidationResult,
  validateArchitecturalExtraction,
  validateCadInterpretationProfile,
} from "./profile.js";
export * from "./types.js";
