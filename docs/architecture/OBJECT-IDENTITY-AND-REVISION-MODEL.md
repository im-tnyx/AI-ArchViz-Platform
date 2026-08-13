# Object Identity & Revision Model

**Status:** Architecture Draft  
**Version:** `0.1.0`  
**Project:** AI ArchViz Platform  
**Purpose:** Define stable object identity, revision-safe scene changes, locking, replacement, deletion, restoration, and auditability across SceneSpec, 3ds Max, renderers, and future DCC integrations.

---

## 1. Why This Document Exists

Professional ArchViz production is revision-heavy.

Typical requests include:

- replace the main sofa
- change only the TV wall material
- move a pendant light 250 mm
- keep the approved ceiling unchanged
- restore the previous coffee table
- change one camera without rebuilding the room
- update a window after a revised elevation arrives
- compare two design options
- revert a failed revision

These operations are only safe if every important scene object has a persistent logical identity that survives rebuilds, DCC reloads, asset replacement, and rendering.

The platform must never rely only on:

- 3ds Max node names
- array indexes
- object order
- AI-generated natural-language descriptions
- temporary UUIDs created by a DCC session
- asset file names

The system therefore separates **logical object identity** from **implementation identity**.

---

## 2. Core Principle

> A scene object is identified by what it represents in the project, not by how a specific DCC application happens to name or store it.

Canonical relationship:

```text
Project Object Identity
        ↓
SceneSpec Object
        ↓
DCC Mapping
        ↓
3ds Max Node / Group / Layer
        ↓
Renderer Objects
```

A DCC node may be recreated while the project object identity remains unchanged.

---

## 3. Identity Layers

The platform uses several identity layers.

### 3.1 Project ID

Stable identity for the complete client/project workspace.

Example:

```text
project_apartment_001
```

### 3.2 Scene ID

Stable identity for one scene or design branch.

Example:

```text
scene_livingroom_main
```

### 3.3 Logical Object ID

Permanent semantic identity for an object in the project.

Examples:

```text
wall_living_north
opening_living_window_w01
asset_living_sofa_main
asset_living_coffee_table_main
light_living_pendant_01
camera_living_hero_01
material_tv_wall_primary
```

Logical IDs are the primary revision target.

### 3.4 Asset Definition ID

Identity of a reusable library asset definition.

Example:

```text
assetdef_sofa_000124
```

This identifies the reusable model, not the placed instance.

### 3.5 Asset Instance ID

The logical object ID of a placed asset instance.

Example:

```text
asset_living_sofa_main
```

The same asset definition may be instantiated multiple times:

```text
asset_lounge_chair_01
asset_lounge_chair_02
```

### 3.6 DCC Runtime ID

Implementation-specific mapping used by 3ds Max or another DCC.

Example:

```json
{
  "dcc": "3ds_max",
  "nodeHandle": "0x00003F12",
  "nodeName": "AAV_asset_living_sofa_main"
}
```

This mapping is replaceable and must never become the canonical project identity.

---

## 4. ID Format

Logical IDs should be:

- stable
- readable
- lowercase
- ASCII
- deterministic where practical
- unique inside a project
- independent of display labels

Recommended pattern:

```text
<kind>_<space>_<role>[_<index>]
```

Examples:

```text
wall_living_north
opening_bedroom_window_01
asset_living_sofa_main
light_dining_pendant_03
camera_living_hero_01
material_kitchen_countertop
```

IDs should not include mutable properties such as:

```text
beige_sofa
large_table
left_window
new_light
final_camera
```

because color, size, orientation, or approval state may change.

---

## 5. IDs Are Immutable

Once a logical object ID is accepted into project history, it should not be renamed during normal revision operations.

Example:

```text
asset_living_sofa_main
```

may change from:

```text
Asset Definition A
```

to:

```text
Asset Definition B
```

while keeping the same logical identity.

This means:

```text
Object role remains the same
Asset implementation changes
```

A rename is an administrative migration, not a normal design revision.

---

## 6. Identity vs Asset Replacement

Asset replacement must not create a new logical object unless the project meaning changes.

Example:

```text
Before
asset_living_sofa_main
  → assetdef_sofa_000124

After
asset_living_sofa_main
  → assetdef_sofa_000812
```

The logical object remains:

```text
asset_living_sofa_main
```

This preserves:

- revision history
- camera relationships
- user comments
- approval state where applicable
- placement constraints
- downstream references

---

## 7. When a New Logical ID Is Required

Create a new logical ID when the semantic role is genuinely new.

Examples:

- adding a second side table
- introducing a new wall niche
- creating another pendant
- splitting one wall into independently controlled architectural elements
- adding a second design object that did not previously exist

Do not reuse an unrelated deleted ID for a different semantic object.

---

## 8. Object Record

A canonical object record may include:

```json
{
  "id": "asset_living_sofa_main",
  "kind": "asset_instance",
  "spaceId": "space_living",
  "role": "primary_seating",
  "assetDefinitionId": "assetdef_sofa_000124",
  "lifecycle": {
    "state": "active",
    "createdRevisionId": "rev_000012",
    "deletedRevisionId": null
  },
  "approval": {
    "state": "approved",
    "approvedRevisionId": "rev_000018"
  },
  "locks": [],
  "transform": {},
  "metadata": {}
}
```

---

## 9. Object Lifecycle States

Recommended lifecycle states:

```text
proposed
active
inactive
deleted
archived
```

### proposed

Exists in a pending SceneChangeSet but has not entered approved scene truth.

### active

Participates in the current scene.

### inactive

Temporarily excluded from current output but retained for alternatives or comparison.

### deleted

Removed from current scene by an explicit revision while historical identity remains preserved.

### archived

No longer part of active production, but preserved for long-term history or migrated projects.

---

## 10. Soft Delete by Default

Normal revision deletion should be a soft delete.

Example:

```json
{
  "id": "asset_living_coffee_table_main",
  "lifecycle": {
    "state": "deleted",
    "deletedRevisionId": "rev_000031"
  }
}
```

The historical record remains available.

Benefits:

- undo
- audit history
- restore
- branch comparison
- client revision traceability

Hard deletion should only be used for administrative cleanup or data-retention requirements.

---

## 11. Object Restoration

A deleted object may be restored with the same logical ID if it is the same historical project object.

Example:

```text
DeleteObject(asset_living_coffee_table_main)

later

RestoreObject(asset_living_coffee_table_main)
```

Restoration must validate whether its previous transform, asset definition, constraints, and materials are still compatible with the current scene.

---

## 12. Parent / Child Identity

Some objects contain logical children.

Examples:

```text
wardrobe
  ├── carcass
  ├── shutters
  ├── handles
  └── internal_lighting
```

or:

```text
tv_wall
  ├── backing_panel
  ├── stone_panel
  ├── shelves
  └── led_cove
```

Parent-child relationships should be explicit:

```json
{
  "id": "asset_tv_wall_main",
  "children": [
    "component_tv_wall_stone",
    "component_tv_wall_shelf_01",
    "light_tv_wall_cove_01"
  ]
}
```

A child may be independently revisionable only if the schema declares it as an addressable logical object.

---

## 13. Object Granularity Rule

Do not assign project-level IDs to every low-level mesh node.

Identity granularity should match meaningful revision boundaries.

Good logical objects:

- wall
- opening
- sofa
- table
- pendant
- camera
- material assignment
- joinery component that may be revised independently

Usually not independent logical objects:

- every polygon
- every modifier
- every internal mesh element
- every texture bitmap node

Low-level DCC details may exist under implementation metadata.

---

## 14. Approval States

Recommended approval states:

```text
draft
review
approved
rejected
superseded
```

Approval and lifecycle are separate.

An object may be:

```text
active + draft
active + approved
deleted + previously approved
```

---

## 15. Locking Model

Locks protect approved or sensitive scene data from accidental modification.

Three lock levels are recommended.

### 15.1 Object Lock

Prevents all normal modifications.

```json
{
  "scope": "object",
  "objectId": "wall_living_north"
}
```

### 15.2 Property Lock

Protects specific fields.

Example:

```json
{
  "scope": "property",
  "objectId": "opening_living_window_w01",
  "paths": [
    "geometry.width",
    "geometry.height",
    "transform.position"
  ]
}
```

### 15.3 Domain Lock

Protects a category of behavior.

Examples:

```text
geometry
transform
material
asset_definition
lighting_parameters
camera_transform
```

---

## 16. Lock Ownership

A lock should record:

```json
{
  "id": "lock_00091",
  "objectId": "wall_living_north",
  "scope": "domain",
  "domain": "geometry",
  "reason": "approved architectural dimension",
  "source": "user_approval",
  "createdRevisionId": "rev_000020"
}
```

AI must not remove or bypass a lock.

Unlocking requires an explicit authorized SceneChangeSet operation.

---

## 17. Revision Definition

A revision is an immutable record of accepted project changes.

Example:

```json
{
  "revisionId": "rev_000032",
  "parentRevisionId": "rev_000031",
  "createdAt": "2026-08-13T08:10:00Z",
  "actor": {
    "type": "user",
    "id": "user_owner"
  },
  "reason": "Replace living room sofa",
  "changeSetId": "changeset_000044",
  "status": "committed"
}
```

Revision records are append-only.

---

## 18. Revision States

Recommended states:

```text
draft
validating
approved
committing
committed
failed
rolled_back
superseded
```

A failed revision must not partially become canonical scene truth.

---

## 19. Transactional Revision Rule

A SceneChangeSet should be applied transactionally.

```text
Current Revision
      ↓
Create Candidate State
      ↓
Validate
      ↓
Dry Run
      ↓
Execute in DCC
      ↓
Verify
      ↓
Commit New Revision
```

If execution or verification fails:

```text
Rollback
```

The previous committed revision remains the production state.

---

## 20. Revision Snapshot Strategy

The platform should support both:

- immutable change history
- reconstructable scene state

Recommended long-term pattern:

```text
Periodic Snapshot
+
Ordered ChangeSets
```

This avoids storing a complete duplicate of every large scene while still allowing efficient recovery.

For early MVP development, complete SceneSpec snapshots per committed revision are acceptable and simpler.

---

## 21. Property-Level Change Tracking

A revision should capture the exact changed paths.

Example:

```json
{
  "objectId": "asset_living_sofa_main",
  "changes": [
    {
      "path": "assetDefinitionId",
      "before": "assetdef_sofa_000124",
      "after": "assetdef_sofa_000812"
    }
  ]
}
```

This enables:

- clear diff views
- targeted validation
- affected-render calculation
- property-level locks
- conflict detection

---

## 22. Object Replacement Semantics

`ReplaceAsset` changes implementation while preserving logical identity.

Required validation:

```text
Logical object exists
Replacement asset exists
Category is compatible
Dimensions are allowed
Pivot convention is compatible
Renderer support exists
Placement constraints still pass
Locked properties are respected
```

The replacement may preserve:

```text
transform
semantic role
comments
relationships
camera references
revision identity
```

unless explicitly overridden.

---

## 23. Geometry Replacement Semantics

Architectural geometry changes are higher risk than furniture changes.

Example:

```text
wall_living_north
```

If its geometry changes after a revised elevation or plan arrives, the logical ID may stay the same if it still represents the same physical wall.

The revision must trigger dependency analysis for:

- openings
- attached furniture
- materials
- wall-mounted lights
- cameras
- ceiling relationships
- render invalidation

---

## 24. Object Dependencies

Objects may reference each other through explicit relationships.

Examples:

```text
window attached_to wall
pendant attached_to ceiling
sofa belongs_to space
camera targets focal_object
material assigned_to wall
side_table related_to sofa
```

Example:

```json
{
  "relationships": [
    {
      "type": "attached_to",
      "from": "opening_living_window_w01",
      "to": "wall_living_north"
    }
  ]
}
```

Dependency graphs are used for impact analysis.

---

## 25. Revision Impact Analysis

Before applying a change, the platform should identify affected objects.

Example:

```text
Change wall_living_north geometry
        ↓
opening_living_window_w01
material_living_north_wall
light_wall_washer_01
asset_console_main
camera_living_hero_01
render_hero_01
```

Affected objects may require:

- revalidation
- transform adjustment
- remeshing
- material recompilation
- camera re-check
- re-rendering

---

## 26. Render Invalidation

Not every revision requires every render to be regenerated.

Example:

```text
Change sofa material
```

Only cameras that can see the sofa require invalidation.

Future render invalidation may use:

- object visibility maps
- camera frustum tests
- semantic dependencies
- render-element object IDs

Initial MVP may use conservative invalidation by room/scene.

---

## 27. Branching

Future projects may need design alternatives.

Example:

```text
main
  ├── option_a
  └── option_b
```

Each branch references a base revision.

```json
{
  "branchId": "branch_option_b",
  "baseRevisionId": "rev_000040",
  "headRevisionId": "rev_000047"
}
```

Branching must preserve logical IDs for objects inherited from the base.

New objects receive new IDs.

---

## 28. Merge Strategy

Automatic merge is allowed only when change scopes do not conflict.

Safe example:

```text
Branch A changes camera_hero_01
Branch B changes material_floor_main
```

Potential conflict:

```text
Branch A changes asset_living_sofa_main.assetDefinitionId
Branch B changes the same property
```

Conflicts require explicit resolution.

AI may suggest a resolution but cannot silently merge conflicting approved properties.

---

## 29. Undo vs Revert

Production history should prefer `revert` over destructive history rewriting.

Example:

```text
rev_41  replace sofa
rev_42  change table
rev_43  revert sofa replacement
```

The original revisions remain auditable.

---

## 30. DCC Mapping

SceneSpec logical IDs must be stored in DCC metadata when possible.

Recommended 3ds Max node metadata:

```text
AIArchViz.LogicalObjectId
AIArchViz.SceneId
AIArchViz.AssetDefinitionId
AIArchViz.RevisionId
```

Node names should also include a readable form where practical:

```text
AAV_asset_living_sofa_main
```

But metadata remains more reliable than the visible node name.

---

## 31. DCC Reconciliation

The local worker must be able to reconcile SceneSpec against an existing 3ds Max scene.

Possible states:

```text
SceneSpec object exists + DCC node exists
→ update / verify

SceneSpec object exists + DCC node missing
→ recreate if safe

SceneSpec object deleted + DCC node exists
→ remove / disable according to lifecycle

Unknown DCC node exists
→ classify as unmanaged or import candidate
```

The worker must never assume every node in the `.max` file is platform-managed.

---

## 32. Managed vs Unmanaged Objects

3ds Max scenes may contain manually created objects.

Each node should conceptually be classified as:

```text
managed
unmanaged
adopted
ignored
```

### managed

Fully controlled by SceneSpec.

### unmanaged

Exists in the DCC but is not controlled by the platform.

### adopted

Originally manual, later assigned a logical SceneSpec ID.

### ignored

Explicitly excluded from reconciliation.

---

## 33. Adoption Workflow

A manually created 3ds Max object may be adopted.

```text
Select DCC Node
      ↓
Inspect Geometry / Metadata
      ↓
Assign Logical Role
      ↓
Create SceneSpec Object
      ↓
Assign Stable ID
      ↓
Record Adoption Revision
```

This allows mixed manual + automated workflows.

---

## 34. Conflict Detection

Conflicts should be detected when:

- two revisions edit the same locked property
- an object was deleted while another operation modifies it
- an asset replacement invalidates required relationships
- a new elevation contradicts approved geometry
- a manual DCC edit differs from SceneSpec
- a branch merge modifies the same semantic property

Conflict states should be explicit, not silently resolved.

---

## 35. AI Boundaries

AI may:

- identify revision intent
- resolve which logical object the user likely means
- propose replacement assets
- propose SceneChangeSet operations
- explain conflicts
- rank merge options

AI must not directly:

- invent a new ID for an existing object without reconciliation
- bypass locks
- overwrite approved properties
- delete history
- mutate DCC nodes outside a validated SceneChangeSet
- silently resolve ambiguous object identity

Canonical flow:

```text
User Request
    ↓
AI Intent Interpretation
    ↓
Resolve Logical Object(s)
    ↓
Proposed SceneChangeSet
    ↓
Identity Validation
    ↓
Lock Validation
    ↓
Domain / Spatial Validation
    ↓
Execute
```

---

## 36. Ambiguous User References

Users may say:

```text
change that sofa
move the left light
make the TV panel darker
```

The system should resolve natural-language references to logical IDs using:

- current room
- active camera
- object category
- visible objects
- semantic role
- previous interaction context
- user selection in UI

If multiple high-risk targets remain plausible, the operation should not execute automatically.

---

## 37. Revision Risk Levels

Suggested risk categories:

### Low

- camera exposure
- decorative material parameter
- movable decor asset replacement

### Medium

- furniture replacement
- furniture transform
- light placement
- joinery material change

### High

- wall geometry
- openings
- ceiling geometry
- verified dimensions
- approved architectural elements
- bulk deletion

Risk level influences validation and approval requirements.

---

## 38. Revision Audit Trail

Every committed revision should eventually record:

```text
who
when
why
what changed
which evidence caused it
which AI model proposed it, if any
which validator approved it
which worker executed it
which renders were invalidated
whether verification passed
```

This makes production issues traceable.

---

## 39. Example: Sofa Replacement

User request:

```text
Replace the main sofa with the selected curved sofa.
```

Resolution:

```text
Target logical ID
asset_living_sofa_main
```

Proposed operation:

```json
{
  "operation": "ReplaceAsset",
  "objectId": "asset_living_sofa_main",
  "newAssetDefinitionId": "assetdef_sofa_000812",
  "preserve": [
    "logicalIdentity",
    "position",
    "rotation",
    "semanticRole"
  ]
}
```

Validation:

```text
category compatible
size fits room
clearance valid
no collision
no locks violated
renderer compatible
```

Result:

```text
Same logical object
New asset definition
New committed revision
Affected renders invalidated
```

---

## 40. Example: Revised Window Elevation

Existing:

```text
opening_living_window_w01
height = inferred 2100 mm
```

New elevation provides:

```text
verified height = 2250 mm
```

The logical ID remains unchanged.

Revision changes:

```text
geometry.height
provenance
confidence
authority
```

Dependent validation runs for:

- parent wall
- curtain asset
- ceiling clearance
- nearby lights
- cameras

The object is updated, not recreated as an unrelated window.

---

## 41. Example: Approved Ceiling Lock

Ceiling is client-approved.

```json
{
  "objectId": "ceiling_living_main",
  "locks": [
    {
      "scope": "domain",
      "domain": "geometry",
      "reason": "client approved"
    }
  ]
}
```

AI proposes a new ceiling profile from a reference image.

Expected result:

```text
Proposal rejected or requires explicit unlock
```

No automatic geometry mutation occurs.

---

## 42. Persistence Model

A future database may use conceptual entities such as:

```text
projects
scenes
branches
revisions
objects
object_versions
relationships
locks
changesets
render_invalidations
dcc_mappings
```

Exact database implementation is deferred until domain behavior is proven.

---

## 43. SceneSpec Integration

SceneSpec must include or reference:

```text
logical object IDs
lifecycle state
asset definition IDs
relationships
locks
approval state
revision metadata
DCC mappings where appropriate
```

SceneSpec snapshots must never lose identity history when an object implementation changes.

---

## 44. Validation Requirements

Before committing an identity-affecting change, validators should verify:

- ID uniqueness
- referenced object existence
- valid lifecycle transition
- valid parent/child relationships
- lock compliance
- valid asset category for replacement
- no references to hard-deleted identities
- branch consistency
- DCC mapping consistency where execution is involved

---

## 45. Test Requirements

Minimum automated tests should eventually cover:

```text
ID uniqueness
ID stability across rebuild
asset replacement preserves logical ID
soft delete
restore
property lock enforcement
object lock enforcement
DCC node recreation
manual object adoption
revision rollback
branch inheritance
merge conflict detection
relationship integrity
render invalidation
```

---

## 46. MVP Scope

For the first implementation, keep revision storage simple.

MVP should support:

```text
stable logical IDs
SceneSpec snapshot per revision
active / deleted lifecycle
ReplaceAsset
MoveObject
UpdateMaterial
UpdateGeometry
object locks
property locks
basic revision log
rollback to previous SceneSpec snapshot
3ds Max logical-ID metadata
```

Branch merging and advanced snapshot compression can come later.

---

## 47. Non-Goals for v0.1

This document does not yet define:

- exact database schema
- collaborative multi-user conflict resolution
- CRDT behavior
- cloud synchronization protocol
- binary `.max` diffing
- renderer-native object history

Those are future implementation concerns.

---

## 48. Final Rule

> If the platform cannot identify exactly which logical object a revision targets, it must not perform a destructive production change.

Object identity is the foundation of revision safety.

AI may interpret intent, but SceneSpec identity, locks, validation, and transactional revision rules determine what is allowed to change.
