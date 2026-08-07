# @beambox/registry

A pure-TypeScript OCI Distribution v2 client. Pull and push images from Docker Hub, GHCR,
ECR, GCR, or any conformant registry — with no Docker daemon involved.

```bash
bun add @beambox/registry
```

## Pulling

```ts
import { BlobStore, parseReference } from "@beambox/oci"
import { hostPlatform, pullImage } from "@beambox/registry"

const store = new BlobStore("./cache/blobs")

const image = await pullImage(store, parseReference("alpine:3.20"), {
  platform: hostPlatform(),
  onProgress: ({ index, total, cached }) =>
    console.log(`layer ${index + 1}/${total} ${cached ? "cached" : "downloaded"}`),
})

console.log(image.config.config?.Cmd)   // [ "/bin/sh" ]
console.log(image.layers.length)
```

Multi-platform references are resolved through their index, and BuildKit's SBOM and
provenance manifests are skipped rather than mistaken for images.

Every downloaded blob is verified against the digest that referenced it before it is
committed, and layers already in the store are not downloaded again — which is what makes
a second build on the same base nearly free.

Diff IDs are recomputed from the bytes rather than trusted from the config, so a
disagreement surfaces at pull time instead of producing an image that fails to unpack.

## Pushing

```ts
import { pushImage } from "@beambox/registry"

const digest = await pushImage(image, parseReference("ghcr.io/me/app:v1"), {
  auth: { kind: "basic", username: "me", password: process.env.GITHUB_TOKEN ?? "" },
  onProgress: (event) => console.log(event.what, event.skipped ? "(already present)" : "uploaded"),
})
```

Blobs go up before the manifest that references them, as the spec requires, and blobs the
registry already holds are skipped after a cheap `HEAD` — so re-pushing an image whose base
layers are already there transfers only what changed.

## Authentication

Credentials are resolved in this order: explicit `auth`, then `~/.docker/config.json`.
Anonymous pulls work without either — Docker Hub still issues a token, and the client
handles that challenge automatically.

```ts
// Explicit
{ auth: { kind: "basic", username: "deploy", password: process.env.TOKEN ?? "" } }
{ auth: { kind: "bearer", token: process.env.TOKEN ?? "" } }

// Skip the Docker config entirely
{ useDockerCredentials: false }
```

Tokens are cached per scope, so pulling twenty layers from one repository costs one token
exchange.

## Local and internal registries

```ts
// Plain HTTP, e.g. a local `registry:2` on port 5050
await pullImage(store, parseReference("localhost:5050/app:v1"), { insecure: true })

// An internal CA
await pullImage(store, parseReference("registry.corp.io/team/app:v1"), {
  caCerts: "/etc/ssl/corporate-ca.pem",
})
```

## Errors

`RegistryAuthError` says whether credentials were even available. `PlatformNotFoundError`
lists the platforms that *are* published. `ForeignLayerError` refuses non-distributable
layers rather than producing an image whose layers cannot be fetched. `RegistryRequestError`
carries the status and response body.

```ts
import { PlatformNotFoundError } from "@beambox/registry"

try {
  await pullImage(store, parseReference("some/image"), {
    platform: { os: "linux", architecture: "riscv64" },
  })
} catch (error) {
  if (error instanceof PlatformNotFoundError) console.log(error.available)
  // [ "linux/amd64", "linux/arm64" ]
}
```

## Lower-level access

`RegistryClient` exposes the raw API when you need it — `getManifest`, `blobStream`,
`blobExists`, `putBlob`, `putManifest` — with auth handled for you.

```ts
import { RegistryClient } from "@beambox/registry"

const client = new RegistryClient("ghcr.io")
const { bytes, mediaType, digest } = await client.getManifest("me/app", "v1")
```
