# Yenop policies

## Layers

Yenop evaluates every policy from every layer together. Cedar decides: any `forbid` wins, `permit`s add up.

| Layer | Who writes it | Where | Purpose |
|---|---|---|---|
| baseline | Yenop | shipped inside the package, never edited in place | sane defaults, improved with each release |
| home | you | `~/.yenop/policies/` | this machine, or this tenant when hosted |
| project | your team | `<project>/.yenop/policies/`, committed with the code | rules for one codebase |

To **tighten**, add a policy file to your layer. To **loosen** a baseline rule, do not edit the shipped file; switch the rule off by id in `~/.yenop/config.json` or `<project>/.yenop/config.json`:

```json
{ "disabledPolicies": ["no-pipe-to-shell"] }
```

Every policy carries an `@id("...")`. Ids must be unique across layers; a duplicate with different text is an error that names both files.

## Two folders, two questions

- `permit/` answers **"may this happen at all?"** Cedar's default is deny, so a tool call needs at least one `permit` and no `forbid`.
- `approve/` answers **"must a person see it first?"** A `permit` in this folder means *allowed but needs approval*. A `forbid` here exempts something from approval.

## What a policy can see

| Name | Meaning |
|---|---|
| `principal` | `Yenop::Agent::"<runtime>/<agent>"` with attrs `runtime`, `agent`, `user` |
| `action` | always `Yenop::Action::"call"` |
| `resource` | `Yenop::Tool::"<tool name>"` with attrs `name`, `kind` (read, write, shell, web, mcp, unknown), `readOnly`, `server` (MCP only) |
| `context.args` | the exact tool arguments, as a record |
| `context.run` | what the run has done before this call: `steps`, `denies`, `asks`, `outbound`, `destructive` (numbers) and the sticky flags `untrusted` (took in outside content) and `sensitive` (touched data that should not travel) |
| `context.flow` | what this call does, whichever tool does it: `ingestsUntrusted`, `readsSensitive`, `usesNetwork`, `externalNetwork`, `sendsOut`, `changesState` |
| `context.cwd` | the runtime's working directory |
| `context.derived.insideProject` | true when the file argument resolves inside `cwd` |
| `context.derived.absolutePath` | the resolved file argument |
| `context.derived.secretPath` | true when the file argument matches a secret-file pattern |
| `context.derived.controlPlanePath` | true when the file argument is one of Yenop's own files or a Claude Code settings file |
| `context.shell` | present for shell tools: `programs`, `ops`, `paths`, `envRefs`, `sql` (sets), `commandCount`, and the booleans `heredoc`, `sudo`, `pipesToShell`, `secretPath`, `secretEnv`, `network`, `outbound`, `destructive` |
| `context.call` | the call as an entity; every tool argument is a string tag: `context.call.hasTag("repo") && context.call.getTag("repo") == "acme/prod"` |

Test `context has shell` before using shell facts. The full vocabulary is `schema.cedarschema` next to this file; policies that do not match it are rejected at load with a message naming the attribute.

Sequence rules combine `context.run` with `context.flow`. Example, stricter than the baseline: refuse instead of asking when the whole exfiltration shape is present.

```
@id("no-way-out-after-untrusted-and-sensitive")
forbid (principal, action, resource)
when { context.run.untrusted && context.run.sensitive && context.flow.externalNetwork };
```

A denied call leaves no mark on the run. What counts as untrusted: web tools, downloads, and MCP reads from servers not listed in `trustedServers`. What counts as sensitive: database clients, secret managers, environment dumps, credential variables, secret files, files matching `sensitivePatterns`, and reads from `sensitiveServers`. Localhost and private ranges are never external.

Shell facts come from parsing, not text matching: `sudo`, `env`, `xargs`, `bash -c` and `$(...)` are followed; heredoc bodies and comments are ignored. `ops` holds canonical operations such as `git:push`, `git:--force`, `rm:-r`, `terraform:destroy`, `aws:ec2:terminate-instances`, so a customer rule can say `context.shell.ops.contains("kubectl:delete")`.

Evaluation errors never silently skip a policy: any error fails closed to deny.
