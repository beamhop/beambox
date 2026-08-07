# @beambox/dockerfile

Parse Dockerfiles into a typed build plan for the beambox engine.

Most people want [`beambox`](../beambox), which wires this to the builder and the CLI. Use
this package directly to inspect, lint, or transform Dockerfiles.

```bash
bun add @beambox/dockerfile
```

## Parsing

```ts
import { parseDockerfile } from "@beambox/dockerfile"

const plan = parseDockerfile(`
  FROM node:22 AS builder
  WORKDIR /src
  COPY . .
  RUN npm ci && npm run build

  FROM node:22-slim
  COPY --from=builder /src/dist /app
  CMD ["node", "/app/index.js"]
`)

plan.stages.length          // 2
plan.stages[0].name         // "builder"
plan.stages[1].ops[0]       // { kind: "copy", from: "builder", … }
```

The result is a `BuildPlan` from `@beambox/builder` — the same structure the TypeScript API
produces, so both go through one engine and behave identically.

## What is supported

`FROM` (including `AS`, `--platform`, and multi-stage), `RUN` (shell and exec form, with
`--mount=type=cache|bind|tmpfs`), `COPY` and `ADD` (`--from`, `--chown`, `--chmod`), `ENV`,
`ARG`, `LABEL`, `WORKDIR`, `USER`, `CMD`, `ENTRYPOINT`, `EXPOSE`, `VOLUME`, `STOPSIGNAL`,
`HEALTHCHECK`, and `SHELL`.

Plus the syntax that makes Dockerfiles awkward to parse: line continuations, comments
(including inside a continuation), the `# escape=` directive, heredocs, and quoted
arguments.

```ts
parseDockerfile(`
  # escape=\`
  FROM alpine
  RUN apk add --no-cache \`
      curl \`
      git
`)
```

```ts
// Heredoc bodies become the command.
parseDockerfile(`
  FROM alpine
  RUN <<EOF
  set -e
  echo building
  EOF
`)
```

## What is refused

Refusals name the instruction and the line. Nothing is silently skipped — an instruction
that quietly does nothing produces an image that looks right and behaves wrong.

```ts
import { UnsupportedInstructionError } from "@beambox/dockerfile"

try {
  parseDockerfile("FROM alpine\nONBUILD RUN echo hi\n")
} catch (error) {
  if (error instanceof UnsupportedInstructionError) {
    console.log(error.instruction) // "ONBUILD"
    console.log(error.line)        // 2
    console.log(error.reason)      // explains what to do instead
  }
}
```

Refused: `ONBUILD`, `MAINTAINER`, `RUN --mount=type=secret|ssh`, `RUN --network`,
`RUN --security`, and non-default BuildKit frontends (`# syntax=`).

## Parse errors

`DockerfileParseError` always carries a line number and the offending source.

```ts
parseDockerfile("FROM alpine builder\n")
// DockerfileParseError: Dockerfile line 1: FROM alpine builder — did you mean "AS builder"?
//   FROM alpine builder
```

## Lower-level pieces

The lexer is exported for tooling that wants logical lines without a full parse.

```ts
import { lex, parseExecForm, splitWords, takeFlags } from "@beambox/dockerfile"

const { lines, escape, syntax } = lex(source)
lines[0] // { instruction: "FROM", args: "alpine", line: 1, source, heredocs }

splitWords('COPY "my file.txt" /dest')  // ["COPY", "my file.txt", "/dest"]
takeFlags(["--from=builder", "a", "b"]) // { flags: Map { "from" => "builder" }, rest: ["a", "b"] }
parseExecForm('["node", "x.js"]')       // ["node", "x.js"]
parseExecForm("node x.js")              // undefined — shell form
```

## Note on `ARG` in `FROM`

`ARG`s declared before the first `FROM` become the plan's `buildArgs`. `FROM ${BASE}` is
expanded by the build engine rather than at parse time, so a `--build-arg` passed at build
time still overrides the Dockerfile's default.
