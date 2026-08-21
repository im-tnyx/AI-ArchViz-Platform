# Renderer Execution Boundary

## Scope

Technical Spike 8A establishes a narrow, local Corona capability proof. It is
not a `RendererAdapter` implementation and does not alter SceneSpec material,
light, camera, revision, asset, CAD, AI, V-Ray, or final-quality rendering
contracts.

```text
repository-controlled render job
  -> fresh Safe-Scene 3ds Max Batch process
  -> runtime Corona discovery
  -> fixed local fixture and finite Corona render
  -> worker-controlled PNG validation
  -> portable normalized evidence
```

## Runtime discovery and no fallback

- The worker enumerates `RendererClass.classes`; it never relies on an array
  index or a configured DLL path.
- Corona candidates are selected from normalized runtime class metadata. A
  missing candidate yields `CORONA_NOT_FOUND`; more than one candidate yields
  `CORONA_RENDERER_AMBIGUOUS` rather than an arbitrary first match.
- The selected class is assigned to both `renderers.current` and
  `renderers.production`. Any post-assignment non-Corona identity is failure.
- Corona version is included only when the installed renderer exposes a
  reliable scalar version property. `null` means not observable from the
  supported runtime surface; it is not a guessed version.
- A Corona request never falls back to Scanline, Arnold, or V-Ray.

## Narrow baseline fixture

The 8A fixture is created procedurally in the fresh process using millimeters:

- floor box, back-wall box, and one subject box;
- exactly one discovered `CoronaPhysicalMtl`, assigned to the subject;
- neutral warm matte intent: RGB `[0.72, 0.62, 0.50]`, roughness `0.45`,
  non-metal mode;
- one discovered `CoronaLight` with fixed transform/controls. If an installed
  compatibility release cannot expose a stable configurable `CoronaLight`, the
  runner records an explicit `stock_omni` strategy rather than misrepresenting
  it as a Corona light;
- one native `FreeCamera` at a fixed transform with a 35 mm focal length
  (converted to the native camera FOV using a fixed 36 mm sensor width).

No external textures, maps, XRefs, Cosmos assets, HDRIs, Sun/Sky, IES,
LightMix, denoiser dependency, distributed rendering, network lookup, or
saved `.max` artifact is part of this fixture.

## Fixed render policy

`render-job-v0.1` accepts only this capability job:

```json
{
  "renderJobVersion": "0.1.0",
  "engine": "corona",
  "cameraId": "camera_corona_baseline",
  "mode": "preview",
  "resolution": { "width": 320, "height": 240 }
}
```

The worker, not the job, fixes the Corona pass limit to `4`. The outer
worker-owned process timeout remains a second hard stop. The runner invokes a
normal production `render()` call with the camera, `320 × 240` dimensions,
worker-owned `baseline.png` output, and VFB disabled. Interactive rendering is
not used.

## Evidence and determinism

`render-evidence-v0.1` contains renderer identity/version when observable,
DCC product/version/compatibility mode, camera/material/light identity,
resolution, pass limit, PNG byte length, and SHA-256. It deliberately has no
machine-local output path.

Scene semantic determinism and render configuration determinism are strict.
PNG byte equality is not a cross-machine Golden oracle: CPU, Corona version,
and implementation differences can change pixels. A valid output must instead
have the exact PNG signature, `320 × 240` dimensions, and a non-zero byte
length.

## Security and licensing

- DCC test execution remains explicit-authorization only and uses fresh owned
  `3dsmaxbatch.exe` processes with Dialog Monitor and Safe Scene enabled.
- Safe Scene must be observable as enabled, command-line locked, and
  script-asset protected; it is never weakened for Corona.
- Jobs cannot carry renderer class overrides, scripts, plug-in paths,
  credential/license fields, or output paths.
- The runner performs no install, upgrade, activation, license-server change,
  distributed render action, download, Cosmos access, or plugin configuration
  mutation.
- License-shaped renderer failures map to `CORONA_LICENSE_UNAVAILABLE`; the
  runner never attempts repair.
- A timeout returns `PROCESS_TIMEOUT`, creates no PASS evidence, terminates
  only the owned process tree, and treats any partial PNG as invalid.

## Compatibility policy and next boundary

The production DCC target remains 3ds Max 2026. A successful 3ds Max 2025.x
run is reported only as compatibility evidence. Corona version policy remains
runtime-discovered; the repository does not pin a public release.

The next authorized task after a verified 8A pass is **Technical Spike 8B —
Corona Renderer Adapter + SceneSpec Material/Light Mapping**. It is not
implemented by this spike. V-Ray remains later work.
