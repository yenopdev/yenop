# Yenop default policy pack

Two folders, two questions.

- `permit/` answers **"may this happen at all?"** Cedar's default is deny, so a tool call needs at least one `permit` here and no `forbid`.
- `approve/` answers **"must a person see it first?"** A `permit` in this folder means the action is *allowed but needs approval*. A `forbid` here exempts something from approval.

What a policy can see:

| Name | Meaning |
|---|---|
| `principal` | `Yenop::Agent::"<runtime>/<agent>"` with attrs `runtime`, `agent`, `user` |
| `action` | always `Yenop::Action::"call"` |
| `resource` | `Yenop::Tool::"<tool name>"` with attrs `name`, `kind` (read, write, shell, web, mcp, unknown), `readOnly`, `server` (MCP only) |
| `context.args` | the exact tool arguments, as a record |
| `context.run.steps` | tool calls so far in this run, including this one |
| `context.cwd` | the runtime's working directory |
| `context.derived.insideProject` | true when the file argument resolves inside `cwd` |
| `context.derived.absolutePath` | the resolved file argument |

Every policy carries an `@id("...")` so receipts can name it. Evaluation errors never silently skip a policy: any error fails closed to deny.
