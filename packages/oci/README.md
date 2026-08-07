# @beambox/oci

OCI image primitives: content-addressed blobs, deterministic layer tars, manifests, and
the three archive formats. No Docker, no daemon, no native dependencies.

```bash
bun add @beambox/oci
```

## Building a layer

Layers are built from a list of entries and streamed into a content-addressed store, so a
multi-gigabyte layer never lands in memory.

```ts
import { BlobStore, buildLayer } from "@beambox/oci"

const store = new BlobStore("./cache/blobs")

const layer = await buildLayer(store, [
  { kind: "file", path: "/app/index.js", content: new TextEncoder().encode("console.log(1)") },
  { kind: "file", path: "/app/big.bin", content: { file: "./big.bin", size: 1_048_576 } },
  { kind: "directory", path: "/app/data", mode: 0o755 },
  { kind: "symlink", path: "/app/latest", target: "index.js" },
  { kind: "whiteout", path: "/etc/motd" },   // records a deletion
  { kind: "opaque", path: "/var/cache" },    // hides everything below, from lower layers
])

console.log(layer.digest)   // sha256:… of the compressed blob (what a manifest references)
console.log(layer.diffId)   // sha256:… of the uncompressed tar (what rootfs.diff_ids uses)
```

Both digests are computed in a single streaming pass.

### Reproducibility

Output does not depend on the order entries were discovered in, or on anything about the
machine. Entries are sorted by path, parent directories are synthesised, and `mtime`,
`uid`, `gid`, `uname`, and `gname` are pinned. The same content always produces the same
digest:

```ts
const a = await buildLayer(store, [fileB, fileA])
const b = await buildLayer(store, [fileA, fileB])
a.digest === b.digest // true
```

## Assembling an image

```ts
import { assembleImage, emptyImageConfig } from "@beambox/oci"

const image = await assembleImage(store, {
  config: {
    ...emptyImageConfig({ os: "linux", architecture: "arm64" }),
    config: { Cmd: ["node", "/app/index.js"], Env: ["NODE_ENV=production"], WorkingDir: "/app" },
  },
  layers: [layer],
})
```

`rootfs.diff_ids` is always rewritten from the layer list rather than trusted from the
incoming config — a config whose diff IDs disagree with its layers produces an image that
fails to unpack.

## Writing archives

```ts
import { writeArchive, writeLayoutDirectory } from "@beambox/oci"

await writeArchive(image, "app.tar", { tags: ["app:local"] })                  // docker save
await writeArchive(image, "app.oci.tar", { tags: ["app:local"], format: "oci" }) // OCI layout
await writeLayoutDirectory(image, "./out/oci", { tags: ["app:local"] })        // unpacked
```

`msb load`, `docker load`, `podman load`, and `skopeo` all accept these. The docker form
stores layers uncompressed, as that format requires, so gzip layers are inflated on the
way in; the OCI form keeps them compressed and is therefore cheaper to produce.

## Preserving bytes

Parsing and re-encoding JSON is not byte-preserving, so an image that came from a registry
must keep its original manifest and config bytes or its digest silently changes. Use
`imageFromDocuments` for that, and `assembleImage` when the config genuinely changed and a
new digest is the correct outcome.

```ts
import { imageFromDocuments } from "@beambox/oci"

// Pull, then push elsewhere unmodified — same digest on both ends.
const image = await imageFromDocuments(store, {
  manifestBytes, manifestMediaType, manifest, configBytes, config, layers,
})
```

## References

```ts
import { parseReference, toRepoTag } from "@beambox/oci"

parseReference("python")                     // registry-1.docker.io, library/python, latest
parseReference("ghcr.io/me/app:v1")          // ghcr.io, me/app, v1
parseReference("localhost:5050/app:v1")      // port, not a tag
parseReference("alpine@sha256:…")            // digest, no tag

toRepoTag(parseReference("python:3.12"))     // "python:3.12"
```

## Validation

Everything crossing a trust boundary is parsed through a zod schema rather than cast, and
failures name the document and the field:

```ts
import { ManifestSchema, parseJson } from "@beambox/oci"

const manifest = parseJson(ManifestSchema, bytes, "manifest for alpine:3.20")
// ManifestError: manifest for alpine:3.20 does not match the OCI schema:
//   layers.0.size: expected number
```
