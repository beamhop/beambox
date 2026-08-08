# Agent guide

Coding agents reach for `docker build` because that is what the training data says. beambox
ships a skill that tells them otherwise, so an agent asked for "a microVM image" produces
one that `msb run` can actually start.

## 1. Install the skill

The skill lives in this repository and installs straight from it — [skills.sh](https://skills.sh)
resolves the repo, no registry in between:

```bash
npx skills add beamhop/beambox        # this project
npx skills add beamhop/beambox -g     # every project on this machine
```

It lands in `.claude/skills/beambox/` (or your agent's equivalent — Cursor, Copilot,
Windsurf, Gemini, Cline and others are supported targets). Project-scoped installs are
committed with the repo, so the whole team's agents behave the same.

Useful flags: `-a, --agent <agents…>` to target specific agents, `-l, --list` to see what a
repo offers before installing, `--copy` to copy files instead of symlinking.

## 2. What the agent gets

The skill is a single [`SKILL.md`](../skills/beambox/SKILL.md) with a `description` that
fires on the right requests — building, tagging, loading, archiving, or pushing an image,
a Dockerfile that needs building with no Docker available, anything ending in `msb run`.
Once loaded it covers:

- checking `beambox` and `msb`, and installing or `bunx`-ing when they are missing
- the CLI: building, the output flags, `--target`, `--build-arg`, `--platform`
- the TypeScript API: fluent specs, multi-stage, cache mounts, the Dockerfile front-end
- the instructions beambox **refuses** — so the agent rewrites the Dockerfile instead of
  burning turns working around a deliberate refusal
- the known limits, so it warns you before you hit them rather than after
- every typed error and what it means
- a final step that says: run `msb run` before claiming success, and if `msb` is missing,
  say the image was built but not executed

That last point matters more than the rest. The common agent failure here is not a wrong
flag, it is a confident "done" over an image nobody started.

## 3. Check it took

Ask the agent something that should trigger it:

> Build this Dockerfile into an image I can run with msb.

You should see it invoke the `beambox` skill and reach for `beambox build -t … .` rather
than `docker build`. In Claude Code, `/skills` lists what is installed.

## 4. Give it a runnable target

Agents verify better when verification is one command. A `package.json` script is enough:

```json
{
  "scripts": {
    "image": "beambox build -t my-app:local .",
    "image:run": "beambox build -t my-app:local . && msb run my-app:local"
  }
}
```

Then "make the image smaller and prove it still boots" is a loop the agent can close by
itself.

## 5. Pin the house rules

The skill describes beambox; it cannot know your conventions. Put those in `CLAUDE.md` (or
`AGENTS.md`) next to it:

```markdown
## Images

- Build with beambox, never Docker. Tag as `<service>:local` for local work.
- Every image must start under `msb run` before the change is considered done.
- Generated images belong in `infra/images/*.ts` using the beambox library API.
- Push only from CI, never from a laptop.
```

## 6. Give it the right permissions

An agent that has to ask before every build will not iterate. In Claude Code, allowlist the
commands it needs and nothing more — `beambox build`, `msb run`, and `msb ls` are read-only
enough to run unattended; leave `--push` needing approval, since that one leaves the
machine.

## 7. Building images *for* agents

The other direction is the interesting one: microsandbox is a good place to run
agent-generated code, and beambox is how you build the sandbox it runs in. A per-task image
is a few lines and no daemon:

```ts
import { image } from "@beamhop/beambox"

const sandbox = await image("python:3.12-slim")
  .run("pip install --no-cache-dir numpy pandas")
  .workdir("/work")
  .cmd(["python"])
  .build({ tags: [`agent-task-${taskId}:latest`] })

await sandbox.load()   // → msb run agent-task-<id>:latest
```

Because specs are immutable, one base spec can fan out into a per-task image without any
call reaching back and changing an earlier result — see the
[library guide](./library.md).

## Next

- The commands the skill teaches — the [CLI guide](./cli.md)
- The API the skill teaches — the [library guide](./library.md)
