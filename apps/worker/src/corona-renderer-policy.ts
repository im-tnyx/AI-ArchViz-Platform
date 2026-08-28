export const coronaCanonicalIntensityScale = 120;
export const coronaCanonicalAreaLightWidthMm = 800;

export function isSupportedCanonicalCoronaLightType(lightType: string): lightType is "area" {
  return lightType === "area";
}

export function sortCanonicalCoronaLights<T extends { id: string }>(lights: readonly T[]): T[] {
  return [...lights].sort((left, right) => left.id.localeCompare(right.id));
}
