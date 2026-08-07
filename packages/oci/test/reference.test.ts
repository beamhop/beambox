import { describe, expect, test } from "bun:test"
import { InvalidReferenceError } from "../src/errors.ts"
import {
  DOCKER_HUB_REGISTRY,
  parseReference,
  referenceSelector,
  toRepoTag,
} from "../src/reference.ts"

describe("parseReference", () => {
  test("expands a bare name to a Docker Hub library image", () => {
    expect(parseReference("python")).toMatchObject({
      registry: DOCKER_HUB_REGISTRY,
      repository: "library/python",
      tag: "latest",
    })
  })

  test("keeps a user namespace on Docker Hub", () => {
    expect(parseReference("oven/bun:slim")).toMatchObject({
      registry: DOCKER_HUB_REGISTRY,
      repository: "oven/bun",
      tag: "slim",
    })
  })

  test("treats a dotted first segment as a registry host", () => {
    expect(parseReference("ghcr.io/vercel/eve:latest")).toMatchObject({
      registry: "ghcr.io",
      repository: "vercel/eve",
      tag: "latest",
    })
  })

  test("distinguishes a registry port from a tag", () => {
    expect(parseReference("localhost:5050/my-app:v1")).toMatchObject({
      registry: "localhost:5050",
      repository: "my-app",
      tag: "v1",
    })
  })

  test("normalises the docker.io aliases", () => {
    expect(parseReference("docker.io/library/alpine").registry).toBe(DOCKER_HUB_REGISTRY)
    expect(parseReference("index.docker.io/library/alpine").registry).toBe(DOCKER_HUB_REGISTRY)
  })

  test("parses digest references and leaves the tag unset", () => {
    const digest = `sha256:${"a".repeat(64)}`
    const reference = parseReference(`alpine@${digest}`)
    expect(reference.digest).toBe(digest as `sha256:${string}`)
    expect(reference.tag).toBeUndefined()
  })

  test("rejects malformed input rather than guessing", () => {
    expect(() => parseReference("")).toThrow(InvalidReferenceError)
    expect(() => parseReference("alpine@sha256:nope")).toThrow(InvalidReferenceError)
    expect(() => parseReference("alpine:")).toThrow(InvalidReferenceError)
  })
})

describe("toRepoTag", () => {
  test("drops the implicit library namespace and hub host", () => {
    expect(toRepoTag(parseReference("python:3.12"))).toBe("python:3.12")
    expect(toRepoTag(parseReference("oven/bun:slim"))).toBe("oven/bun:slim")
  })

  test("keeps an explicit registry host", () => {
    expect(toRepoTag(parseReference("ghcr.io/me/app:v1"))).toBe("ghcr.io/me/app:v1")
  })

  test("is undefined for a digest-only reference", () => {
    expect(toRepoTag(parseReference(`alpine@sha256:${"b".repeat(64)}`))).toBeUndefined()
  })
})

describe("referenceSelector", () => {
  test("prefers a digest over a tag", () => {
    const digest = `sha256:${"c".repeat(64)}`
    expect(referenceSelector(parseReference(`alpine:3.20@${digest}`))).toBe(digest)
    expect(referenceSelector(parseReference("alpine:3.20"))).toBe("3.20")
  })
})
