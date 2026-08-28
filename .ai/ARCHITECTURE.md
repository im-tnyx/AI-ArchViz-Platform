# Architecture Guardrails

1. A saved, editable real 3D scene is production truth; generated images are
   never a replacement for scene state.
2. Revisions are deterministic SceneChangeSet transitions against an existing
   verified SceneSpec and `.max` checkpoint.
3. `SceneSpec` is the single contract between input understanding, planning,
   geometry, assets, materials, worker automation, and DCC verification.
4. Explicit dimensions, CAD geometry, and other human-verifiable evidence take
   priority over AI inference.
5. AI providers must remain behind replaceable adapters. DCC and renderer
   implementations must also remain adapter-based.
6. A candidate scene is promoted only after an independent fresh DCC process
   reopens it and verifies the complete semantic manifest.

Current deterministic spine:

```text
SceneSpec → local Windows worker → trusted DCC plan → candidate .max
→ fresh-process semantic manifest verification → verified editable scene
```

Do not jump directly to AI image generation, external asset loading, or
renderer-specific scene logic without an explicitly authorized contract and
spike.
