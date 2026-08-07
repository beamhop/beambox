import { describe, expect, test } from "bun:test"
import { DockerfileParseError, UnsupportedInstructionError } from "../src/errors.ts"
import { lex, splitWords } from "../src/lexer.ts"
import { parseDockerfile } from "../src/parser.ts"

const ops = (text: string, stage = 0) => parseDockerfile(text).stages[stage]?.ops ?? []

describe("lexer", () => {
  test("joins line continuations into one instruction", () => {
    const { lines } = lex("RUN apt-get update \\\n  && apt-get install -y git\n")
    expect(lines).toHaveLength(1)
    expect(lines[0]?.args).toBe("apt-get update && apt-get install -y git")
  })

  test("drops comments, including inside a continuation", () => {
    const { lines } = lex("# leading\nRUN one \\\n# explanatory note\n  two\n")
    expect(lines).toHaveLength(1)
    expect(lines[0]?.args).toBe("one two")
  })

  test("honours a custom escape directive", () => {
    const { lines, escape: escapeChar } = lex("# escape=`\nRUN one `\n  two\n")
    expect(escapeChar).toBe("`")
    expect(lines[0]?.args).toBe("one two")
  })

  test("preserves whitespace inside quoted arguments", () => {
    expect(splitWords('COPY "my file.txt" /dest')).toEqual(["COPY", "my file.txt", "/dest"])
  })

  test("collects a heredoc body", () => {
    const { lines } = lex("RUN <<EOF\necho one\necho two\nEOF\n")
    expect(lines).toHaveLength(1)
    expect(lines[0]?.heredocs.get("EOF")).toBe("echo one\necho two")
  })

  test("reports an unterminated heredoc rather than reading to EOF", () => {
    expect(() => lex("RUN <<EOF\necho one\n")).toThrow(/never closed/)
  })

  test("tracks line numbers through continuations", () => {
    const { lines } = lex("FROM alpine\n\nRUN a \\\n  b\nUSER app\n")
    expect(lines.map((line) => line.line)).toEqual([1, 3, 5])
  })
})

describe("FROM", () => {
  test("parses a registry base, a name, and a platform", () => {
    const plan = parseDockerfile("FROM --platform=linux/amd64 node:22-slim AS builder\n")
    expect(plan.stages[0]).toMatchObject({
      name: "builder",
      base: { kind: "registry", reference: "node:22-slim" },
      platform: { os: "linux", architecture: "amd64" },
    })
  })

  test("recognises scratch", () => {
    expect(parseDockerfile("FROM scratch\n").stages[0]?.base).toEqual({ kind: "scratch" })
  })

  test("a bare name matching an earlier stage refers to that stage", () => {
    const plan = parseDockerfile("FROM alpine AS base\nRUN a\nFROM base\nRUN b\n")
    expect(plan.stages[1]?.base).toEqual({ kind: "stage", stage: "base" })
  })

  test("catches a missing AS keyword instead of guessing", () => {
    expect(() => parseDockerfile("FROM alpine builder\n")).toThrow(/did you mean "AS builder"/)
  })

  test("requires at least one FROM", () => {
    expect(() => parseDockerfile("# just a comment\n")).toThrow(/no FROM instruction/)
  })

  test("rejects instructions before the first FROM", () => {
    expect(() => parseDockerfile("RUN echo hi\nFROM alpine\n")).toThrow(/before any FROM/)
  })
})

describe("RUN", () => {
  test("keeps shell form verbatim", () => {
    expect(ops("FROM alpine\nRUN echo 'hello  world'\n")[0]).toEqual({
      kind: "run",
      command: { form: "shell", command: "echo 'hello  world'" },
    })
  })

  test("parses exec form as argv", () => {
    expect(ops('FROM alpine\nRUN ["/bin/echo", "hi"]\n')[0]).toEqual({
      kind: "run",
      command: { form: "exec", argv: ["/bin/echo", "hi"] },
    })
  })

  test("runs a heredoc body as the script", () => {
    const op = ops("FROM alpine\nRUN <<EOF\nset -e\necho hi\nEOF\n")[0]
    expect(op).toEqual({ kind: "run", command: { form: "shell", command: "set -e\necho hi" } })
  })

  test("parses a cache mount", () => {
    const op = ops("FROM alpine\nRUN --mount=type=cache,target=/root/.npm,id=npm npm ci\n")[0]
    expect(op).toMatchObject({
      kind: "run",
      command: { form: "shell", command: "npm ci" },
      mounts: [{ type: "cache", target: "/root/.npm", id: "npm" }],
    })
  })

  test("parses tmpfs and bind mounts", () => {
    const tmpfs = ops("FROM alpine\nRUN --mount=type=tmpfs,target=/scratch make\n")[0]
    expect(tmpfs).toMatchObject({ mounts: [{ type: "tmpfs", target: "/scratch" }] })

    const bind = ops("FROM alpine\nRUN --mount=type=bind,source=src,target=/src make\n")[0]
    expect(bind).toMatchObject({ mounts: [{ type: "bind", source: "src", target: "/src" }] })
  })

  test("refuses secret and ssh mounts by name", () => {
    expect(() =>
      parseDockerfile("FROM alpine\nRUN --mount=type=secret,id=tok,target=/t cat /t\n"),
    ).toThrow(UnsupportedInstructionError)
    expect(() => parseDockerfile("FROM alpine\nRUN --mount=type=ssh,target=/s git pull\n")).toThrow(
      /does not forward host secrets/,
    )
  })

  test("refuses --network and --security", () => {
    expect(() => parseDockerfile("FROM alpine\nRUN --network=none make\n")).toThrow(
      UnsupportedInstructionError,
    )
  })

  test("requires a mount target", () => {
    expect(() => parseDockerfile("FROM alpine\nRUN --mount=type=cache make\n")).toThrow(
      /needs a target/,
    )
  })
})

describe("COPY and ADD", () => {
  test("parses sources, destination, and flags", () => {
    expect(ops("FROM alpine\nCOPY --from=builder --chown=1000:1000 a b /dest/\n")[0]).toEqual({
      kind: "copy",
      sources: ["a", "b"],
      destination: "/dest/",
      from: "builder",
      chown: "1000:1000",
    })
  })

  test("parses ADD with chmod", () => {
    expect(ops("FROM alpine\nADD --chmod=755 run.sh /run.sh\n")[0]).toEqual({
      kind: "add",
      sources: ["run.sh"],
      destination: "/run.sh",
      chmod: "755",
    })
  })

  test("requires a source and a destination", () => {
    expect(() => parseDockerfile("FROM alpine\nCOPY only-one\n")).toThrow(DockerfileParseError)
  })

  test("names an unsupported flag rather than ignoring it", () => {
    expect(() => parseDockerfile("FROM alpine\nCOPY --chmod=755 --nope=1 a /b\n")).toThrow(
      /COPY --nope/,
    )
  })
})

describe("config instructions", () => {
  test("parses both ENV forms", () => {
    expect(ops("FROM alpine\nENV A=1 B=2\n")[0]).toEqual({
      kind: "env",
      values: { A: "1", B: "2" },
    })
    expect(ops("FROM alpine\nENV GREETING hello there\n")[0]).toEqual({
      kind: "env",
      values: { GREETING: "hello there" },
    })
  })

  test("LABEL requires key=value", () => {
    expect(() => parseDockerfile("FROM alpine\nLABEL just-a-key\n")).toThrow(/key=value/)
  })

  test("parses CMD and ENTRYPOINT in both forms", () => {
    expect(ops('FROM alpine\nCMD ["node", "x.js"]\n')[0]).toEqual({
      kind: "cmd",
      command: { form: "exec", argv: ["node", "x.js"] },
    })
    expect(ops("FROM alpine\nENTRYPOINT /entry --flag\n")[0]).toEqual({
      kind: "entrypoint",
      command: { form: "shell", command: "/entry --flag" },
    })
  })

  test("parses EXPOSE, VOLUME, USER, WORKDIR, and STOPSIGNAL", () => {
    const parsed = ops(
      "FROM alpine\nEXPOSE 80 443/udp\nVOLUME /data\nUSER app\nWORKDIR /srv\nSTOPSIGNAL SIGINT\n",
    )
    expect(parsed).toEqual([
      { kind: "expose", ports: ["80", "443/udp"] },
      { kind: "volume", paths: ["/data"] },
      { kind: "user", user: "app" },
      { kind: "workdir", path: "/srv" },
      { kind: "stopsignal", signal: "SIGINT" },
    ])
  })

  test("SHELL must use the JSON form", () => {
    expect(ops('FROM alpine\nSHELL ["/bin/bash", "-c"]\n')[0]).toEqual({
      kind: "shell",
      shell: ["/bin/bash", "-c"],
    })
    expect(() => parseDockerfile("FROM alpine\nSHELL /bin/bash -c\n")).toThrow(/JSON form/)
  })

  test("parses HEALTHCHECK with durations, and NONE", () => {
    const op = ops(
      "FROM alpine\nHEALTHCHECK --interval=30s --retries=3 CMD curl -f http://localhost/\n",
    )[0]
    expect(op).toMatchObject({
      kind: "healthcheck",
      test: ["CMD-SHELL", "curl -f http://localhost/"],
      interval: 30_000_000_000,
      retries: 3,
    })
    expect(ops("FROM alpine\nHEALTHCHECK NONE\n")[0]).toEqual({ kind: "healthcheck", test: null })
  })
})

describe("ARG", () => {
  test("collects args declared before the first FROM as build args", () => {
    const plan = parseDockerfile("ARG VERSION=1.2.3\nFROM alpine\nRUN echo $VERSION\n")
    expect(plan.buildArgs).toEqual({ VERSION: "1.2.3" })
  })

  test("in-stage ARG becomes an op with its default", () => {
    expect(ops("FROM alpine\nARG TAG=dev\n")[0]).toEqual({
      kind: "arg",
      name: "TAG",
      defaultValue: "dev",
    })
    expect(ops("FROM alpine\nARG TAG\n")[0]).toEqual({ kind: "arg", name: "TAG" })
  })
})

describe("refusals", () => {
  test("ONBUILD and MAINTAINER are refused with a reason", () => {
    expect(() => parseDockerfile("FROM alpine\nONBUILD RUN echo hi\n")).toThrow(
      UnsupportedInstructionError,
    )
    expect(() => parseDockerfile("FROM alpine\nMAINTAINER me\n")).toThrow(
      /org.opencontainers.image.authors/,
    )
  })

  test("a custom BuildKit frontend is refused", () => {
    expect(() => parseDockerfile("# syntax=example.com/custom/frontend\nFROM alpine\n")).toThrow(
      /custom BuildKit frontends/,
    )
  })

  test("the standard syntax directive is accepted", () => {
    expect(() =>
      parseDockerfile("# syntax=docker/dockerfile:1\nFROM alpine\nRUN echo hi\n"),
    ).not.toThrow()
  })

  test("an unknown instruction names itself and its line", () => {
    try {
      parseDockerfile("FROM alpine\nFROMAGE brie\n")
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(DockerfileParseError)
      expect((error as DockerfileParseError).line).toBe(2)
      expect((error as DockerfileParseError).message).toMatch(/FROMAGE/)
    }
  })
})

describe("multi-stage", () => {
  test("splits stages and keeps their ops separate", () => {
    const plan = parseDockerfile(
      [
        "FROM node:22 AS builder",
        "WORKDIR /src",
        "COPY . .",
        "RUN npm run build",
        "",
        "FROM node:22-slim",
        "COPY --from=builder /src/dist /app",
        'CMD ["node", "/app/index.js"]',
      ].join("\n"),
    )

    expect(plan.stages).toHaveLength(2)
    expect(plan.stages[0]?.name).toBe("builder")
    expect(plan.stages[0]?.ops).toHaveLength(3)
    expect(plan.stages[1]?.ops[0]).toMatchObject({ kind: "copy", from: "builder" })
  })
})
